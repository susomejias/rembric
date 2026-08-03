/**
 * Tasks 10.5.1 / 10.5.2 / 10.5.3 — the amendment's cost, on two instruments that
 * are reported in two separate tables and never merged.
 *
 * Run (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/weight-relevance-levels-by-idf/measurements/cost-amendment.mjs
 *
 * Arms, all three interleaved inside ONE process against ONE database per size,
 * so warm-up, page cache and machine drift hit them equally:
 *
 *   none — no term-statistics read at all: the SAME frequencies B would have
 *          returned, served from a pre-warmed in-process cache. Identical
 *          frequencies matter — an arm that weights every term equally changes
 *          the levels, so the relative filter keeps a different number of rows
 *          and the delta would include that downstream work rather than the read.
 *   A    — pre-amendment: JS `indexTerms` + `WHERE term IN (json_each(?))`.
 *   B    — the amendment: insert the query text into the tokenising table, then
 *          ONE `LEFT JOIN` against `memory_fts_vocab`.
 *
 * Corpus: `buildCorpus` from `seed-volumetric` (synthetic vectors — no retrieval
 * quality claim is drawn from it, only timing).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb } from '../../../../apps/server/src/db/index.js';
import { createRepositories } from '../../../../apps/server/src/db/repositories/index.js';
import { buildCorpus, DEFAULT_ARGS } from '../../../../apps/server/src/scripts/seed-volumetric.js';
import { indexTerms } from '../../../../apps/server/src/services/hybrid-search.js';
import { MemoryService } from '../../../../apps/server/src/services/memory.js';
import { SCOPE_GLOBAL } from '../../../../apps/server/src/services/scope.js';

/** `SIZES=50000 SAMPLES_PER_ARM=400 …` narrows a re-take to the cell under argument. */
const SIZES = (process.env.SIZES ?? '1000,20000,50000').split(',').map(Number);
const LIMITS = (process.env.LIMITS ?? '8,200').split(',').map(Number);
const SAMPLES_PER_ARM = Number(process.env.SAMPLES_PER_ARM ?? 150);
const WARMUP = 40;
const STATEMENT_ITERATIONS = 400;

const QUERIES = [
  'cache candidate migration',
  'why does the consolidation sweep archive a decayed memory ledger',
  'relation pending judgment orphaned deadline',
  'partition pointer prefix projection quorum ratio reader rebuild recipe',
  'latency layer ledger lifecycle linked listing measured memory migration mirror monotonic narrow neither nightly nothing observed offset operator ordering',
  'gate growth handler header hidden however index inline instrument invariant',
  'evidence expected explicit failure filter floor',
  'boundary branch budget cache candidate ceiling chain checked client column',
];

const p50 = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const pct = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(s.length * q))];
};
const fmt = (x, d = 3) => x.toFixed(d);
const pad = (s, w) => String(s).padEnd(w);

/** The pre-amendment read, kept here rather than in the tree: JS terms + `term IN (…)`. */
function armA(raw) {
  const stmt = raw.prepare(
    `SELECT term, doc FROM memory_fts_vocab WHERE term IN (SELECT value FROM json_each(?))`,
  );
  const read = (text) => {
    const terms = [...new Set(indexTerms(text))];
    const rows = stmt.all(JSON.stringify(terms));
    read.lastRows = rows.length;
    const byTerm = new Map(rows.map((r) => [r.term, r.doc]));
    return new Map(terms.map((t) => [t, byTerm.get(t) ?? null]));
  };
  read.lastRows = 0;
  return read;
}

