/**
 * Instruments I2 and I3 — end-to-end `memory.search` through
 * `MemoryService.searchWithAbstention`, narrow against widened.
 *
 * Usage (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/search-across-authorized-projects/measurements/scale-e2e.mjs \
 *     --db <corpusDir> --home <slug> --label <name> --json <outFile>
 *
 * I2 SHIPPED END-TO-END is `MemoryService` on the real repositories: exactly the
 * call a user waits on today, whose dense predicate is `partition_key = ?` and
 * whose lexical predicate is `project_id = ?`.
 *
 * I3 SHADOW END-TO-END is the same `MemoryService` and the same `hybridSearch`
 * — the real RRF, the real term statistics, the real relevance gate, the real
 * ranking boost, the real hydration — with exactly THREE repository reads
 * overlaid: `vectors.knnByQueryVector`, `memory.searchBm25Ids` and
 * `memory.textByIds`, each rewritten to the `IN (…)` form phase 4 will ship.
 * The overlays go through the same drizzle handle the repositories use, so an
 * arm differs from its neighbour in the predicate and in nothing else.
 *
 * It is a PROTOTYPE of the widening, not the widening: phase 4 has not been
 * written. Its one-project arm is therefore run as a control that must agree
 * with I2 on the returned ids at every magnitude — an overlay that returned
 * different rows would make every widened figure a measurement of a different
 * search. That control is asserted, and a mismatch exits non-zero.
 *
 * Arms are INTERLEAVED inside one process, in an order rotated per query, so no
 * arm can win by holding the page cache and none can be charged for a machine
 * that drifted between two runs measured hours apart
 * (`narrow-path-regression.md` §6, which binds every later comparison here).
 *
 * CAVEAT inherited from `seed-volumetric.ts`: the corpus vectors are
 * deterministic pseudo-random unit vectors, NOT embeddings, and the query
 * embedder below is of the same family. No retrieval-quality, ranking, fusion
 * or abstention claim may be drawn from a run of this harness. The claims it
 * supports are wall-clock, row counts and project-of-origin counts.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDb } from '../../../../apps/server/src/db/index.js';
import { createRepositories } from '../../../../apps/server/src/db/repositories/index.js';
import { computeRankWindowSize } from '../../../../apps/server/src/services/hybrid-search.js';
import {
  DEFAULT_SEARCH_LIMIT,
  MemoryService,
} from '../../../../apps/server/src/services/memory.js';
import { projectScope } from '../../../../apps/server/src/services/scope.js';

/**
 * The server's own drizzle, by path rather than by bare specifier: this file
 * sits outside every workspace package, so `'drizzle-orm'` does not resolve
 * from here. `db.all()` rejects a chunk that is not `instanceof` ITS `SQL`, so
 * a second copy would throw rather than silently measure a different builder.
 */
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

/** Same family as `generateVector`: a deterministic pseudo-random unit vector. */
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
  return Promise.resolve(v);
}

/**
 * Queries drawn from the corpus's own vocabulary across EVERY project, in a
 * fixed order, so neither the home project nor a foreign one can be vacuously
 * unmatched and the query set is identical on every arm and every run.
 */
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

/** Delegates everything not named; a bound method so `this` stays the repository. */
function overlay(target, overrides) {
  return new Proxy(target, {
    get(t, prop) {
      if (Object.prototype.hasOwnProperty.call(overrides, prop)) return overrides[prop];
      const v = Reflect.get(t, prop, t);
      return typeof v === 'function' ? v.bind(t) : v;
    },
  });
}

/**
 * The three reads phase 4 widens, in the `IN (…)` form D6 selects, built on the
 * same drizzle handle the repositories use so the only difference from the
 * shipped read is the predicate. `divideWindow` is task 2.8's second policy:
 * `k` applies per named partition, so an undivided window returns up to
 * `window × N` dense rows where the lexical branch's `LIMIT` stays a total.
 */
