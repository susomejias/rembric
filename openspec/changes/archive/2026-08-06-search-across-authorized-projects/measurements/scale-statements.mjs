/**
 * Instrument I1 ISOLATED STATEMENT — one prepared statement against the real
 * corpus on disk, for the two branches a widened `memory.search` rewrites: the
 * sqlite-vec kNN over `memory_vec`, and the FTS5/BM25 read over `memory_fts`.
 *
 * Usage (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/search-across-authorized-projects/measurements/scale-statements.mjs \
 *     --db <corpusDir> --home <slug> --label <name> --json <outFile>
 *
 * NOT an end-to-end latency. `CLAUDE.md` forbids presenting a figure from here
 * beside one from `scale-e2e.mjs` (I2/I3) in the same table, and the document
 * keeps them apart.
 *
 * Every arm is the SHIPPED statement with its scope predicate swapped, built
 * through the same drizzle handle the repositories use, so two arms differ in
 * the predicate and in nothing else — which is the whole question for the
 * single-element arms, since `EXPLAIN QUERY PLAN` prints the identical opaque
 * vtable index string for `= ?` and for `IN (…)`
 * (`vec-partition-capability.md` §4).
 *
 * Arms are interleaved per query and the order is rotated, so no arm can win by
 * arriving with the page cache already holding its shard.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDb } from '../../../../apps/server/src/db/index.js';
import { computeRankWindowSize } from '../../../../apps/server/src/services/hybrid-search.js';
import { DEFAULT_SEARCH_LIMIT } from '../../../../apps/server/src/services/memory.js';

const { sql } = await import(
  join(
    dirname(fileURLToPath(import.meta.url)),
    '../../../../apps/server/node_modules/drizzle-orm/index.js',
  )
);

const WARMUP_QUERIES = 5;
const TIMED_QUERIES = 40;
const EMBEDDING_DIMS = 768;
/** `bm25(memory_fts, …)` weights, verbatim from `memory-repository.ts`. */
const FTS_WEIGHTS = [1.0, 1.0, 2.0];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) {
    if (fallback === undefined) {
      console.error(`missing --${name}`);
      process.exit(2);
    }
    return fallback;
  }
  return process.argv[i + 1];
}

function splitmix32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

