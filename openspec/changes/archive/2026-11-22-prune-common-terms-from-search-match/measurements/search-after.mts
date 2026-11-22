// End-to-end memory.search before and after this change. One instrument only:
//   search — MemoryService.search wall clock (performance.now), no embedder (lexical branch + relevance gate),
//            p50 of 7 warm repetitions per query; the table reports the p50 and p95 of those per-query values.
// Run the same file from the base commit's tree and from this change's tree, against the same corpus cache:
//   pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/prune-common-terms-from-search-match/measurements/search-after.mts <corpus-cache-dir> <label>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { freshCopy, load, quiet, largestProjectSlug } = await import(
  new URL('./corpora.mts', import.meta.url).href
);
const { createDb, createRepositories, projectScope } = await load('@rembric/db');
const { MemoryService } = await load('@rembric/core');
const { QUERIES } = await import(
  new URL('../../../../packages/core/src/test-support/retrieval/queries.ts', import.meta.url).href
);

const CACHE = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'rembric-corpora-'));
const LABEL = process.argv[3] ?? 'unlabelled';
const SIZES = [1_000, 20_000, 50_000];
const REPS = 7;
const LIMIT = 8;

const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};

const out = [`# memory.search end to end — ${LABEL}`];
for (const corpus of ['generator', 'realistic'] as const) {
  for (const size of SIZES) {
    const dir = freshCopy(CACHE, corpus, size);
    const handle = createDb({ dataDir: dir, ...quiet });
    const repos = createRepositories(handle.db);
    const memory = new MemoryService(repos, handle.db);
    const project = repos.projects.findBySlug(largestProjectSlug(corpus));
    const scope = projectScope(project.id);
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
    const perQuery: number[] = [];
    for (const query of queries) {
      await memory.search({ query, limit: LIMIT, status: 'active' }, scope);
      const ts: number[] = [];
      for (let i = 0; i < REPS; i += 1) {
        const t0 = performance.now();
        await memory.search({ query, limit: LIMIT, status: 'active' }, scope);
        ts.push(performance.now() - t0);
      }
      perQuery.push(quantile(ts, 0.5));
    }
    out.push(
      `${corpus.padEnd(9)} ${String(size).padStart(6)} rows  search p50 ${quantile(perQuery, 0.5).toFixed(3)} ms  p95 ${quantile(perQuery, 0.95).toFixed(3)} ms  (${queries.length} queries)`,
    );
    handle.close();
  }
}
console.log(out.join('\n'));
