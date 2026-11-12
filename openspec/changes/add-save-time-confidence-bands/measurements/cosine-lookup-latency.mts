// Instrument: VectorsRepository.cosineDistances wall clock (one statement pair, read only), 40 target ids.
// Reference series, separately labelled: VectorsRepository.knnCandidates (limit 20), which every save already runs.
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/add-save-time-confidence-bands/measurements/cosine-lookup-latency.mts
import { mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const webRequire = createRequire(new URL('../../../../apps/web/package.json', import.meta.url));
const load = (spec: string) => import(pathToFileURL(webRequire.resolve(spec)).href);

const { createDb, createRepositories, partitionKeyFor, projectScope } = await load('@rembric/db');
const { MemoryService } = await load('@rembric/core');

const SIZES = [1_000, 20_000];
const TARGETS = 40;
const ROUNDS = 400;
const DIMS = 768;

function quantile(xs: number[], q: number): number {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
}

let seed = 42;
function rand(): number {
  seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
  return seed / 2_147_483_648 - 0.5;
}

function vector(): Buffer {
  const v = new Float32Array(DIMS);
  let norm = 0;
  for (let i = 0; i < DIMS; i++) norm += (v[i] = rand()) ** 2;
  for (let i = 0; i < DIMS; i++) v[i]! /= Math.sqrt(norm);
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

const lines = [
  '# cosineDistances latency (statement level, not end-to-end)',
  `instrument: performance.now() around one call; ${ROUNDS} rounds after 20 warm-up rounds; ${TARGETS} target ids per lookup; random unit vectors`,
  '',
];
for (const size of SIZES) {
  const dataDir = mkdtempSync(join(tmpdir(), 'rembric-cosine-lookup-'));
  const handle = createDb({ dataDir, onMigrationProgress: () => {}, onStartupLog: () => {} });
  try {
    const repos = createRepositories(handle.db);
    const project = repos.projects.listOrdered(false)[0];
    const scope = projectScope(project.id);
    const memory = new MemoryService(repos, handle.db);
    const ids: string[] = [];
    for (let i = 0; i < size; i++) {
      const m = memory.save({ type: 'project', title: `m ${i}`, content: `memory ${i}` }, scope);
      repos.vectors.insertEmbedding(m.id, vector(), partitionKeyFor(project.id));
      ids.push(m.id);
    }
    const pick = () => ids[Math.floor((rand() + 0.5) * ids.length) % ids.length]!;
    const lookup: number[] = [];
    const knn: number[] = [];
    for (let r = 0; r < ROUNDS + 20; r++) {
      const memoryId = pick();
      const targetIds = Array.from({ length: TARGETS }, pick);
      let t = performance.now();
      repos.vectors.cosineDistances({ memoryId, scope, targetIds });
      const a = performance.now() - t;
      t = performance.now();
      repos.vectors.knnCandidates({ memoryId, scope, excludeIds: [], limit: 20 });
      const b = performance.now() - t;
      if (r >= 20) {
        lookup.push(a);
        knn.push(b);
      }
    }
    const fmt = (xs: number[]) =>
      `p50 ${quantile(xs, 0.5).toFixed(3)} ms, p95 ${quantile(xs, 0.95).toFixed(3)} ms`;
    lines.push(`${size} memories: cosineDistances(${TARGETS} ids)  ${fmt(lookup)}`);
    lines.push(`${size} memories: knnCandidates(limit 20)  ${fmt(knn)}  [reference series]`);
  } finally {
    handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}
console.log(lines.join('\n'));
