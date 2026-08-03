/**
 * Task 10.5.4 — the price of making the ROW-MEMBERSHIP half index-authoritative,
 * re-taken against the real migrated schema. The asymmetry the amendment ships is
 * accepted on these numbers, so they are re-measured rather than carried over.
 *
 * Run (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/weight-relevance-levels-by-idf/measurements/row-side-price.mjs
 *
 * Instrument: time to decide, for ONE query's terms, which of a POOL of candidate
 * rows contains each term — the operation `weightedCoverage` performs per search.
 * 60 queries per cell, p50, one warm process, 50 000-row corpus from
 * `seed-volumetric`'s `buildCorpus`. Pool sizes are the shipped rank windows.
 *
 * Budget: 1.0 ms marginal over the shipped JS arm. If any index-authoritative
 * variant lands under it, design.md D3b must be revisited.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb } from '../../../../apps/server/src/db/index.js';
import { inheritedFts5Arguments } from '../../../../apps/server/src/db/query-tokenizer.js';
import { createRepositories } from '../../../../apps/server/src/db/repositories/index.js';
import { buildCorpus, DEFAULT_ARGS } from '../../../../apps/server/src/scripts/seed-volumetric.js';
import { tokenSet } from '../../../../apps/server/src/services/hybrid-search.js';

const POOLS = [64, 200, 400];
const ITERATIONS = 60;
const CORPUS_ROWS = 50_000;

const QUERIES = [
  'cache candidate migration',
  'why does the consolidation sweep archive a decayed memory ledger',
  'relation pending judgment orphaned deadline',
  'partition pointer prefix projection quorum ratio reader rebuild recipe',
  'gate growth handler header hidden however index inline instrument invariant',
  'evidence expected explicit failure filter floor',
  'boundary branch budget cache candidate ceiling chain checked client column',
];

const p50 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pad = (s, w) => String(s).padEnd(w);

const dir = mkdtempSync(join(tmpdir(), 'rembric-rowside-'));
const handle = createDb({ dataDir: dir });
buildCorpus({
  handle,
  args: { ...DEFAULT_ARGS, dataDir: dir, memories: CORPUS_ROWS },
  log: () => {},
});
const repos = createRepositories(handle.db);
const raw = handle.raw;

const declaration = raw
  .prepare(`SELECT sql FROM sqlite_master WHERE name = 'memory_fts'`)
  .get().sql;
const inherited = inheritedFts5Arguments(declaration);
raw.exec(`CREATE VIRTUAL TABLE temp.pool_idx USING fts5(${['body', ...inherited].join(', ')})`);
raw.exec(`CREATE VIRTUAL TABLE temp.pool_inst USING fts5vocab('pool_idx','instance')`);
raw.exec(`CREATE VIRTUAL TABLE temp.warm_idx USING fts5(${['body', ...inherited].join(', ')})`);
raw.exec(`CREATE VIRTUAL TABLE temp.warm_inst USING fts5vocab('warm_idx','instance')`);

const rows = raw
  .prepare(
    `SELECT rowid, id, title, content FROM memory WHERE status = 'active' ORDER BY rowid LIMIT ?`,
  )
  .all(Math.max(...POOLS));

const insertPool = raw.prepare('INSERT INTO temp.pool_idx(rowid, body) VALUES (?, ?)');
const insertWarm = raw.prepare('INSERT INTO temp.warm_idx(rowid, body) VALUES (?, ?)');
const clearPool = () => raw.exec(`DELETE FROM temp.pool_idx`);
const matchPool = raw.prepare(`SELECT rowid FROM temp.pool_idx WHERE pool_idx MATCH ?`);
const instancePool = raw.prepare(
  `SELECT DISTINCT doc, term FROM temp.pool_inst WHERE term IN (SELECT value FROM json_each(?))`,
);
const instanceWarm = raw.prepare(
  `SELECT DISTINCT doc, term FROM temp.warm_inst WHERE term IN (SELECT value FROM json_each(?)) AND doc IN (SELECT value FROM json_each(?))`,
);
const matchGlobal = raw.prepare(
  `SELECT rowid FROM memory_fts WHERE memory_fts MATCH ? AND rowid IN (SELECT value FROM json_each(?))`,
);

// The warm variant's index is pre-populated with every pool row, which is the
// most favourable case for it: content is immutable, so a row is indexed once.
for (const r of rows) insertWarm.run(r.rowid, `${r.title}\n\n${r.content}`);

/** Query terms as the index reports them, the amendment's own read. */
const termsOf = (text) => [...repos.termStatistics.adminQueryTermFrequencies(text).keys()];

