// Instrument: FTS5 bm25() of one row that matches a single term, as the term's document share crosses one half.
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/prune-common-terms-from-save-time-match/measurements/idf-clamp.mts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { load, quiet } = await import(new URL('./corpora.mts', import.meta.url).href);
const { createDb } = await load('@rembric/db');

const handle = createDb({ dataDir: mkdtempSync(join(tmpdir(), 'rembric-idf-clamp-')), ...quiet });
const raw = handle.raw;
const out = [
  '# FTS5 bm25 idf clamp',
  "instrument: SELECT bm25(t) for rowid 1 of a temp fts5(x) table; every row is 'alpha beta' or 'gamma beta', so dl = avgdl and tf = 1",
  'expected: -ln((N - n + 0.5) / (n + 0.5)) while that is positive, otherwise -1e-6',
  '',
  '     N      n  n >= N/2        bm25        -ln(...)',
];
for (const [n, k] of [
  [10, 4],
  [10, 5],
  [10, 6],
  [11, 5],
  [11, 6],
  [1000, 499],
  [1000, 500],
  [50000, 24999],
  [50000, 25000],
]) {
  raw.exec('DROP TABLE IF EXISTS temp.t; CREATE VIRTUAL TABLE temp.t USING fts5(x)');
  const ins = raw.prepare('INSERT INTO temp.t(rowid, x) VALUES (?, ?)');
  raw.transaction(() => {
    for (let i = 1; i <= n; i += 1) ins.run(i, i <= k ? 'alpha beta' : 'gamma beta');
  })();
  const s = raw.prepare(`SELECT bm25(t) AS s FROM temp.t WHERE t MATCH 'alpha' AND rowid = 1`).get()
    .s as number;
  const formula = -Math.log((n - k + 0.5) / (k + 0.5));
  out.push(
    `${String(n).padStart(6)} ${String(k).padStart(6)}  ${String(k >= n / 2).padEnd(8)} ${s.toExponential(4).padStart(11)} ${formula.toExponential(4).padStart(11)}`,
  );
}
handle.close();
console.log(out.join('\n'));
