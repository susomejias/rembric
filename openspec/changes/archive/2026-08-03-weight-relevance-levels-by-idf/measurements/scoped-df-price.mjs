/**
 * The price of a SCOPE-FILTERED document frequency, for the data-access delta's
 * claim that the scoped alternative to `adminQueryTermFrequencies` is dead.
 *
 * Run (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/weight-relevance-levels-by-idf/measurements/scoped-df-price.mjs
 *
 * Instrument: ISOLATED STATEMENT TIME for the df read alone — the terms of one
 * query resolved to their document frequencies, once per search. p50 of 40
 * iterations per (scope, query) cell, one warm process, 50 000-row corpus over
 * six scopes from `seed-volumetric`'s `buildCorpus`. NEVER to be tabulated with
 * the end-to-end p50 of §5.2 in `cost.md`.
 *
 * Arms:
 *   A (shipped)  index-global: insert the query text into the temp tokenising
 *                table, one LEFT JOIN against `memory_fts_vocab`.
 *   B (scoped)   the same tokenisation, then one scope-filtered `count(*)` over
 *                `memory_fts MATCH <term>` per term. `memory_fts_vocab` exposes
 *                `(term, doc, cnt)` and has no scope column, so there is no
 *                filtered vocabulary read to measure instead.
 *
 * Control: scoped df <= global df for every (scope, term). A scoped count above
 * the global one would mean the two arms are not counting the same thing.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createDb } from '../../../../apps/server/src/db/index.js';
import { createRepositories } from '../../../../apps/server/src/db/repositories/index.js';
import { buildCorpus, DEFAULT_ARGS } from '../../../../apps/server/src/scripts/seed-volumetric.js';

const CORPUS_ROWS = 50_000;
const ITERATIONS = 40;

const QUERIES = [
  ['3 terms', 'cache candidate migration'],
  ['6 terms', 'evidence expected explicit failure filter floor'],
  ['10 terms', 'boundary branch budget cache candidate ceiling chain checked client column'],
  [
    '19 terms',
    'why does the consolidation sweep archive a decayed memory ledger and what happens to the relation pending judgment orphaned deadline',
  ],
];

const p50 = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pad = (s, w) => String(s).padEnd(w);
const num = (x, w) => x.toFixed(3).padStart(w);

const dir = mkdtempSync(join(tmpdir(), 'rembric-scoped-df-'));
const handle = createDb({ dataDir: dir });
buildCorpus({
  handle,
  args: { ...DEFAULT_ARGS, dataDir: dir, memories: CORPUS_ROWS },
  log: () => {},
});
const repos = createRepositories(handle.db);
const raw = handle.raw;

const scopes = [
  { label: 'global', scope: 'global', projectId: null },
  ...raw
    .prepare(`SELECT id, slug FROM projects ORDER BY slug`)
    .all()
    .map((p) => ({ label: p.slug, scope: 'project', projectId: p.id })),
];

const rows = raw.prepare(`SELECT count(*) AS n FROM memory`).get().n;
console.log(`corpus: ${rows} memory rows, ${scopes.length} scopes`);
console.log(`instrument: isolated statement time, p50 of ${ITERATIONS}\n`);

const scopedCount = raw.prepare(`
  SELECT count(*) AS n
  FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
  WHERE memory_fts MATCH ?
    AND ((? = 'global' AND m.scope = 'global' AND m.project_id IS NULL)
      OR (? = 'project' AND m.scope = 'project' AND m.project_id = ?))
`);

/** FTS5 MATCH needs the bare term quoted; the terms come from the index itself. */
const matchOne = (term) => `"${term.replace(/"/g, '""')}"`;

const globalDf = (text) => repos.termStatistics.adminQueryTermFrequencies(text);
const scopedDf = (text, s) => {
  const out = new Map();
  for (const term of repos.termStatistics.adminQueryTermFrequencies(text).keys()) {
    out.set(term, scopedCount.get(matchOne(term), s.scope, s.scope, s.projectId).n);
  }
  return out;
};

// Warm both arms before timing; a first execution pays for a cold page cache.
for (const [, text] of QUERIES) {
  globalDf(text);
  scopedDf(text, scopes[0]);
}

let controlChecks = 0;
let controlFailures = 0;
for (const [, text] of QUERIES) {
  const global = globalDf(text);
  for (const s of scopes) {
    for (const [term, n] of scopedDf(text, s)) {
      controlChecks += 1;
      if (n > (global.get(term) ?? 0)) controlFailures += 1;
    }
  }
}
console.log(
  `control: scoped df <= global df on ${controlChecks - controlFailures}/${controlChecks} (scope, term) pairs\n`,
);

console.log(
  `${pad('query', 10)} ${pad('scope', 22)} ${pad('terms', 6)} ${pad('A global', 9)} ${pad('B scoped', 9)} marginal`,
);
const scopedAll = [];
const globalAll = [];
for (const [label, text] of QUERIES) {
  const terms = repos.termStatistics.adminQueryTermFrequencies(text).size;
  for (const s of scopes) {
    const a = [];
    const b = [];
    for (let i = 0; i < ITERATIONS; i++) {
      let t = performance.now();
      globalDf(text);
      a.push(performance.now() - t);
      t = performance.now();
      scopedDf(text, s);
      b.push(performance.now() - t);
    }
    const [pa, pb] = [p50(a), p50(b)];
    globalAll.push(pa);
    scopedAll.push(pb);
    console.log(
      `${pad(label, 10)} ${pad(s.label, 22)} ${pad(terms, 6)} ${num(pa, 9)} ${num(pb, 9)} ${num(pb - pa, 8)}`,
    );
  }
}

console.log(
  `\nA global: ${num(Math.min(...globalAll), 1)}-${num(Math.max(...globalAll), 1)} ms per search`,
);
console.log(
  `B scoped: ${num(Math.min(...scopedAll), 1)}-${num(Math.max(...scopedAll), 1)} ms per search`,
);

handle.close?.();
rmSync(dir, { recursive: true, force: true });
