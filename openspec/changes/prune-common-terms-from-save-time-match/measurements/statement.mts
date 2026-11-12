// Instruments, never tabulated together:
//   statement — searchBm25Candidates wall clock (performance.now), p50 of 5 warm repetitions per probe, unpruned vs pruned;
//   lookup    — adminDocumentCount + adminTokenTermFrequencies wall clock, p50 of 5 repetitions per probe;
//   behaviour — post-floor lexical candidates of findSaveTimeCandidates, commonTermRatio null vs shipped.
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/prune-common-terms-from-save-time-match/measurements/statement.mts <corpus-cache-dir>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const corpora = await import(new URL('./corpora.mts', import.meta.url).href);
const { freshCopy, load, quiet, largestProjectSlug } = corpora;
const { createDb, createRepositories, projectScope } = await load('@rembric/db');
const {
  COMMON_TERM_DOCUMENT_RATIO,
  MemoryService,
  findSaveTimeCandidates,
  ftsQueryTokens,
  joinFtsTokens,
  pruneCommonTokens,
  sanitizeFtsQuery,
} = await load('@rembric/core');

const CACHE = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'rembric-corpora-'));
const SIZES = [1_000, 20_000, 50_000];
const SOURCES = 30;
const REPS = 5;
const FALLBACK_SIZES = [1, 2, 4, 8, 16];
const CLASSES = ['prefix80', 'reversed', 'commonOnly'] as const;

