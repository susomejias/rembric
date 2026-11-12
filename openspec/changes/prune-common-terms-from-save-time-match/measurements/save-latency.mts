// Instrument: end-to-end saveMemoryWithCandidates wall clock (performance.now), embedder not wired.
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/prune-common-terms-from-save-time-match/measurements/save-latency.mts <corpus-cache-dir>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { freshCopy, load, quiet, largestProjectSlug } = await import(
  new URL('./corpora.mts', import.meta.url).href
);
const { createDb, createRepositories, projectScope } = await load('@rembric/db');
const { MemoryService, RelationsService } = await load('@rembric/core');
const { saveMemoryWithCandidates } = await load('@rembric/mcp');

const CACHE = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'rembric-corpora-'));
const SIZES = [1_000, 20_000, 50_000];
const WARMUP = 20;
const SAMPLES = 300;
const BOOTSTRAP = 2000;
const ARMS = [
  { name: 'unpruned (a)', commonTermRatio: null },
  { name: 'pruned', commonTermRatio: undefined },
  { name: 'unpruned (b)', commonTermRatio: null },
] as const;

function splitmix32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x9e3779b9) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 16), 0x21f0aaad);
    t = Math.imul(t ^ (t >>> 15), 0x735a2d97);
    return ((t ^ (t >>> 15)) >>> 0) / 4294967296;
  };
}

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

function medianInterval(diffs: number[], rng: () => number) {
  const medians: number[] = [];
  for (let b = 0; b < BOOTSTRAP; b += 1) {
    medians.push(
      quantile(
        diffs.map(() => diffs[Math.floor(rng() * diffs.length)]!),
        0.5,
      ),
    );
  }
  return {
    median: quantile(diffs, 0.5),
    lo: quantile(medians, 0.025),
    hi: quantile(medians, 0.975),
  };
}

async function measure(corpus: 'generator' | 'realistic', size: number): Promise<string[]> {
  const dataDir = freshCopy(CACHE, corpus, size);
  const handle = createDb({ dataDir, ...quiet });
  try {
    const repos = createRepositories(handle.db);
    const project = repos.projects.findBySlug(largestProjectSlug(corpus));
    const scope = projectScope(project.id);
    const sources = repos.memory.recentForContext({
      projectId: project.id,
      includeArchived: false,
      limit: 400,
    });
    const deps = {
      memory: new MemoryService(repos, handle.db),
      relations: new RelationsService(repos, handle.db),
      repos,
    };
    const rng = splitmix32(size);
    const nextInput = (i: number) => {
      const src = sources[Math.floor(rng() * sources.length)]!;
      const words = src.content.split(/\s+/);
      const body = i % 2 === 0 ? words.slice(0, Math.ceil(words.length * 0.8)) : words.reverse();
      return {
        type: 'project',
        title: `latency probe ${i}`,
        content: `${body.join(' ')} probe ${i}`,
      };
    };

    const samples = new Map<string, number[]>(ARMS.map((a) => [a.name, []]));
    const rows = new Map<string, number>(ARMS.map((a) => [a.name, 0]));
    const prunedDiffs: number[] = [];
    const noiseDiffs: number[] = [];
    for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
      const round = new Map<string, number>();
      const base = nextInput(i);
      for (let k = 0; k < ARMS.length; k += 1) {
        const arm = ARMS[(i + k) % ARMS.length]!;
        const candidates = {
          perSaveMax: 5,
          ...(arm.commonTermRatio === null ? { commonTermRatio: null } : {}),
        };
        const t0 = performance.now();
        const out = await saveMemoryWithCandidates(
          { ...deps, candidates },
          { ...base, title: `${base.title} ${arm.name}` },
          scope,
        );
        const dt = performance.now() - t0;
        round.set(arm.name, dt);
        if (i >= WARMUP) {
          samples.get(arm.name)!.push(dt);
          rows.set(arm.name, rows.get(arm.name)! + out.candidates.length);
        }
      }
      if (i >= WARMUP) {
        prunedDiffs.push(round.get(ARMS[1].name)! - round.get(ARMS[0].name)!);
        noiseDiffs.push(round.get(ARMS[2].name)! - round.get(ARMS[0].name)!);
      }
    }
    const fmt = (m: { median: number; lo: number; hi: number }) =>
      `${m.median.toFixed(3)} ms [95% ${m.lo.toFixed(3)}, ${m.hi.toFixed(3)}]`;
    const lines = ARMS.map(
      (a) =>
        `${corpus.padEnd(9)} ${String(size).padStart(6)} ${a.name.padEnd(13)} p50 ${quantile(samples.get(a.name)!, 0.5).toFixed(3).padStart(8)} ms  p90 ${quantile(samples.get(a.name)!, 0.9).toFixed(3).padStart(8)} ms  pending rows ${String(rows.get(a.name)).padStart(5)}`,
    );
    lines.push(
      `${corpus.padEnd(9)} ${String(size).padStart(6)} paired median (pruned − a) ${fmt(medianInterval(prunedDiffs, splitmix32(size + 1)))}; identical arms (b − a) ${fmt(medianInterval(noiseDiffs, splitmix32(size + 2)))}`,
    );
    return lines;
  } finally {
    handle.close();
  }
}

const out = [
  '# memory.save latency — before/after pruning common terms from the save-time MATCH',
  'instrument: end-to-end saveMemoryWithCandidates wall clock (performance.now), embedder not wired, per-save cap 5',
  `paired design: each round saves the SAME probe text through all three arms, in rotating order, in one process against one database; ${WARMUP} warm-up rounds discarded, ${SAMPLES} rounds`,
  "arms: 'unpruned' passes commonTermRatio: null (today's statement, no term-statistics read); 'pruned' passes nothing (shipped behaviour)",
  `statistic: median of per-round paired differences with a ${BOOTSTRAP}-resample bootstrap 95% interval`,
  'corpora: the corpus:build generator (default args, seed 1) and the realistic-vocabulary control (corpora.mts); probes are 80%-prefix and reversed rewrites of memories in the largest project',
  '',
];
for (const corpus of ['generator', 'realistic'] as const) {
  for (const size of SIZES) out.push(...(await measure(corpus, size)), '');
}
console.log(out.join('\n'));