function hashString(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function embedQuery(text) {
  const rng = splitmix32(hashString(text));
  const v = new Float32Array(EMBEDDING_DIMS);
  let norm = 0;
  for (let i = 0; i < v.length; i += 1) {
    const x = rng() * 2 - 1;
    v[i] = x;
    norm += x * x;
  }
  const inv = 1 / Math.sqrt(norm);
  for (let i = 0; i < v.length; i += 1) v[i] *= inv;
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function buildQueries(raw, count) {
  const titles = raw
    .prepare(`SELECT title FROM memory ORDER BY id LIMIT ?`)
    .all(count * 4)
    .map((r) => r.title);
  const words = [];
  for (const title of titles) for (const w of title.split(' ').slice(2)) if (w) words.push(w);
  const unique = [...new Set(words)];
  const queries = [];
  for (let i = 0; i < count; i += 1) {
    queries.push(
      [
        unique[(i * 3) % unique.length],
        unique[(i * 3 + 1) % unique.length],
        unique[(i * 3 + 2) % unique.length],
      ]
        .filter(Boolean)
        .join(' '),
    );
  }
  return queries;
}

function percentile(sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const round = (n) => Math.round(n * 1000) / 1000;

function reduce(arm) {
  const sorted = [...arm.samples].sort((a, b) => a - b);
  return {
    name: arm.name,
    projects: arm.projects,
    p50Ms: round(percentile(sorted, 50)),
    p90Ms: round(percentile(sorted, 90)),
    minMs: round(sorted[0]),
    maxMs: round(sorted[sorted.length - 1]),
    rowsTotal: arm.rows,
    rowsMin: arm.rowsMin,
    distinctPartitions: arm.partitions.size,
  };
}

const dataDir = arg('db');
const homeSlug = arg('home');
const label = arg('label', 'unlabelled');
const out = arg('json', '');

const handle = createDb({ dataDir, readonly: true });
try {
  const projects = handle.raw
    .prepare(
      `SELECT p.id AS id, p.slug AS slug,
              (SELECT count(*) FROM memory m WHERE m.project_id = p.id) AS memories
       FROM projects p ORDER BY memories DESC`,
    )
    .all();
  const home = projects.find((p) => p.slug === homeSlug);
  if (!home) throw new Error(`no project with slug ${homeSlug} in ${dataDir}`);
  const ordered = [home, ...projects.filter((p) => p.id !== home.id)];
  const setOf = (n) => ordered.slice(0, n).map((p) => p.id);
  const widths = [1, 2, 4, projects.length].filter((n, i, a) => a.indexOf(n) === i);

  const db = handle.db;
  const k = computeRankWindowSize(DEFAULT_SEARCH_LIMIT, 0);
  const jsonSet = (ids) => sql`(SELECT value FROM json_each(${JSON.stringify(ids)}))`;
  const boundSet = (ids) =>
    sql`(${sql.join(
      ids.map((i) => sql`${i}`),
      sql`, `,
    )})`;

  const denseArms = [
    {
      name: 'dense eq (shipped)',
      projects: 1,
      run: (v) =>
        db.all(sql`
        SELECT memory_id AS id, partition_key AS p FROM memory_vec
        WHERE embedding MATCH ${v} AND k = ${k} AND partition_key = ${home.id}
          AND status = 'active' ORDER BY distance`),
    },
    {
      name: 'dense IN(1) bound',
      projects: 1,
      run: (v) =>
        db.all(sql`
        SELECT memory_id AS id, partition_key AS p FROM memory_vec
        WHERE embedding MATCH ${v} AND k = ${k} AND partition_key IN ${boundSet([home.id])}
          AND status = 'active' ORDER BY distance`),
    },
    {
      name: 'dense IN(1) literal',
      projects: 1,
      run: (v) =>
        db.all(sql`
        SELECT memory_id AS id, partition_key AS p FROM memory_vec
        WHERE embedding MATCH ${v} AND k = ${k} AND partition_key IN (${sql.raw(`'${home.id}'`)})
          AND status = 'active' ORDER BY distance`),
    },
    {
      name: 'dense IN(1) json_each',
      projects: 1,
      run: (v) =>
        db.all(sql`
        SELECT memory_id AS id, partition_key AS p FROM memory_vec
        WHERE embedding MATCH ${v} AND k = ${k} AND partition_key IN ${jsonSet([home.id])}
          AND status = 'active' ORDER BY distance`),
    },
  ];
  for (const n of widths.filter((n) => n > 1)) {
    const ids = setOf(n);
    denseArms.push({
      name: `dense IN(${n}) bound`,
      projects: n,
      run: (v) =>
        db.all(sql`
        SELECT memory_id AS id, partition_key AS p FROM memory_vec
        WHERE embedding MATCH ${v} AND k = ${k} AND partition_key IN ${boundSet(ids)}
          AND status = 'active' ORDER BY distance`),
    });
    denseArms.push({
      name: `dense IN(${n}) json_each`,
      projects: n,
      run: (v) =>
        db.all(sql`
        SELECT memory_id AS id, partition_key AS p FROM memory_vec
        WHERE embedding MATCH ${v} AND k = ${k} AND partition_key IN ${jsonSet(ids)}
          AND status = 'active' ORDER BY distance`),
    });
  }

  const bm25 = sql`bm25(memory_fts, ${FTS_WEIGHTS[0]}, ${FTS_WEIGHTS[1]}, ${FTS_WEIGHTS[2]})`;
  const lexicalArms = [
    {
      name: 'lexical eq (shipped)',
      projects: 1,
      run: (_v, m) =>
        db.all(sql`
        SELECT m.id AS id, m.project_id AS p, ${bm25} AS rank
        FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ${m} AND m.scope = 'project' AND m.project_id = ${home.id}
          AND m.status = 'active' ORDER BY rank LIMIT ${k}`),
    },
  ];
  for (const n of widths) {
    const ids = setOf(n);
    lexicalArms.push({
      name: `lexical IN(${n}) json_each`,
      projects: n,
      run: (_v, m) =>
        db.all(sql`
        SELECT m.id AS id, m.project_id AS p, ${bm25} AS rank
        FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ${m} AND m.scope = 'project' AND m.project_id IN ${jsonSet(ids)}
          AND m.status = 'active' ORDER BY rank LIMIT ${k}`),
    });
  }

  // The third scoped read on the ranked path, and the one an end-to-end
  // comparison cannot attribute without it: `hybridSearch` calls it once per
  // query over the whole fused pool.
  const textArms = [
    {
      name: 'textByIds eq (shipped)',
      projects: 1,
      run: (_v, _m, ids) =>
        db.all(sql`
        SELECT m.id AS id, m.project_id AS p, m.title AS title, m.content AS content
        FROM json_each(${JSON.stringify(ids)}) je CROSS JOIN memory m ON m.id = je.value
        WHERE m.scope = 'project' AND m.project_id = ${home.id}`),
    },
    {
      name: 'textByIds IN(1) json_each',
      projects: 1,
      run: (_v, _m, ids) =>
        db.all(sql`
        SELECT m.id AS id, m.project_id AS p, m.title AS title, m.content AS content
        FROM json_each(${JSON.stringify(ids)}) je CROSS JOIN memory m ON m.id = je.value
        WHERE m.scope = 'project' AND m.project_id IN ${jsonSet([home.id])}`),
    },
    {
      name: `textByIds IN(${projects.length}) json_each`,
      projects: projects.length,
      run: (_v, _m, ids) =>
        db.all(sql`
        SELECT m.id AS id, m.project_id AS p, m.title AS title, m.content AS content
        FROM json_each(${JSON.stringify(ids)}) je CROSS JOIN memory m ON m.id = je.value
        WHERE m.scope = 'project' AND m.project_id IN ${jsonSet(setOf(projects.length))}`),
    },
  ];

  const arms = [...denseArms, ...lexicalArms, ...textArms];
  for (const arm of arms) {
    arm.samples = [];
    arm.rows = 0;
    arm.rowsMin = Infinity;
    arm.partitions = new Set();
  }

  const queries = buildQueries(handle.raw, WARMUP_QUERIES + TIMED_QUERIES);
  const vectors = queries.map(embedQuery);
  const matches = queries.map((q) =>
    q
      .split(' ')
      .map((w) => `"${w}"`)
      .join(' OR '),
  );

  // The pool `textByIds` is really called with: the home partition's own kNN
  // result for that query. Read once, outside every timed section.
  const pools = vectors.map((v) => denseArms[0].run(v).map((r) => r.id));

  for (let i = 0; i < WARMUP_QUERIES; i += 1) {
    for (const arm of arms) arm.run(vectors[i], matches[i], pools[i]);
  }

  for (let i = 0; i < TIMED_QUERIES; i += 1) {
    const v = vectors[WARMUP_QUERIES + i];
    const m = matches[WARMUP_QUERIES + i];
    const pool = pools[WARMUP_QUERIES + i];
    for (let a = 0; a < arms.length; a += 1) {
      const arm = arms[(a + i) % arms.length];
      const t0 = process.hrtime.bigint();
      const rows = arm.run(v, m, pool);
      const t1 = process.hrtime.bigint();
      arm.samples.push(Number(t1 - t0) / 1e6);
      arm.rows += rows.length;
      arm.rowsMin = Math.min(arm.rowsMin, rows.length);
      for (const r of rows) arm.partitions.add(r.p);
    }
  }

  const eqp = (label, run) => ({
    arm: label,
    plan: run().map((r) => r.detail),
  });
  const probeVector = vectors[0];
  const plans = [
    eqp('dense eq', () =>
      db.all(sql`EXPLAIN QUERY PLAN SELECT memory_id FROM memory_vec
        WHERE embedding MATCH ${probeVector} AND k = ${k} AND partition_key = ${home.id}
          AND status = 'active' ORDER BY distance`),
    ),
    eqp('dense IN(1) bound', () =>
      db.all(sql`EXPLAIN QUERY PLAN SELECT memory_id FROM memory_vec
        WHERE embedding MATCH ${probeVector} AND k = ${k} AND partition_key IN ${boundSet([home.id])}
          AND status = 'active' ORDER BY distance`),
    ),
    eqp('lexical eq', () =>
      db.all(sql`EXPLAIN QUERY PLAN SELECT m.id FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ${matches[0]} AND m.scope = 'project' AND m.project_id = ${home.id}
          AND m.status = 'active' ORDER BY rank LIMIT ${k}`),
    ),
    eqp('lexical IN(all) json_each', () =>
      db.all(sql`EXPLAIN QUERY PLAN SELECT m.id FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ${matches[0]} AND m.scope = 'project'
          AND m.project_id IN ${jsonSet(setOf(projects.length))}
          AND m.status = 'active' ORDER BY rank LIMIT ${k}`),
    ),
  ];

  const report = {
    instrument: 'I1 ISOLATED STATEMENT (prepared statement against the corpus on disk)',
    label,
    dataDir,
    home: { slug: home.slug, id: home.id, memories: home.memories },
    projects: projects.map((p) => ({ slug: p.slug, memories: p.memories })),
    corpusMemories: projects.reduce((n, p) => n + p.memories, 0),
    rankWindowSize: k,
    warmupQueries: WARMUP_QUERIES,
    timedQueries: TIMED_QUERIES,
    node: process.version,
    dense: denseArms.map(reduce),
    lexical: lexicalArms.map(reduce),
    textByIds: textArms.map(reduce),
    plans,
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out) writeFileSync(out, json);
  process.stdout.write(json);

  const problems = [];
  for (const a of [...report.dense, ...report.lexical]) {
    if (a.rowsMin === 0) problems.push(`${a.name}: a query returned zero rows`);
    if (a.projects === 1 && a.distinctPartitions !== 1) {
      problems.push(`${a.name}: narrow arm crossed a partition`);
    }
    if (a.projects > 1 && a.distinctPartitions < 2) {
      problems.push(`${a.name}: widened arm read only one partition`);
    }
  }
  // Its pool is the home partition's own kNN, so every arm — widened included —
  // must return exactly the same rows from exactly one project. An arm that
  // did not would be timing a different read.
  for (const a of report.textByIds) {
    if (a.rowsMin === 0) problems.push(`${a.name}: a query returned zero rows`);
    if (a.distinctPartitions !== 1) problems.push(`${a.name}: crossed a project`);
    if (a.rowsTotal !== report.textByIds[0].rowsTotal) {
      problems.push(`${a.name}: returned a different row count from the shipped form`);
    }
  }
  if (problems.length > 0) {
    console.error(`[scale-statements] VACUOUS OR WRONG:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
} finally {
  handle.close();
}
