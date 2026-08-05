/**
 * Instrument I2 END-TO-END — `memory.search` latency through
 * `MemoryService.searchWithAbstention`, for the ORDINARY single-project search.
 *
 * Usage (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/search-across-authorized-projects/measurements/narrow-path-e2e.mjs \
 *     --db <corpusDir> --project <slug> --label <name> --json <outFile>
 *
 * This is the phase-0 baseline harness. It measures what a user waits on: one
 * `searchWithAbstention` call, which pays the query embedding, the FTS branch,
 * the sqlite-vec kNN branch, RRF fusion, term statistics, the relevance gate,
 * the ranking boost, the diversity cap and the row hydration. It is NOT
 * `knnByQueryVector`, and no figure it produces may be quoted beside an
 * isolated-statement figure (CLAUDE.md, "One instrument per series, named").
 *
 * The corpus is opened READ-ONLY, so three repeats of the same magnitude read
 * the same bytes and the same `sqlite_stat1` the build left behind. Consequence
 * to state rather than hide: `createDb` skips `migrate()` and its boot-time
 * `ANALYZE` on a read-only handle. Neither is on the query path; the read-path
 * tuning pragmas (`cache_size`, `mmap_size`, `temp_store`) are applied either way.
 *
 * CAVEAT inherited from `seed-volumetric.ts`: the corpus vectors are
 * deterministic pseudo-random unit vectors, NOT embeddings, and the query
 * embedder below is of the same family. No retrieval-quality, ranking, fusion
 * or abstention claim may be drawn from a run of this harness. The claims it
 * supports are wall-clock and row counts, neither of which depends on vector
 * semantics.
 */
import { writeFileSync } from 'node:fs';

import { createDb } from '../../../../apps/server/src/db/index.js';
import { createRepositories } from '../../../../apps/server/src/db/repositories/index.js';
import { MemoryService } from '../../../../apps/server/src/services/memory.js';
import { projectScope } from '../../../../apps/server/src/services/scope.js';

/** Discarded, so the page cache, the prepared statements and the JIT are warm. */
const WARMUP_QUERIES = 5;
/** Timed queries per process run. Matches the vec-partition harness's 40. */
const TIMED_QUERIES = 40;
const EMBEDDING_DIMS = 768;

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
 * Queries drawn from the corpus's own vocabulary, in a fixed `id` order, so the
 * lexical branch cannot be vacuously empty and the query set is identical on
 * every run and on every side of the change.
 */
function buildQueries(raw, projectId, count) {
  const titles = raw
    .prepare(`SELECT title FROM memory WHERE project_id = ? ORDER BY id LIMIT ?`)
    .all(projectId, count * 4)
    .map((r) => r.title);
  const words = [];
  for (const title of titles) {
    // `volumetric <index> <word> <word>`
    for (const w of title.split(' ').slice(2)) if (w) words.push(w);
  }
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
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

const dataDir = arg('db');
const slug = arg('project');
const label = arg('label', 'unlabelled');
const out = arg('json', '');

const handle = createDb({ dataDir, readonly: true });
try {
  const project = handle.raw.prepare(`SELECT id, slug FROM projects WHERE slug = ?`).get(slug);
  if (!project) throw new Error(`no project with slug ${slug} in ${dataDir}`);

  // Non-vacuity census, read before anything is timed: a latency comparison
  // over two empty result sets proves nothing.
  const census = {
    memoriesTotal: handle.raw.prepare(`SELECT count(*) AS n FROM memory`).get().n,
    memoriesInProject: handle.raw
      .prepare(`SELECT count(*) AS n FROM memory WHERE project_id = ?`)
      .get(project.id).n,
    activeInProject: handle.raw
      .prepare(`SELECT count(*) AS n FROM memory WHERE project_id = ? AND status = 'active'`)
      .get(project.id).n,
    vectorsInPartition: handle.raw
      .prepare(`SELECT count(*) AS n FROM memory_vec WHERE partition_key = ?`)
      .get(project.id).n,
    projects: handle.raw.prepare(`SELECT count(*) AS n FROM projects`).get().n,
  };

  const repos = createRepositories(handle.db);
  const service = new MemoryService(repos, handle.db, () => new Date(), embedQuery);
  const scope = projectScope(project.id);

  const queries = buildQueries(handle.raw, project.id, WARMUP_QUERIES + TIMED_QUERIES);
  if (queries.length < WARMUP_QUERIES + TIMED_QUERIES) {
    throw new Error(`built ${queries.length} queries, need ${WARMUP_QUERIES + TIMED_QUERIES}`);
  }

  for (let i = 0; i < WARMUP_QUERIES; i += 1) {
    await service.searchWithAbstention({ query: queries[i] }, scope);
  }

  const samples = [];
  const rowCounts = [];
  let abstained = 0;
  let foreignRows = 0;
  for (let i = 0; i < TIMED_QUERIES; i += 1) {
    const query = queries[WARMUP_QUERIES + i];
    const t0 = process.hrtime.bigint();
    const result = await service.searchWithAbstention({ query }, scope);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
    rowCounts.push(result.memories.length);
    if (result.abstained) abstained += 1;
    for (const m of result.memories) if (m.projectId !== project.id) foreignRows += 1;
  }

  const sorted = [...samples].sort((a, b) => a - b);
  const report = {
    instrument: 'I2 END-TO-END (MemoryService.searchWithAbstention)',
    label,
    dataDir,
    project: { slug: project.slug, id: project.id },
    census,
    warmupQueries: WARMUP_QUERIES,
    timedQueries: TIMED_QUERIES,
    p50Ms: Math.round(percentile(sorted, 50) * 1000) / 1000,
    p90Ms: Math.round(percentile(sorted, 90) * 1000) / 1000,
    minMs: Math.round(sorted[0] * 1000) / 1000,
    maxMs: Math.round(sorted[sorted.length - 1] * 1000) / 1000,
    rowsReturnedTotal: rowCounts.reduce((a, b) => a + b, 0),
    rowsReturnedMin: Math.min(...rowCounts),
    queriesReturningZeroRows: rowCounts.filter((n) => n === 0).length,
    abstainedQueries: abstained,
    foreignScopeRows: foreignRows,
    node: process.version,
    samplesMs: samples.map((s) => Math.round(s * 1000) / 1000),
  };

  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (out) writeFileSync(out, json);
  process.stdout.write(json);

  // The harness fails rather than reporting a vacuous comparison.
  if (report.rowsReturnedMin === 0 || report.foreignScopeRows > 0) {
    console.error(
      `[narrow-path-e2e] VACUOUS OR LEAKING: rowsReturnedMin=${report.rowsReturnedMin} ` +
        `foreignScopeRows=${report.foreignScopeRows}`,
    );
    process.exit(1);
  }
} finally {
  handle.close();
}
