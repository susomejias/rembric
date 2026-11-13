// Baseline on the code before this change: the memory.search lexical branch, its candidate prunings, and the reads that would feed them.
// Instruments, never tabulated together:
//   statement — searchBm25Ids wall clock (performance.now), p50 of 5 warm repetitions per query;
//   lookup    — term-statistics reads, p50 of 5: the relevance gate's current read, a separate per-token read, one combined read;
//   search    — end-to-end MemoryService.search wall clock, no embedder (lexical branch + relevance gate), p50 of 5.
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/prune-common-terms-from-search-match/measurements/baseline.mts <corpus-cache-dir>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { freshCopy, load, quiet, largestProjectSlug } = await import(
  new URL('./corpora.mts', import.meta.url).href
);
const {
  createDb,
  createRepositories,
  projectScope,
  QUERY_TERMS_INSTANCE_TABLE,
  QUERY_TERMS_SCHEMA,
  QUERY_TERMS_TABLE,
} = await load('@rembric/db');
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

type Freq = { term: string; documentFrequency: number | null };

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

function pruneQuery(tokens: string[], byToken: Freq[][], n: number, ratio: number): string[] {
  const kept: string[] = [];
  let keptReachesARow = false;
  tokens.forEach((token, i) => {
    const fs = (byToken[i] ?? []).map((t) => t.documentFrequency ?? 0);
    if (fs.length === 1 && fs[0]! >= ratio * n) return;
    kept.push(token);
    if (fs.length > 0 && Math.min(...fs) > 0) keptReachesARow = true;
  });
  return keptReachesARow ? kept : [...tokens];
}

