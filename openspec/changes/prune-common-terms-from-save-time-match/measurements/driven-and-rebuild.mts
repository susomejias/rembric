// Instruments, never tabulated together:
//   driven — wall clock of one memory-driven join (memory CROSS JOIN memory_fts on rowid), single run per probe;
//   idf    — wall clock of bm25() on ONE row against the same MATCH without bm25(), p50 of 5;
//   build  — wall clock of FTS5 'rebuild' of memory_fts, and of filling a temp FTS table with a project column.
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/prune-common-terms-from-save-time-match/measurements/driven-and-rebuild.mts <corpus-cache-dir>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { freshCopy, load, quiet, SHARE_SLOTS, slugForSlot } = await import(
  new URL('./corpora.mts', import.meta.url).href
);
const { createDb, createRepositories } = await load('@rembric/db');
const {
  COMMON_TERM_DOCUMENT_RATIO,
  ftsQueryTokens,
  joinFtsTokens,
  pruneCommonTokens,
  sanitizeFtsQuery,
} = await load('@rembric/core');

const CACHE = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'rembric-corpora-'));
const SIZE = 50_000;
const PROBES = 3;
const once = (fn: () => unknown): number => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

const FILTER = `m.id != @x AND m.scope = 'project' AND m.project_id IN (@p) AND m.status = 'active'`;
const out = [
  '# Memory-driven join, idf cost, and rebuild time',
  'instruments: driven = single-run wall clock per probe (performance.now); idf = p50 of 5; build = single run',
  '',
];

for (const corpus of ['generator-skew', 'realistic-skew'] as const) {
  const handle = createDb({ dataDir: freshCopy(CACHE, corpus, SIZE), ...quiet });
  const raw = handle.raw;
  const repos = createRepositories(handle.db);
  const n = repos.termStatistics.adminDocumentCount();
  out.push(`## ${corpus}, ${SIZE} rows`);
  if (corpus === 'generator-skew') {
    const project = repos.projects.findBySlug(slugForSlot(corpus, SHARE_SLOTS['2%']));
    const driven = raw.prepare(
      `SELECT m.id AS id, bm25(memory_fts) AS rank FROM memory m CROSS JOIN memory_fts ON memory_fts.rowid = m.rowid
       WHERE memory_fts MATCH @m AND ${FILTER} ORDER BY bm25(memory_fts) LIMIT 20`,
    );
    const drivenNoRank = raw.prepare(
      `SELECT count(*) AS n FROM memory m CROSS JOIN memory_fts ON memory_fts.rowid = m.rowid
       WHERE memory_fts MATCH @m AND ${FILTER}`,
    );
    const rows = repos.memory.recentForContext({
      projectId: project.id,
      includeArchived: false,
      limit: PROBES,
    });
    for (const variant of ['unpruned', 'pruned'] as const) {
      const withRank: number[] = [];
      const withoutRank: number[] = [];
      const shipped: number[] = [];
      for (const r of rows) {
        const tokens = ftsQueryTokens(r.content, { maxTerms: 16 });
        const expr =
          variant === 'unpruned'
            ? sanitizeFtsQuery(r.content, { maxTerms: 16 })
            : joinFtsTokens(
                pruneCommonTokens(
                  tokens,
                  repos.termStatistics.adminTokenTermFrequencies(tokens),
                  n,
                  COMMON_TERM_DOCUMENT_RATIO,
                ),
              );
        const args = { m: expr, x: r.id, p: project.id };
        withRank.push(once(() => driven.all(args)));
        withoutRank.push(once(() => drivenNoRank.get(args)));
        shipped.push(
          once(() =>
            repos.memory.searchBm25Candidates({
              matchExpr: expr,
              excludeId: r.id,
              projectId: project.id,
              excludeIds: [],
              limit: 20,
            }),
          ),
        );
      }
      out.push(
        `driven join, project at 2% (1000 rows), ${variant}: with bm25 ${median(withRank).toFixed(1)} ms, without bm25 ${median(withoutRank).toFixed(1)} ms; shipped statement ${median(shipped).toFixed(2)} ms (median of ${PROBES} probes)`,
      );
    }
    const common = raw
      .prepare(`SELECT term, doc FROM memory_fts_vocab ORDER BY doc DESC LIMIT 1`)
      .get();
    const row = raw
      .prepare(`SELECT rowid FROM memory_fts WHERE memory_fts MATCH ? LIMIT 1`)
      .get(`"${common.term}"`).rowid;
    const scored = raw.prepare(
      `SELECT bm25(memory_fts) FROM memory_fts WHERE memory_fts MATCH ? AND rowid = ?`,
    );
    const bare = raw.prepare(`SELECT 1 FROM memory_fts WHERE memory_fts MATCH ? AND rowid = ?`);
    const t5 = (fn: () => unknown) => median(Array.from({ length: 5 }, () => once(fn)));
    out.push(
      `idf: one row, term '${common.term}' in ${common.doc} rows: with bm25 ${t5(() => scored.get(`"${common.term}"`, row)).toFixed(3)} ms, without ${t5(() => bare.get(`"${common.term}"`, row)).toFixed(3)} ms`,
    );
  }
  out.push(
    `build: memory_fts 'rebuild' ${once(() => raw.exec(`INSERT INTO memory_fts(memory_fts) VALUES('rebuild')`)).toFixed(0)} ms`,
  );
  out.push(
    `build: temp fts5 with a project_id column ${once(() => {
      raw.exec(
        `CREATE VIRTUAL TABLE temp.e1 USING fts5(content, tags, title, project_id, content='')`,
      );
      raw.exec(
        `INSERT INTO temp.e1(rowid, content, tags, title, project_id) SELECT rowid, content, tags, title, project_id FROM memory`,
      );
    }).toFixed(0)} ms`,
    '',
  );
  handle.close();
}
console.log(out.join('\n'));