async function run(size) {
  const dir = mkdtempSync(join(tmpdir(), `rembric-cost-${size}-`));
  const handle = createDb({ dataDir: dir });
  buildCorpus({
    handle,
    args: { ...DEFAULT_ARGS, dataDir: dir, memories: size },
    log: () => {},
  });
  const repos = createRepositories(handle.db);
  const memory = new MemoryService(repos, handle.db);
  const shippedB = repos.termStatistics.adminQueryTermFrequencies.bind(repos.termStatistics);
  const readA = armA(handle.raw);
  const realDocumentCount = repos.termStatistics.adminDocumentCount.bind(repos.termStatistics);
  const constantCount = realDocumentCount();

  const cached = new Map(QUERIES.map((q) => [q, shippedB(q)]));
  const arms = {
    none: {
      frequencies: (text) => cached.get(text) ?? shippedB(text),
      documentCount: () => constantCount,
    },
    A: { frequencies: readA, documentCount: realDocumentCount },
    B: { frequencies: shippedB, documentCount: realDocumentCount },
  };

  const use = (name) => {
    repos.termStatistics.adminQueryTermFrequencies = arms[name].frequencies;
    repos.termStatistics.adminDocumentCount = arms[name].documentCount;
  };

  const endToEnd = [];
  for (const limit of LIMITS) {
    const samples = { none: [], A: [], B: [] };
    for (let i = 0; i < WARMUP; i++) {
      use(['none', 'A', 'B'][i % 3]);
      await memory.search({ query: QUERIES[i % QUERIES.length], limit }, SCOPE_GLOBAL);
    }
    for (let i = 0; i < SAMPLES_PER_ARM; i++) {
      for (const name of ['none', 'A', 'B']) {
        use(name);
        const query = QUERIES[i % QUERIES.length];
        const t0 = performance.now();
        await memory.search({ query, limit }, SCOPE_GLOBAL);
        samples[name].push(performance.now() - t0);
      }
    }
    // PAIRED deltas: the same query at the same moment in all three arms, so
    // per-query shape and machine drift cancel instead of being averaged over.
    const paired = (x, y) => samples[x].map((v, i) => v - samples[y][i]);
    endToEnd.push({
      size,
      limit,
      none: p50(samples.none),
      A: p50(samples.A),
      B: p50(samples.B),
      addedA: p50(paired('A', 'none')),
      addedB: p50(paired('B', 'none')),
      bMinusA: p50(paired('B', 'A')),
      addedBp90: pct(paired('B', 'none'), 0.9),
    });
  }

  // A THIRD instrument, reported separately again: the time spent INSIDE the read
  // during a real search. It answers what the two arms cost each other directly,
  // without the surrounding 36-57 ms search in the way.
  const inSearch = [];
  for (const limit of LIMITS) {
    for (const name of ['A', 'B']) {
      const inside = [];
      repos.termStatistics.adminQueryTermFrequencies = (text) => {
        const t0 = performance.now();
        const out = arms[name].frequencies(text);
        inside.push(performance.now() - t0);
        return out;
      };
      for (let i = 0; i < 60; i++) {
        await memory.search({ query: QUERIES[i % QUERIES.length], limit }, SCOPE_GLOBAL);
      }
      inSearch.push({ size, limit, arm: name, p50: p50(inside), calls: inside.length / 60 });
    }
  }
  use('B');

  // Statement-level, a DIFFERENT instrument: the read alone, no search around it.
  const statement = { A: [], B: [], termsA: 0, termsB: 0, absent: 0 };
  for (let i = 0; i < STATEMENT_ITERATIONS; i++) {
    const text = QUERIES[i % QUERIES.length];
    let t0 = performance.now();
    const a = readA(text);
    statement.A.push(performance.now() - t0);
    t0 = performance.now();
    const b = shippedB(text);
    statement.B.push(performance.now() - t0);
    // 10.5.3: rows the SQL returned, which is the point — B reports absent terms
    // too, A can only report the ones the index holds.
    statement.termsA += readA.lastRows;
    statement.termsB += b.size;
    statement.absent += [...b.values()].filter((v) => v === null).length;
  }
  const vocabulary = handle.raw.prepare('SELECT count(*) AS n FROM memory_fts_vocab').get().n;

  handle.close();
  rmSync(dir, { recursive: true, force: true });
  return {
    endToEnd,
    inSearch,
    statement: {
      size,
      vocabulary,
      A: p50(statement.A),
      B: p50(statement.B),
      meanA: statement.termsA / STATEMENT_ITERATIONS,
      meanB: statement.termsB / STATEMENT_ITERATIONS,
      meanAbsent: statement.absent / STATEMENT_ITERATIONS,
    },
  };
}

const results = [];
for (const size of SIZES) results.push(await run(size));

console.log('\n=== 10.5.2 END-TO-END (the budgeted instrument): MemoryService.search p50 ===');
console.log('one process, one database per size, three arms interleaved, 150 samples per arm');
console.log('added/B−A columns are the MEDIAN OF PAIRED DIFFERENCES, not a difference of medians');
console.log(
  pad('rows', 7),
  pad('limit', 6),
  pad('none p50', 9),
  pad('A p50', 8),
  pad('B p50', 8),
  pad('added A', 8),
  pad('added B', 8),
  pad('B − A', 8),
  'added B p90',
);
for (const r of results) {
  for (const row of r.endToEnd) {
    console.log(
      pad(row.size, 7),
      pad(row.limit, 6),
      pad(fmt(row.none), 9),
      pad(fmt(row.A), 8),
      pad(fmt(row.B), 8),
      pad(fmt(row.addedA), 8),
      pad(fmt(row.addedB), 8),
      pad(fmt(row.bMinusA), 8),
      fmt(row.addedBp90),
    );
  }
}

console.log('\n=== in-search read time (a third instrument, also kept separate) ===');
console.log('time spent inside queryTermFrequencies during a real search, 60 searches per cell');
console.log(
  pad('rows', 7),
  pad('limit', 6),
  pad('arm', 4),
  pad('calls/search', 13),
  'read p50 (ms)',
);
for (const r of results) {
  for (const row of r.inSearch) {
    console.log(
      pad(row.size, 7),
      pad(row.limit, 6),
      pad(row.arm, 4),
      pad(fmt(row.calls, 2), 13),
      fmt(row.p50),
    );
  }
}

console.log(
  '\n=== 10.5.1 STATEMENT-LEVEL (a different instrument — never merged with the table above) ===',
);
console.log(`${STATEMENT_ITERATIONS} iterations, one warm process, the read alone`);
console.log(
  pad('rows', 7),
  pad('vocabulary', 11),
  pad('A ms/query', 11),
  pad('B ms/query', 11),
  pad('marginal', 9),
  pad('rows A', 8),
  pad('rows B', 8),
  'of which absent',
);
for (const r of results) {
  const s = r.statement;
  console.log(
    pad(s.size, 7),
    pad(s.vocabulary, 11),
    pad(fmt(s.A, 4), 11),
    pad(fmt(s.B, 4), 11),
    pad(fmt(s.B - s.A, 4), 9),
    pad(fmt(s.meanA, 1), 8),
    pad(fmt(s.meanB, 1), 8),
    fmt(s.meanAbsent, 1),
  );
}
