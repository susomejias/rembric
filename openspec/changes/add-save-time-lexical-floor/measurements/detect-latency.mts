// Instrument: findSaveTimeCandidates wall clock only (read path, no writes), embedder not wired.
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/add-save-time-lexical-floor/measurements/detect-latency.mts
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const webRequire = createRequire(new URL('../../../../apps/web/package.json', import.meta.url));
const load = (spec: string) => import(pathToFileURL(webRequire.resolve(spec)).href);

const { createDb, createRepositories, projectScope } = await load('@rembric/db');
const { MemoryService, findSaveTimeCandidates } = await load('@rembric/core');
const { buildCorpus, DEFAULT_ARGS } = await import(
  new URL('../../../../apps/web/src/scripts/seed-volumetric.ts', import.meta.url).href
);

const SIZE = 20_000;
const PROBES = 40;
const ROUNDS = 50;
const ARMS = [
  { name: 'floor-0.00 (a)', floor: 0 },
  { name: 'floor-0.60', floor: 0.6 },
  { name: 'floor-0.00 (b)', floor: 0 },
] as const;

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

const dataDir = mkdtempSync(join(tmpdir(), 'rembric-detect-latency-'));
const handle = createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
try {
  buildCorpus({ handle, args: { ...DEFAULT_ARGS, dataDir, memories: SIZE }, log: () => {} });
  const repos = createRepositories(handle.db);
  const project = repos.projects.findBySlug('vol-shared');
  const scope = projectScope(project.id);
  const memory = new MemoryService(repos, handle.db);
  const sources = repos.memory.recentForContext({
    projectId: project.id,
    includeArchived: false,
    limit: PROBES,
  });
  const probes = sources.map((src: { title: string; content: string }, i: number) =>
    memory.save(
      {
        type: 'project',
        title: `detect probe ${i}`,
        content: src.content.split(/\s+/).reverse().join(' '),
      },
      scope,
    ),
  );

  const diffsFloor: number[] = [];
  const diffsNoise: number[] = [];
  const admitted = new Map<string, number>(ARMS.map((a) => [a.name, 0]));
  for (let r = 0; r < ROUNDS + 5; r += 1) {
    for (const [p, saved] of probes.entries()) {
      const t = new Map<string, number>();
      for (let k = 0; k < ARMS.length; k += 1) {
        const arm = ARMS[(r + p + k) % ARMS.length]!;
        const t0 = performance.now();
        const res = findSaveTimeCandidates(repos, saved, {
          perSaveMax: 5,
          lexicalFloor: arm.floor,
        });
        t.set(arm.name, performance.now() - t0);
        if (r >= 5) admitted.set(arm.name, admitted.get(arm.name)! + res.detected);
      }
      if (r >= 5) {
        diffsFloor.push(t.get(ARMS[1].name)! - t.get(ARMS[0].name)!);
        diffsNoise.push(t.get(ARMS[2].name)! - t.get(ARMS[0].name)!);
      }
    }
  }
  console.log(
    [
      '# save-time detection latency — floor 0.00 vs 0.60 (statement-level instrument, not end-to-end)',
      `instrument: findSaveTimeCandidates wall clock (performance.now), read path only, no writes; ${SIZE} memories (corpus:build generator, seed 1); ${PROBES} probes × ${ROUNDS} rounds, 5 warm-up rounds discarded, rotating arm order`,
      `paired median (floor-0.60 − a): ${quantile(diffsFloor, 0.5).toFixed(4)} ms (p25 ${quantile(diffsFloor, 0.25).toFixed(4)}, p75 ${quantile(diffsFloor, 0.75).toFixed(4)})`,
      `paired median (b − a), identical arms: ${quantile(diffsNoise, 0.5).toFixed(4)} ms (p25 ${quantile(diffsNoise, 0.25).toFixed(4)}, p75 ${quantile(diffsNoise, 0.75).toFixed(4)})`,
      ...ARMS.map(
        (a) => `${a.name}: detected candidates summed over timed calls ${admitted.get(a.name)}`,
      ),
    ].join('\n'),
  );
} finally {
  handle.close();
  rmSync(dataDir, { recursive: true, force: true });
}