const quantile = (xs: number[], q: number): number => {
  if (xs.length === 0) return Number.NaN;
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
const ms = (x: number) => (Number.isNaN(x) ? '-' : `${x.toFixed(3)} ms`);
const pct = (x: number) => (Number.isNaN(x) ? '-' : `${(x * 100).toFixed(1)}%`);

type Term = { term: string; documentFrequency: number | null };

// Mirrors pruneCommonTokens, but restores only the K rarest omitted tokens when the fallback fires.
function keepRarest(
  tokens: string[],
  terms: Term[][],
  n: number,
  k: number,
): { kept: string[]; fired: boolean } {
  const scored = tokens.map((token, i) => {
    const f = (terms[i] ?? []).map((t) => t.documentFrequency ?? 0);
    return {
      token,
      i,
      df: f.length ? Math.min(...f) : 0,
      common: f.length === 1 && f[0]! >= COMMON_TERM_DOCUMENT_RATIO * n,
    };
  });
  const kept = scored.filter((s) => !s.common);
  if (kept.some((s) => s.df > 1)) return { kept: kept.map((s) => s.token), fired: false };
  const restored = scored
    .filter((s) => s.common)
    .sort((a, b) => Number(a.df <= 1) - Number(b.df <= 1) || a.df - b.df || a.i - b.i)
    .slice(0, k);
  return {
    kept: [...kept, ...restored].sort((a, b) => a.i - b.i).map((s) => s.token),
    fired: true,
  };
}

const out: string[] = [
  '# Save-time lexical statement — unpruned vs pruned (COMMON_TERM_DOCUMENT_RATIO = 0.5)',
  'instruments (never tabulated together): statement = searchBm25Candidates wall clock (performance.now), p50 of 5 warm repetitions per probe, then p50 over probes;',
  '  lookup = adminDocumentCount + adminTokenTermFrequencies wall clock, same statistic; behaviour = findSaveTimeCandidates fts candidates, commonTermRatio null vs shipped',
  `probes: ${SOURCES} active memories of the largest project, each saved (through MemoryService) as three probe classes:`,
  '  prefix80   — the first 80% of its words + " probe <i>"; target = that source memory',
  '  reversed   — its words reversed + " probe <i>"; target = that source memory',
  '  commonOnly — only its words whose document frequency is >= N/2, saved twice; target = the first copy (byte-identical)',
  'the probe row is indexed before measuring, as on the save path; probes accumulate, so later probes see earlier ones',
  'no embeddings and no entity list are passed, so every candidate below is lexical',
  '',
];

for (const corpus of ['generator', 'realistic'] as const) {
  for (const size of SIZES) {
    const dir = freshCopy(CACHE, corpus, size);
    const handle = createDb({ dataDir: dir, ...quiet });
    const repos = createRepositories(handle.db);
    const memory = new MemoryService(repos, handle.db);
    const project = repos.projects.findBySlug(largestProjectSlug(corpus));
    const scope = projectScope(project.id);
    const countMatch = handle.raw.prepare(
      'SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH ?',
    );
    const sources = repos.memory.recentForContext({
      projectId: project.id,
      includeArchived: false,
      limit: SOURCES,
    });

    const records: {
      group: string;
      base: number;
      pruned: number;
      mBase: number;
      mPruned: number;
    }[] = [];
    const lookup: number[] = [];
    let probes = 0;
    let fired = 0;
    let firedNatural = 0;
    let lost = 0;
    let gained = 0;
    let differing = 0;
    let candidatesBase = 0;
    let multiTermAllCommon = 0;
    let tokensSeen = 0;
    const hitBase: Record<string, number> = {};
    const hitPruned: Record<string, number> = {};
    const perClass: Record<string, number> = {};
    const fallback = new Map(FALLBACK_SIZES.map((k) => [k, { hit: 0, ms: [] as number[] }]));
    let firedProbes = 0;

    for (const cls of CLASSES) {
      for (const [i, src] of sources.entries()) {
        const words: string[] = src.content.split(/\s+/);
        let content: string;
        if (cls === 'prefix80')
          content = `${words.slice(0, Math.ceil(words.length * 0.8)).join(' ')} probe ${i}`;
        else if (cls === 'reversed') content = `${[...words].reverse().join(' ')} probe ${i}`;
        else {
          const n0 = repos.termStatistics.adminDocumentCount();
          const per = repos.termStatistics.adminTokenTermFrequencies(words);
          content = words
            .filter((_, w) => per[w].length === 1 && (per[w][0].documentFrequency ?? 0) >= n0 / 2)
            .join(' ');
        }
        if (!content.trim()) continue;
        const twin =
          cls === 'commonOnly'
            ? memory.save({ type: 'project', title: `twin ${i}`, content }, scope)
            : null;
        const saved = memory.save({ type: 'project', title: `probe ${cls} ${i}`, content }, scope);
        const target = twin ? twin.id : src.id;
        probes += 1;
        perClass[cls] = (perClass[cls] ?? 0) + 1;

        const tokens: string[] = ftsQueryTokens(content, { maxTerms: 16 });
        const n = repos.termStatistics.adminDocumentCount();
        const terms: Term[][] = repos.termStatistics.adminTokenTermFrequencies(tokens);
        for (const t of terms) {
          tokensSeen += 1;
          if (t.length > 1 && t.every((x) => (x.documentFrequency ?? 0) >= n / 2))
            multiTermAllCommon += 1;
        }
        const unprunedExpr = sanitizeFtsQuery(content, { maxTerms: 16 });
        const prunedExpr = joinFtsTokens(
          pruneCommonTokens(tokens, terms, n, COMMON_TERM_DOCUMENT_RATIO),
        );
        const rarest = keepRarest(tokens, terms, n, 16);
        if (rarest.fired) {
          fired += 1;
          if (cls !== 'commonOnly') firedNatural += 1;
        }

        const stmt = (expr: string) => () =>
          repos.memory.searchBm25Candidates({
            matchExpr: expr,
            excludeId: saved.id,
            projectId: project.id,
            excludeIds: [],
            limit: 20,
          });
        let tBase: number;
        let tPruned: number;
        if (probes % 2 === 0) {
          tBase = p50(stmt(unprunedExpr));
          tPruned = p50(stmt(prunedExpr));
        } else {
          tPruned = p50(stmt(prunedExpr));
          tBase = p50(stmt(unprunedExpr));
        }
        lookup.push(
          p50(() => {
            repos.termStatistics.adminDocumentCount();
            repos.termStatistics.adminTokenTermFrequencies(tokens);
          }),
        );
        records.push({
          group:
            cls === 'commonOnly'
              ? 'commonOnly'
              : rarest.fired
                ? 'natural, fallback'
                : 'natural, pruned',
          base: tBase,
          pruned: tPruned,
          mBase: countMatch.get(unprunedExpr).n / n,
          mPruned: countMatch.get(prunedExpr).n / n,
        });

        const ids = (ratio: number | null) =>
          new Set<string>(
            findSaveTimeCandidates(repos, saved, { perSaveMax: 50, commonTermRatio: ratio })
              .candidates.filter((c: { source: string }) => c.source === 'fts')
              .map((c: { targetId: string }) => c.targetId),
          );
        const before = ids(null);
        const after = ids(COMMON_TERM_DOCUMENT_RATIO);
        candidatesBase += before.size;
        let l = 0;
        let g = 0;
        for (const id of before) if (!after.has(id)) l += 1;
        for (const id of after) if (!before.has(id)) g += 1;
        lost += l;
        gained += g;
        if (l || g) differing += 1;
        if (before.has(target)) hitBase[cls] = (hitBase[cls] ?? 0) + 1;
        if (after.has(target)) hitPruned[cls] = (hitPruned[cls] ?? 0) + 1;

        if (rarest.fired) {
          firedProbes += 1;
          const pool = (expr: string) =>
            repos.memory.searchBm25Candidates({
              matchExpr: expr,
              excludeId: saved.id,
              projectId: project.id,
              excludeIds: [],
              limit: 20,
            });
          const floorIds = (expr: string) => {
            const memoryOverride = Object.assign(Object.create(repos.memory), {
              searchBm25Candidates: () => pool(expr),
            });
            const all = findSaveTimeCandidates({ ...repos, memory: memoryOverride }, saved, {
              perSaveMax: 50,
              commonTermRatio: null,
            });
            return new Set(all.candidates.map((c: { targetId: string }) => c.targetId));
          };
          for (const k of FALLBACK_SIZES) {
            const expr = joinFtsTokens(keepRarest(tokens, terms, n, k).kept);
            const row = fallback.get(k)!;
            row.ms.push(p50(stmt(expr)));
            if (floorIds(expr).has(target)) row.hit += 1;
          }
        }
      }
    }

    const fmtHits = (h: Record<string, number>) =>
      CLASSES.map((c) => `${c} ${h[c] ?? 0}/${perClass[c] ?? 0}`).join(', ');
    out.push(
      `## ${corpus}, ${size} rows (${probes} probes: ${CLASSES.map((c) => `${perClass[c] ?? 0} ${c}`).join(', ')})`,
    );
    out.push(
      'statement p50 (unpruned → pruned) and rows matched p50 share (unpruned → pruned), per probe group:',
    );
    for (const group of ['natural, pruned', 'natural, fallback', 'commonOnly', 'all probes']) {
      const rs = group === 'all probes' ? records : records.filter((r) => r.group === group);
      const col = (k: 'base' | 'pruned' | 'mBase' | 'mPruned') => rs.map((r) => r[k]);
      out.push(
        `  ${group.padEnd(18)} n=${String(rs.length).padStart(2)}  ${ms(quantile(col('base'), 0.5)).padStart(11)} → ${ms(quantile(col('pruned'), 0.5)).padStart(11)}   ${pct(quantile(col('mBase'), 0.5)).padStart(6)} → ${pct(quantile(col('mPruned'), 0.5)).padStart(6)}`,
      );
    }
    out.push(
      `lookup p50 over all probes: ${ms(quantile(lookup, 0.5))}   (p90 ${ms(quantile(lookup, 0.9))})`,
    );
    out.push(
      `fallback fired:             ${fired}/${probes} probes (${firedNatural}/${probes - (perClass.commonOnly ?? 0)} prefix80+reversed)`,
    );
    out.push(
      `multi-term tokens whose terms are all common: ${multiTermAllCommon}/${tokensSeen} tokens`,
    );
    out.push(
      `lexical candidates (perSaveMax 50): unpruned ${candidatesBase}; lost ${lost}, gained ${gained}; probes differing ${differing}/${probes}`,
    );
    out.push(`target surfaced, unpruned:  ${fmtHits(hitBase)}`);
    out.push(`target surfaced, pruned:    ${fmtHits(hitPruned)}`);
    out.push(
      `fallback size comparison on the ${firedProbes} fallback probes (statement p50; target surfaced after the floor):`,
    );
    for (const k of FALLBACK_SIZES) {
      const row = fallback.get(k)!;
      out.push(
        `  keep ${k === 16 ? 'all' : String(k).padStart(3)}  ${ms(quantile(row.ms, 0.5)).padStart(11)}   target ${row.hit}/${firedProbes}`,
      );
    }
    out.push('');
    handle.close();
  }
}
console.log(out.join('\n'));
