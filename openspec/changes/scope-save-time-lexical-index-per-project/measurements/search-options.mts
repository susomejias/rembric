// Interactive memory.search lexical branch under option (a): per-project tables, a widened search unions them.
// Instruments, never tabulated together:
//   statement — searchBm25Ids wall clock (performance.now) against the per-project prototype, p50 of 5 warm repetitions per query, then p50 over the queries;
//   lookup    — the relevance gate's term-statistics read (document count + query-term frequencies), global against per-scope, same scheme.
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/scope-save-time-lexical-index-per-project/measurements/search-options.mts <corpus-cache-dir>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { freshCopy, load, quiet, SHARE_SLOTS, slugForSlot } = await import(
  new URL('./corpora.mts', import.meta.url).href
);
const P = await import(new URL('./prototype.mts', import.meta.url).href);
const { createDb, createRepositories, projectScope } = await load('@rembric/db');
const { computeRankWindowSize, sanitizeFtsQuery } = await load('@rembric/core');
const { QUERIES } = await import(
  new URL('../../../../packages/core/src/test-support/retrieval/queries.ts', import.meta.url).href
);

const CACHE = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'rembric-corpora-'));
const SIZES = (process.env.SIZES ?? '1000,20000,50000').split(',').map(Number);
const REPS = 5;
const LIMIT = 8;
const WINDOW = computeRankWindowSize(LIMIT, 0);

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};
const p50 = (fn: () => unknown): number => {
  const ts: number[] = [];
  for (let i = 0; i < REPS; i += 1) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return quantile(ts, 0.5);
};

const out = [
  '# memory.search lexical branch under option (a) — global memory_fts against per-project tables',
  'statement instrument: wall clock (performance.now), p50 of 5 warm repetitions per query, then p50 over the queries',
  "lookup instrument: the relevance gate read alone (document count + query-term frequencies); global = production, per-scope = the scope projects' tables summed",
  `queries: realistic = the ${QUERIES.length} retrieval-eval query texts; generator = the first 6 words of the ${QUERIES.length} most recent memories of the scope's home project`,
  `rank window computeRankWindowSize(${LIMIT}, 0) = ${WINDOW}; status active; weights bm25(1, 1, 2) as production`,
  'scopes: one project at 2% / 60% of rows; widened = every project (authorized-projects, home = the 2% project), per-project top-window then merged by rank, as production',
  `fidelity: top-${LIMIT} ids identical to the global statement / mean overlap of the top-${LIMIT} sets`,
  '',
];

for (const corpus of ['generator-skew', 'realistic-skew'] as const) {
  for (const size of SIZES) {
    const dir = freshCopy(CACHE, corpus, size);
    const handle = createDb({ dataDir: dir, ...quiet });
    const raw = handle.raw;
    const repos = createRepositories(handle.db);
    const all: string[] = raw
      .prepare('SELECT DISTINCT project_id AS id FROM memory WHERE project_id IS NOT NULL')
      .all()
      .map((r: { id: string }) => r.id);
    for (const id of all) P.createProjectIndex(raw, id);
    const vocabs = new Map(all.map((id) => [id, P.createProjectVocab(raw, id)]));
    const single = (id: string) => {
      const t = P.projectTable(id);
      return `SELECT m.id AS id, bm25(${t}, 1.0, 1.0, 2.0) AS rank FROM ${t} JOIN memory m ON m.rowid = ${t}.rowid
              WHERE ${t} MATCH @m AND m.status = 'active' ORDER BY rank LIMIT ${WINDOW}`;
    };
    const countIn = (ids: string[]) =>
      raw.prepare(
        `SELECT count(*) AS n FROM memory WHERE project_id IN (${ids.map(() => '?').join(',')})`,
      );
    out.push(`## ${corpus}, ${size} rows`);

    const home = repos.projects.findBySlug(slugForSlot(corpus, SHARE_SLOTS['2%'])).id;
    const big = repos.projects.findBySlug(slugForSlot(corpus, SHARE_SLOTS['60%'])).id;
    const cases = [
      { label: 'one project, 2%', ids: [home], scope: projectScope(home) },
      { label: 'one project, 60%', ids: [big], scope: projectScope(big) },
      {
        label: `widened, ${all.length} projects`,
        ids: all,
        scope: { kind: 'authorized-projects', projectIds: all, homeProjectId: home },
      },
    ];
    for (const c of cases) {
      const queries: string[] = corpus.startsWith('realistic')
        ? QUERIES.map((q: { text: string }) => q.text)
        : repos.memory
            .recentForContext({
              projectId: c.ids[0],
              includeArchived: false,
              limit: QUERIES.length,
            })
            .map((m: { content: string }) => m.content.split(/\s+/).slice(0, 6).join(' '));
      const perProject = raw.prepare(
        c.ids.length === 1
          ? single(c.ids[0]!)
          : `SELECT id, rank FROM (${c.ids.map((id) => `SELECT * FROM (${single(id)})`).join(' UNION ALL ')}) ORDER BY rank`,
      );
      const count = countIn(c.ids);
      const vs = c.ids.map((id) => vocabs.get(id)!);
      const tG: number[] = [];
      const tP: number[] = [];
      const lG: number[] = [];
      const lP: number[] = [];
      let same = 0;
      let overlap = 0;
      for (const q of queries) {
        const expr = sanitizeFtsQuery(q);
        if (!expr) continue;
        const global = () =>
          repos.memory.searchBm25Ids({
            matchExpr: expr,
            scope: c.scope,
            status: 'active',
            limit: WINDOW,
          });
        const local = () => perProject.all({ m: expr });
        tG.push(p50(global));
        tP.push(p50(local));
        lG.push(
          p50(() => {
            repos.termStatistics.adminDocumentCount();
            repos.termStatistics.adminQueryTermFrequencies(q);
          }),
        );
        lP.push(
          p50(() => {
            count.get(...c.ids);
            P.queryTermFrequencies(raw, vs, q);
          }),
        );
        const a = global()
          .slice(0, LIMIT)
          .map((r: { id: string }) => r.id);
        const b = (local() as { id: string }[]).slice(0, LIMIT).map((r) => r.id);
        if (a.join() === b.join()) same += 1;
        const bs = new Set(b);
        overlap +=
          a.length === 0 ? (b.length === 0 ? 1 : 0) : a.filter((x) => bs.has(x)).length / a.length;
      }
      out.push(
        `  ${c.label.padEnd(22)} statement: global ${quantile(tG, 0.5).toFixed(3)} ms | per-project ${quantile(tP, 0.5).toFixed(3)} ms   lookup: global ${quantile(lG, 0.5).toFixed(3)} ms | per-scope ${quantile(lP, 0.5).toFixed(3)} ms   top-${LIMIT} identical ${same}/${tG.length}, mean overlap ${(overlap / tG.length).toFixed(2)}`,
      );
    }
    out.push('');
    handle.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
console.log(out.join('\n'));