function widenedRepos(repos, db, projectIds, divideWindow) {
  const idSet = sql`(SELECT value FROM json_each(${JSON.stringify([...projectIds])}))`;
  const dense = {
    knnByQueryVector(opts) {
      const embedding = Buffer.from(
        opts.queryVector.buffer,
        opts.queryVector.byteOffset,
        opts.queryVector.byteLength,
      );
      const typeClause = opts.type ? sql`AND type = ${opts.type}` : sql``;
      const k = divideWindow
        ? Math.max(1, Math.ceil(opts.rankWindowSize / projectIds.length))
        : opts.rankWindowSize;
      return db.all(sql`
        SELECT memory_id AS id, distance
        FROM memory_vec
        WHERE embedding MATCH ${embedding}
          AND k = ${k}
          AND partition_key IN ${idSet}
          AND status = ${opts.status}
          ${typeClause}
        ORDER BY distance
      `);
    },
  };
  const lexical = {
    searchBm25Ids(opts) {
      const typeClause = opts.type ? sql`AND m.type = ${opts.type}` : sql``;
      const tagClause = opts.tag
        ? sql`AND EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value = ${opts.tag})`
        : sql``;
      const topicKeyClause = opts.topicKey ? sql`AND m.topic_key = ${opts.topicKey}` : sql``;
      const statusClause = opts.status
        ? sql`AND m.status = ${opts.status}`
        : sql`AND m.status != 'archived'`;
      return db.all(sql`
        SELECT m.id AS id, bm25(memory_fts, ${FTS_WEIGHTS[0]}, ${FTS_WEIGHTS[1]}, ${FTS_WEIGHTS[2]}) AS rank
        FROM memory_fts
          JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ${opts.matchExpr}
          AND m.scope = 'project' AND m.project_id IN ${idSet}
          ${statusClause}
          ${typeClause}
          ${tagClause}
          ${topicKeyClause}
        ORDER BY rank
        LIMIT ${opts.limit}
      `);
    },
    textByIds(opts) {
      if (opts.ids.length === 0) return [];
      return db.all(sql`
        SELECT m.id AS id, m.title AS title, m.content AS content
        FROM json_each(${JSON.stringify([...opts.ids])}) je
          CROSS JOIN memory m ON m.id = je.value
        WHERE m.scope = 'project' AND m.project_id IN ${idSet}
      `);
    },
  };
  return {
    ...repos,
    memory: overlay(repos.memory, lexical),
    vectors: overlay(repos.vectors, dense),
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
              (SELECT count(*) FROM memory m WHERE m.project_id = p.id) AS memories,
              (SELECT count(*) FROM memory_vec v WHERE v.partition_key = p.id) AS vectors
       FROM projects p ORDER BY memories DESC`,
    )
    .all();
  const home = projects.find((p) => p.slug === homeSlug);
  if (!home) throw new Error(`no project with slug ${homeSlug} in ${dataDir}`);

  // Home first, then the largest remaining projects: widening pays for the rows
  // it adds, so adding the biggest first is the pessimistic order.
  const ordered = [home, ...projects.filter((p) => p.id !== home.id)];
  const setOf = (n) => ordered.slice(0, n).map((p) => p.id);

  const repos = createRepositories(handle.db);
  const shipped = new MemoryService(repos, handle.db, () => new Date(), embedQuery);

  // The overlay's own cost, with the SHIPPED reads behind it. Without this arm
  // a small `shadow-1` − `shipped-narrow` gap cannot be told apart from the
  // Proxy, which allocates a bound method on every repository property access;
  // task 2.5 turns on a difference of a few percent, so the harness has to be
  // able to subtract itself.
  const passthrough = {
    ...repos,
    memory: overlay(repos.memory, {}),
    vectors: overlay(repos.vectors, {}),
  };

  const arms = [
    { name: 'shipped-narrow', projectIds: [home.id], service: shipped },
    {
      name: 'overlay-passthrough',
      projectIds: [home.id],
      service: new MemoryService(passthrough, handle.db, () => new Date(), embedQuery),
    },
  ];
  const widths = [1, 2, 4, projects.length].filter(
    (n, i, a) => n <= projects.length && a.indexOf(n) === i,
  );
  for (const n of widths) {
    for (const divide of n === 1 ? [false] : [false, true]) {
      const ids = setOf(n);
      arms.push({
        name: `shadow-${n === projects.length ? 'all' : n}${divide ? '-divided' : ''}`,
        projectIds: ids,
        divideWindow: divide,
        service: new MemoryService(
          widenedRepos(repos, handle.db, ids, divide),
          handle.db,
          () => new Date(),
          embedQuery,
        ),
      });
    }
  }

  const scope = projectScope(home.id);
  const queries = buildQueries(handle.raw, WARMUP_QUERIES + TIMED_QUERIES);
  if (queries.length < WARMUP_QUERIES + TIMED_QUERIES) {
    throw new Error(`built ${queries.length} queries, need ${WARMUP_QUERIES + TIMED_QUERIES}`);
  }

  for (const arm of arms) {
    arm.samples = [];
    arm.rowCounts = [];
    arm.foreignRows = 0;
    arm.projectsSeen = new Set();
    arm.ids = [];
    for (let i = 0; i < WARMUP_QUERIES; i += 1) {
      await arm.service.searchWithAbstention({ query: queries[i] }, scope);
    }
  }

  for (let i = 0; i < TIMED_QUERIES; i += 1) {
    const query = queries[WARMUP_QUERIES + i];
    // Rotated so no arm systematically runs first on a query.
    for (let a = 0; a < arms.length; a += 1) {
      const arm = arms[(a + i) % arms.length];
      const t0 = process.hrtime.bigint();
      const result = await arm.service.searchWithAbstention({ query }, scope);
      const t1 = process.hrtime.bigint();
      arm.samples.push(Number(t1 - t0) / 1e6);
      arm.rowCounts.push(result.memories.length);
      for (const m of result.memories) {
        arm.projectsSeen.add(m.projectId);
        if (m.projectId !== home.id) arm.foreignRows += 1;
      }
      arm.ids.push(result.memories.map((m) => m.id).join(','));
    }
  }

  const report = {
    instruments: {
      I2: 'SHIPPED END-TO-END (MemoryService on the real repositories)',
      I3: 'SHADOW END-TO-END (same service, three reads overlaid with IN (…))',
    },
    label,
    dataDir,
    home: { slug: home.slug, id: home.id, memories: home.memories, vectors: home.vectors },
    projects: projects.map((p) => ({ slug: p.slug, memories: p.memories, vectors: p.vectors })),
    corpusMemories: projects.reduce((n, p) => n + p.memories, 0),
    warmupQueries: WARMUP_QUERIES,
    timedQueries: TIMED_QUERIES,
    node: process.version,
    arms: arms.map((arm) => {
      const sorted = [...arm.samples].sort((a, b) => a - b);
      return {
        name: arm.name,
        projects: arm.projectIds.length,
        divideWindow: arm.divideWindow ?? false,
        p50Ms: round(percentile(sorted, 50)),
        p90Ms: round(percentile(sorted, 90)),
        minMs: round(sorted[0]),
        maxMs: round(sorted[sorted.length - 1]),
        rowsReturnedTotal: arm.rowCounts.reduce((a, b) => a + b, 0),
        rowsReturnedMin: Math.min(...arm.rowCounts),
        queriesReturningZeroRows: arm.rowCounts.filter((n) => n === 0).length,
        distinctProjectsInResults: arm.projectsSeen.size,
        foreignScopeRows: arm.foreignRows,
        samplesMs: arm.samples.map(round),
      };
    }),
  };

  // Untimed, so it cannot perturb the table above. `k` applies per named
  // partition, so the two window policies differ in the dense pool they hand to
  // fusion, and that composition — not the page — is the structural quantity
  // task 2.8 turns on.
  const RANK_WINDOW = computeRankWindowSize(DEFAULT_SEARCH_LIMIT, 0);
  const composition = handle.db;
  report.densePoolComposition = [];
  for (const arm of arms) {
    if (arm.name === 'shipped-narrow' || arm.name === 'overlay-passthrough') continue;
    const ids = arm.projectIds;
    const k = arm.divideWindow ? Math.max(1, Math.ceil(RANK_WINDOW / ids.length)) : RANK_WINDOW;
    const byProject = new Map();
    let total = 0;
    for (let i = 0; i < TIMED_QUERIES; i += 1) {
      const v = await embedQuery(queries[WARMUP_QUERIES + i]);
      const rows = composition.all(sql`
        SELECT partition_key AS p, count(*) AS n
        FROM (
          SELECT partition_key
          FROM memory_vec
          WHERE embedding MATCH ${Buffer.from(v.buffer, v.byteOffset, v.byteLength)}
            AND k = ${k}
            AND partition_key IN (SELECT value FROM json_each(${JSON.stringify([...ids])}))
            AND status = 'active'
          ORDER BY distance
        ) GROUP BY p
      `);
      for (const r of rows) {
        byProject.set(r.p, (byProject.get(r.p) ?? 0) + r.n);
        total += r.n;
      }
    }
    const slugById = new Map(projects.map((p) => [p.id, p.slug]));
    report.densePoolComposition.push({
      arm: arm.name,
      kPerPartition: k,
      candidatesPerQuery: round(total / TIMED_QUERIES),
      homeShare: round((byProject.get(home.id) ?? 0) / Math.max(1, total)),
      perProjectPerQuery: [...byProject.entries()]
        .map(([id, n]) => [slugById.get(id) ?? id, round(n / TIMED_QUERIES)])
        .sort((a, b) => b[1] - a[1]),
    });
  }

  const narrow = arms[0];
  const shadowOne = arms.find((a) => a.name === 'shadow-1');
  const pass = arms.find((a) => a.name === 'overlay-passthrough');
  report.singleElementInControl = {
    idsIdentical: narrow.ids.join('|') === shadowOne.ids.join('|'),
    passthroughIdsIdentical: narrow.ids.join('|') === pass.ids.join('|'),
    comparedQueries: narrow.ids.length,
    nonEmptyPages: narrow.ids.filter((s) => s.length > 0).length,
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out) writeFileSync(out, json);
  process.stdout.write(json);

  const problems = [];
  if (!report.singleElementInControl.idsIdentical) {
    problems.push('the single-element IN overlay returned different ids from the shipped read');
  }
  if (!report.singleElementInControl.passthroughIdsIdentical) {
    problems.push('the pass-through overlay returned different ids from the shipped read');
  }
  if (report.singleElementInControl.nonEmptyPages !== TIMED_QUERIES) {
    problems.push('the id control compared an empty page');
  }
  for (const a of report.arms) {
    if (a.rowsReturnedMin === 0) problems.push(`${a.name}: a query returned zero rows`);
    if (a.projects === 1 && a.foreignScopeRows > 0)
      problems.push(`${a.name}: leaked a foreign row`);
    if (a.projects > 1 && a.distinctProjectsInResults < 2) {
      problems.push(`${a.name}: widened but every returned row came from one project`);
    }
  }
  if (problems.length > 0) {
    console.error(`[scale-e2e] VACUOUS OR WRONG:\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
} finally {
  handle.close();
}