const out = [
  '# memory.search lexical branch — baseline before this change',
  `queries: realistic control = the ${QUERIES.length} retrieval-eval query texts; generator = the first 6 words of ${QUERIES.length} memories of the largest project`,
  `scope: the largest project; status active; rank window computeRankWindowSize(${LIMIT}, 0); the builder is uncapped on this path`,
  `statistics: global memory_fts_vocab and adminDocumentCount; ratio ${COMMON_TERM_DOCUMENT_RATIO}`,
  'pruned >=1: fall back to every token when no kept token reaches any row (a query is not an indexed row)',
  'pruned >1: pruneCommonTokens unchanged, the save-time rule (#469 prototype)',
  'lookup gate: adminDocumentCount + adminQueryTermFrequencies, what memory.search reads today',
  'lookup separate: gate + a second per-token read; lookup combined: adminDocumentCount + one read carrying the query (row 0) and each token (rows 1..n)',
  'lookup combined dedup: the combined read, each distinct term joined to memory_fts_vocab once (materialized CTE)',
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
    const table = `${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_TABLE}`;
    const clear = raw.prepare(`INSERT INTO ${table}(${QUERY_TERMS_TABLE}) VALUES('delete-all')`);
    const insertOffset = raw.prepare(
      `INSERT INTO ${table}(rowid, body) SELECT key + ?, value FROM json_each(?)`,
    );
    const instance = raw.prepare(`
      SELECT i.doc AS token, i.term AS term, v.doc AS doc
      FROM ${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_INSTANCE_TABLE} i
      LEFT JOIN memory_fts_vocab v ON v.term = i.term
      ORDER BY i.doc, i.offset`);
    const instanceDedup = raw.prepare(`
      WITH f AS MATERIALIZED (
        SELECT t.term AS term, v.doc AS doc
        FROM (SELECT DISTINCT term FROM ${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_INSTANCE_TABLE}) t
        LEFT JOIN memory_fts_vocab v ON v.term = t.term
      )
      SELECT i.doc AS token, i.term AS term, f.doc AS doc
      FROM ${QUERY_TERMS_SCHEMA}.${QUERY_TERMS_INSTANCE_TABLE} i
      JOIN f ON f.term = i.term
      ORDER BY i.doc, i.offset`);
    const perToken = (tokens: string[]): Freq[][] => {
      const byToken: Freq[][] = tokens.map(() => []);
      clear.run();
      insertOffset.run(0, JSON.stringify(tokens));
      for (const r of instance.all() as { token: number; term: string; doc: number | null }[])
        byToken[r.token]!.push({ term: r.term, documentFrequency: r.doc });
      return byToken;
    };
    const combined = (query: string, tokens: string[], dedup = false) => {
      const byToken: Freq[][] = tokens.map(() => []);
      const gate = new Map<string, number | null>();
      clear.run();
      insertOffset.run(0, JSON.stringify([query]));
      insertOffset.run(1, JSON.stringify(tokens));
      for (const r of (dedup ? instanceDedup : instance).all() as {
        token: number;
        term: string;
        doc: number | null;
      }[]) {
        if (r.token === 0) gate.set(r.term, r.doc);
        else byToken[r.token - 1]!.push({ term: r.term, documentFrequency: r.doc });
      }
      return { gate, byToken };
    };
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

    const stmt = { base: [] as number[], p0: [] as number[], p1: [] as number[] };
    const share = { base: [] as number[], p0: [] as number[], p1: [] as number[] };
    const same = { p0: 0, p1: 0 };
    const changed = { p0: 0, p1: 0 };
    const lookup = {
      gate: [] as number[],
      separate: [] as number[],
      combined: [] as number[],
      dedup: [] as number[],
    };
    let dedupEqual = 0;
    const search: number[] = [];
    let gateMapsEqual = 0;
    let plan = '';
    for (const query of queries) {
      const tokens = ftsQueryTokens(query);
      const byToken = perToken(tokens);
      const exprs = {
        base: sanitizeFtsQuery(query),
        p0: joinFtsTokens(pruneQuery(tokens, byToken, n, COMMON_TERM_DOCUMENT_RATIO)),
        p1: joinFtsTokens(pruneCommonTokens(tokens, byToken, n, COMMON_TERM_DOCUMENT_RATIO)),
      };
      const run = (expr: string) => () =>
        repos.memory.searchBm25Ids({ matchExpr: expr, scope, status: 'active', limit: window });
      const top = (expr: string) =>
        run(expr)()
          .slice(0, LIMIT)
          .map((r: { id: string }) => r.id)
          .join();
      for (const k of ['base', 'p0', 'p1'] as const) {
        stmt[k].push(await p50(run(exprs[k])));
        share[k].push(countMatch.get(exprs[k]).n / n);
      }
      for (const k of ['p0', 'p1'] as const) {
        if (exprs[k] !== exprs.base) changed[k] += 1;
        if (top(exprs[k]) === top(exprs.base)) same[k] += 1;
      }
      lookup.gate.push(
        await p50(() => {
          repos.termStatistics.adminDocumentCount();
          repos.termStatistics.adminQueryTermFrequencies(query);
        }),
      );
      lookup.separate.push(
        await p50(() => {
          repos.termStatistics.adminDocumentCount();
          repos.termStatistics.adminQueryTermFrequencies(query);
          perToken(tokens);
        }),
      );
      lookup.combined.push(
        await p50(() => {
          repos.termStatistics.adminDocumentCount();
          combined(query, tokens);
        }),
      );
      lookup.dedup.push(
        await p50(() => {
          repos.termStatistics.adminDocumentCount();
          combined(query, tokens, true);
        }),
      );
      const d = combined(query, tokens, true);
      if (
        JSON.stringify([...d.gate]) === JSON.stringify([...combined(query, tokens).gate]) &&
        JSON.stringify(d.byToken) === JSON.stringify(byToken)
      )
        dedupEqual += 1;
      const gateToday = repos.termStatistics.adminQueryTermFrequencies(query);
      const gateCombined = combined(query, tokens).gate;
      if (
        gateToday.size === gateCombined.size &&
        [...gateToday].every(([t, d]) => gateCombined.has(t) && gateCombined.get(t) === d)
      )
        gateMapsEqual += 1;
      search.push(await p50(() => memory.search({ query, limit: LIMIT, status: 'active' }, scope)));
      if (!plan) {
        const prepare = raw.prepare.bind(raw);
        let captured: { text: string; params: unknown[] } | undefined;
        raw.prepare = (text: string) => {
          const s = prepare(text);
          return new Proxy(s, {
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
        run(exprs.base)();
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
    const q = queries.length;
    out.push(`## ${corpus}, ${size} rows (${q} queries)`);
    out.push(`plan: ${plan}`);
    out.push(
      `statement p50:  unpruned ${f(quantile(stmt.base, 0.5))}   pruned >=1 ${f(quantile(stmt.p0, 0.5))}   pruned >1 ${f(quantile(stmt.p1, 0.5))}`,
    );
    out.push(
      `rows matched, p50 share:  unpruned ${pc(quantile(share.base, 0.5))}   pruned >=1 ${pc(quantile(share.p0, 0.5))}   pruned >1 ${pc(quantile(share.p1, 0.5))}`,
    );
    out.push(
      `expression changed:  pruned >=1 ${changed.p0}/${q}   pruned >1 ${changed.p1}/${q}; top-${LIMIT} lexical ids identical:  pruned >=1 ${same.p0}/${q}   pruned >1 ${same.p1}/${q}`,
    );
    out.push(
      `lookup p50:  gate ${f(quantile(lookup.gate, 0.5))}   separate ${f(quantile(lookup.separate, 0.5))}   combined ${f(quantile(lookup.combined, 0.5))}   combined dedup ${f(quantile(lookup.dedup, 0.5))}; combined gate map equals today's for ${gateMapsEqual}/${q}; dedup output equals combined for ${dedupEqual}/${q}`,
    );
    out.push(`search p50 (MemoryService.search, no embedder): ${f(quantile(search, 0.5))}`);
    out.push('');
    handle.close();
  }
}
console.log(out.join('\n'));
