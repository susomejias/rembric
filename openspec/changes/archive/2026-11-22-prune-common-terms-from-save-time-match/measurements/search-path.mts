// Investigation only — the interactive memory.search lexical branch is NOT changed by this change.
// Instruments, never tabulated together:
//   statement — searchBm25Ids wall clock (performance.now), p50 of 5 warm repetitions per query, unpruned vs a pruned prototype;
//   lookup    — the term-statistics read memory.search ALREADY issues per query (adminDocumentCount + adminQueryTermFrequencies);
//   search    — end-to-end MemoryService.search wall clock, no embedder (lexical branch + relevance gate), p50 of 5.
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/prune-common-terms-from-save-time-match/measurements/search-path.mts <corpus-cache-dir>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { freshCopy, load, quiet, largestProjectSlug } = await import(
  new URL('./corpora.mts', import.meta.url).href
);
const { createDb, createRepositories, projectScope } = await load('@rembric/db');
const {
  COMMON_TERM_DOCUMENT_RATIO,
  MemoryService,
  computeRankWindowSize,
  ftsQueryTokens,
  joinFtsTokens,
  pruneCommonTokens,
  sanitizeFtsQuery,
} = await load('@rembric/core');
const { QUERIES } = await import(
  new URL('../../../../packages/core/src/test-support/retrieval/queries.ts', import.meta.url).href
);

const CACHE = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'rembric-corpora-'));
const SIZES = [1_000, 20_000, 50_000];
const REPS = 5;
const LIMIT = 8;

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};
async function p50(fn: () => unknown): Promise<number> {
  const ts: number[] = [];
  for (let i = 0; i < REPS; i += 1) {
    const t0 = performance.now();
    await fn();
    ts.push(performance.now() - t0);
  }
  return quantile(ts, 0.5);
}

const out = [
  '# memory.search lexical branch — investigation (unchanged by this change)',
  `queries: realistic control = the ${QUERIES.length} retrieval-eval query texts; generator = the first 6 words of ${QUERIES.length} memories of the largest project`,
  `scope: the largest project; status active; rank window computeRankWindowSize(${LIMIT}, 0); the builder is uncapped on this path`,
  'pruned prototype: pruneCommonTokens over the query tokens with the save-time ratio. A query is not an indexed row, so its "occurs elsewhere" test is looser than at save time',
  '',
];

for (const corpus of ['generator', 'realistic'] as const) {
  for (const size of SIZES) {
    const dir = freshCopy(CACHE, corpus, size);
    const handle = createDb({ dataDir: dir, ...quiet });
    const raw = handle.raw;
    const repos = createRepositories(handle.db);
    const memory = new MemoryService(repos, handle.db);
    const project = repos.projects.findBySlug(largestProjectSlug(corpus));
    const scope = projectScope(project.id);
    const countMatch = raw.prepare('SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH ?');
    const queries: string[] =
      corpus === 'realistic'
        ? QUERIES.map((q: { text: string }) => q.text)
        : repos.memory
            .recentForContext({
              projectId: project.id,
              includeArchived: false,
              limit: QUERIES.length,
            })
            .map((m: { content: string }) => m.content.split(/\s+/).slice(0, 6).join(' '));
    const window = computeRankWindowSize(LIMIT, 0);
    const n = repos.termStatistics.adminDocumentCount();

    const base: number[] = [];
    const pruned: number[] = [];
    const lookup: number[] = [];
    const search: number[] = [];
    const mBase: number[] = [];
    const mPruned: number[] = [];
    let topSame = 0;
    let emptied = 0;
    let plan = '';
    for (const query of queries) {
      const unprunedExpr = sanitizeFtsQuery(query);
      const tokens = ftsQueryTokens(query);
      const prunedExpr = joinFtsTokens(
        pruneCommonTokens(
          tokens,
          repos.termStatistics.adminTokenTermFrequencies(tokens),
          n,
          COMMON_TERM_DOCUMENT_RATIO,
        ),
      );
      if (!prunedExpr) emptied += 1;
      const run = (expr: string) => () =>
        repos.memory.searchBm25Ids({ matchExpr: expr, scope, status: 'active', limit: window });
      base.push(await p50(run(unprunedExpr)));
      pruned.push(await p50(run(prunedExpr)));
      lookup.push(
        await p50(() => {
          repos.termStatistics.adminDocumentCount();
          repos.termStatistics.adminQueryTermFrequencies(query);
        }),
      );
      search.push(await p50(() => memory.search({ query, limit: LIMIT, status: 'active' }, scope)));
      mBase.push(countMatch.get(unprunedExpr).n / n);
      mPruned.push(countMatch.get(prunedExpr).n / n);
      const a = run(unprunedExpr)()
        .slice(0, LIMIT)
        .map((r: { id: string }) => r.id)
        .join();
      const b = run(prunedExpr)()
        .slice(0, LIMIT)
        .map((r: { id: string }) => r.id)
        .join();
      if (a === b) topSame += 1;
      if (!plan) {
        const prepare = raw.prepare.bind(raw);
        let captured: { text: string; params: unknown[] } | undefined;
        raw.prepare = (text: string) => {
          const stmt = prepare(text);
          return new Proxy(stmt, {
            get(t: object, prop: string | symbol) {
              const v = Reflect.get(t, prop);
              if (prop === 'all' && typeof v === 'function')
                return (...params: unknown[]) => {
                  if (/memory_fts MATCH/.test(text)) captured = { text, params };
                  return (v as (...a: unknown[]) => unknown).apply(t, params);
                };
              return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v;
            },
          });
        };
        run(unprunedExpr)();
        raw.prepare = prepare;
        if (captured) {
          plan = prepare(`EXPLAIN QUERY PLAN ${captured.text}`)
            .all(...captured.params)
            .map((r: { detail: string }) => r.detail)
            .join(' | ');
        }
      }
    }
    const f = (x: number) => `${x.toFixed(3)} ms`;
    const pc = (x: number) => `${(x * 100).toFixed(1)}%`;
    out.push(`## ${corpus}, ${size} rows (${queries.length} queries)`);
    out.push(`plan: ${plan}`);
    out.push(
      `statement p50:  unpruned ${f(quantile(base, 0.5))}   pruned prototype ${f(quantile(pruned, 0.5))}`,
    );
    out.push(
      `rows matched, p50 share:  unpruned ${pc(quantile(mBase, 0.5))}   pruned ${pc(quantile(mPruned, 0.5))}; pruned expression empty for ${emptied}/${queries.length}`,
    );
    out.push(`top-${LIMIT} lexical ids identical: ${topSame}/${queries.length}`);
    out.push(
      `lookup p50 (already paid by the relevance gate on every non-empty search): ${f(quantile(lookup, 0.5))}`,
    );
    out.push(`search p50 (MemoryService.search, no embedder): ${f(quantile(search, 0.5))}`);
    out.push('');
    handle.close();
  }
}
console.log(out.join('\n'));