const VARIANTS = {
  'JS indexTerms over the pool — today': (pool, terms) => {
    const covered = new Map();
    for (const r of pool) {
      const set = tokenSet(`${r.title}\n\n${r.content}`);
      covered.set(
        r.rowid,
        terms.filter((t) => set.has(t)),
      );
    }
    return covered;
  },
  'pool insert + per-term MATCH': (pool, terms) => {
    clearPool();
    for (const r of pool) insertPool.run(r.rowid, `${r.title}\n\n${r.content}`);
    const covered = new Map();
    for (const t of terms) {
      for (const hit of matchPool.all(`"${t}"`)) {
        const list = covered.get(hit.rowid) ?? [];
        list.push(t);
        covered.set(hit.rowid, list);
      }
    }
    return covered;
  },
  'pool insert + filtered instance read': (pool, terms) => {
    clearPool();
    for (const r of pool) insertPool.run(r.rowid, `${r.title}\n\n${r.content}`);
    const covered = new Map();
    for (const hit of instancePool.all(JSON.stringify(terms))) {
      const list = covered.get(hit.doc) ?? [];
      list.push(hit.term);
      covered.set(hit.doc, list);
    }
    return covered;
  },
  'cached by memory id, warm instance read': (pool, terms) => {
    const covered = new Map();
    for (const hit of instanceWarm.all(
      JSON.stringify(terms),
      JSON.stringify(pool.map((r) => r.rowid)),
    )) {
      const list = covered.get(hit.doc) ?? [];
      list.push(hit.term);
      covered.set(hit.doc, list);
    }
    return covered;
  },
  'per-term MATCH against memory_fts ∩ pool': (pool, terms) => {
    const ids = JSON.stringify(pool.map((r) => r.rowid));
    const covered = new Map();
    for (const t of terms) {
      for (const hit of matchGlobal.all(`"${t}"`, ids)) {
        const list = covered.get(hit.rowid) ?? [];
        list.push(t);
        covered.set(hit.rowid, list);
      }
    }
    return covered;
  },
};

const results = [];
for (const size of POOLS) {
  const pool = rows.slice(0, size);
  for (const [name, fn] of Object.entries(VARIANTS)) {
    // Warm-up outside the measurement.
    for (const q of QUERIES) fn(pool, termsOf(q));
    const samples = [];
    for (let i = 0; i < ITERATIONS; i++) {
      const terms = termsOf(QUERIES[i % QUERIES.length]);
      const t0 = performance.now();
      fn(pool, terms);
      samples.push(performance.now() - t0);
    }
    results.push({ size, name, p50: p50(samples) });
  }
}

console.log(`corpus: ${CORPUS_ROWS} memories, pool = the first N active rows by rowid`);
console.log(`${ITERATIONS} queries per cell, p50 ms to decide row membership for one query\n`);
console.log(pad('row-membership source', 42), POOLS.map((p) => pad(`pool ${p}`, 10)).join(''));
for (const name of Object.keys(VARIANTS)) {
  const cells = POOLS.map((size) => {
    const hit = results.find((r) => r.size === size && r.name === name);
    return pad(hit.p50.toFixed(3), 10);
  });
  console.log(pad(name, 42), cells.join(''));
}

// The warm variant's cost depends on how much the cache holds, which is the axis
// the design says defeats it ("the instance read then scans a growing cache").
// Measured directly rather than argued: the same pool-400 read against caches of
// 400, 5 000 and 50 000 rows.
console.log('\nwarm instance read at pool 400, by how many rows the cache holds:');
const pool400 = rows.slice(0, 400);
const extra = raw
  .prepare(
    `SELECT rowid, title, content FROM memory WHERE status = 'active' ORDER BY rowid LIMIT ? OFFSET ?`,
  )
  .all(CORPUS_ROWS, 400);
let cached = 400;
for (const target of [400, 5_000, 50_000]) {
  while (cached < target && cached - 400 < extra.length) {
    const r = extra[cached - 400];
    insertWarm.run(r.rowid, `${r.title}\n\n${r.content}`);
    cached += 1;
  }
  const fn = VARIANTS['cached by memory id, warm instance read'];
  for (const q of QUERIES) fn(pool400, termsOf(q));
  const samples = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const terms = termsOf(QUERIES[i % QUERIES.length]);
    const t0 = performance.now();
    fn(pool400, terms);
    samples.push(performance.now() - t0);
  }
  const vocab = raw.prepare('SELECT count(*) AS n FROM temp.warm_inst').get().n;
  console.log(
    `  cache ${pad(cached, 7)} rows, ${pad(vocab, 9)} term instances: p50 ${p50(samples).toFixed(3)} ms`,
  );
}

handle.close();
rmSync(dir, { recursive: true, force: true });
