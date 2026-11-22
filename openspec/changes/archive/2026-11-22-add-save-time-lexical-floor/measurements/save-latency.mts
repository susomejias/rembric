// Instrument: end-to-end saveMemoryWithCandidates wall clock (performance.now), embedder not wired.
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/add-save-time-lexical-floor/measurements/save-latency.mts
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const webRequire = createRequire(new URL('../../../../apps/web/package.json', import.meta.url));
const load = (spec: string) => import(pathToFileURL(webRequire.resolve(spec)).href);

const { createDb, createRepositories, projectScope } = await load('@rembric/db');
const { MemoryService, RelationsService } = await load('@rembric/core');
const { saveMemoryWithCandidates } = await load('@rembric/mcp');
const { buildCorpus, DEFAULT_ARGS } = await import(
  new URL('../../../../apps/web/src/scripts/seed-volumetric.ts', import.meta.url).href
);

const SIZES = [1_000, 20_000, 50_000];
const WARMUP = 20;
const SAMPLES = 400;
const BOOTSTRAP = 2000;
const FLOOR = 0.6;
const ARMS = [
  { name: 'floor-0.00 (a)', floor: 0 },
  { name: `floor-${FLOOR.toFixed(2)}`, floor: FLOOR },
  { name: 'floor-0.00 (b)', floor: 0 },
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

function medianInterval(
  diffs: number[],
  rng: () => number,
): { median: number; lo: number; hi: number } {
  const medians: number[] = [];
  for (let b = 0; b < BOOTSTRAP; b += 1) {
    const resample = diffs.map(() => diffs[Math.floor(rng() * diffs.length)]!);
    medians.push(quantile(resample, 0.5));
  }
  return {
    median: quantile(diffs, 0.5),
    lo: quantile(medians, 0.025),
    hi: quantile(medians, 0.975),
  };
}

async function measure(size: number): Promise<string[]> {
  const dataDir = mkdtempSync(join(tmpdir(), 'rembric-save-latency-'));
  const handle = createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
  try {
    buildCorpus({ handle, args: { ...DEFAULT_ARGS, dataDir, memories: size }, log: () => {} });
    const repos = createRepositories(handle.db);
    const project = repos.projects.findBySlug('vol-shared') ?? repos.projects.findBySlug('vol-0');
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
    const addedDiffs: number[] = [];
    const noiseDiffs: number[] = [];
    for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
      const round = new Map<string, number>();
      const base = nextInput(i);
      for (let k = 0; k < ARMS.length; k += 1) {
        const arm = ARMS[(i + k) % ARMS.length]!;
        const input = { ...base, title: `${base.title} ${arm.name}` };
        const t0 = performance.now();
        const out = await saveMemoryWithCandidates(
          { ...deps, candidates: { perSaveMax: 5, lexicalFloor: arm.floor } },
          input,
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
        addedDiffs.push(round.get(ARMS[1].name)! - round.get(ARMS[0].name)!);
        noiseDiffs.push(round.get(ARMS[2].name)! - round.get(ARMS[0].name)!);
      }
    }
    const p50 = (n: string) => quantile(samples.get(n)!, 0.5);
    const added = medianInterval(addedDiffs, splitmix32(size + 1));
    const noise = medianInterval(noiseDiffs, splitmix32(size + 2));
    const lines = ARMS.map(
      (a) =>
        `${String(size).padStart(6)} ${a.name.padEnd(16)} p50 ${p50(a.name).toFixed(3).padStart(8)} ms  p90 ${quantile(samples.get(a.name)!, 0.9).toFixed(3).padStart(8)} ms  pending rows ${String(rows.get(a.name)).padStart(5)}`,
    );
    const fmt = (m: { median: number; lo: number; hi: number }) =>
      `${m.median.toFixed(3)} ms [95% ${m.lo.toFixed(3)}, ${m.hi.toFixed(3)}]`;
    lines.push(
      `${String(size).padStart(6)} paired median (floor − a) ${fmt(added)}; noise, paired median (b − a) ${fmt(noise)}; budget ${added.hi <= Math.max(noise.hi, Math.abs(noise.lo)) ? 'MET' : 'MISSED'}`,
    );
    return lines;
  } finally {
    handle.close?.();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const out = [
  '# memory.save latency — before/after LEXICAL_CANDIDATE_FLOOR',
  'instrument: end-to-end saveMemoryWithCandidates wall clock (performance.now), embedder not wired, per-save cap 5',
  `paired design: each round saves the SAME probe text through all three arms, in rotating order, in one process against one database; ${WARMUP} warm-up rounds discarded, ${SAMPLES} rounds`,
  `statistic: median of per-round paired differences with a ${BOOTSTRAP}-resample bootstrap 95% interval; budget MET when the upper bound for (floor − a) does not exceed the larger magnitude bound of the identical-arm noise (b − a)`,
  'corpus: pnpm run corpus:build generator (buildCorpus, default args, seed 1) at each size; probes are 80%-prefix and reversed rewrites of existing memories in vol-shared',
  '',
];
for (const size of SIZES) out.push(...(await measure(size)), '');
console.log(out.join('\n'));
