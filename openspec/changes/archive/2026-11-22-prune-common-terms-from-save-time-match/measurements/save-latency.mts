// Instrument: end-to-end saveMemoryWithCandidates wall clock (performance.now), embedder not wired.
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/prune-common-terms-from-save-time-match/measurements/save-latency.mts <corpus-cache-dir>
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { freshCopy, load, quiet, SHARE_SLOTS, slugForSlot } = await import(
  new URL('./corpora.mts', import.meta.url).href
);
const { createDb, createRepositories, projectScope } = await load('@rembric/db');
const { MemoryService, RelationsService } = await load('@rembric/core');
const { saveMemoryWithCandidates } = await load('@rembric/mcp');

const CACHE = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'rembric-corpora-'));
const SIZES = [1_000, 20_000, 50_000];
const WARMUP = 10;
const SAMPLES = 200;
const BOOTSTRAP = 2000;
// 'before' replays the base commit's statement (ORDER BY rank) with pruning off.
const ARMS = [
  { name: 'before (a)', legacy: true, commonTermRatio: null },
  { name: 'after', legacy: false, commonTermRatio: undefined },
  { name: 'pruning only', legacy: true, commonTermRatio: undefined },
  { name: 'before (b)', legacy: true, commonTermRatio: null },
] as const;
const LEGACY_SQL = `
  SELECT m.id AS id, memory_fts.rank AS rank, m.title AS title, m.content AS content,
         m.topic_key AS topicKey
  FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
  WHERE memory_fts MATCH ? AND m.id != ? AND m.scope = 'project' AND m.project_id IN (?)
    AND m.status = 'active' AND m.id NOT IN (SELECT value FROM json_each(?))
  ORDER BY rank LIMIT ?`;

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

async function measure(corpus: string, size: number, share: string, slot: number) {
  const dataDir = freshCopy(CACHE, corpus, size);
  const handle = createDb({ dataDir, ...quiet });
  try {
    const repos = createRepositories(handle.db);
    const legacy = handle.raw.prepare(LEGACY_SQL);
    const legacyMemory = Object.assign(Object.create(repos.memory), {
      searchBm25Candidates: (o: {
        matchExpr: string;
        excludeId: string;
        projectId: string;
        excludeIds: string[];
        limit: number;
      }) =>
        legacy.all(o.matchExpr, o.excludeId, o.projectId, JSON.stringify(o.excludeIds), o.limit),
    });
    const project = repos.projects.findBySlug(slugForSlot(corpus, slot));
    const scope = projectScope(project.id);
    const sources = repos.memory.recentForContext({
      projectId: project.id,
      includeArchived: false,
      limit: 400,
    });
    const memory = new MemoryService(repos, handle.db);
    const relations = new RelationsService(repos, handle.db);
    const rng = splitmix32(size + slot);
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
    const diffs = new Map<string, number[]>(ARMS.slice(1).map((a) => [a.name, []]));
    for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
      const round = new Map<string, number>();
      const base = nextInput(i);
      for (let k = 0; k < ARMS.length; k += 1) {
        const arm = ARMS[(i + k) % ARMS.length]!;
        const deps = {
          memory,
          relations,
          repos: arm.legacy ? { ...repos, memory: legacyMemory } : repos,
          candidates: {
            perSaveMax: 5,
            ...(arm.commonTermRatio === null ? { commonTermRatio: null } : {}),
          },
        };
        const t0 = performance.now();
        await saveMemoryWithCandidates(
          deps,
          { ...base, title: `${base.title} ${arm.name}` },
          scope,
        );
        const dt = performance.now() - t0;
        round.set(arm.name, dt);
        if (i >= WARMUP) samples.get(arm.name)!.push(dt);
      }
      if (i >= WARMUP) {
        for (const arm of ARMS.slice(1))
          diffs.get(arm.name)!.push(round.get(arm.name)! - round.get(ARMS[0].name)!);
      }
    }
    const fmt = (m: { median: number; lo: number; hi: number }) =>
      `${m.median.toFixed(2)} [${m.lo.toFixed(2)}, ${m.hi.toFixed(2)}]`;
    const p = (name: string, q: number) => quantile(samples.get(name)!, q).toFixed(2);
    return `${corpus.padEnd(14)} ${String(size).padStart(6)} ${share.padStart(3)}  p50 before ${p('before (a)', 0.5).padStart(7)} after ${p('after', 0.5).padStart(7)} pruning-only ${p('pruning only', 0.5).padStart(7)}  p90 before ${p('before (a)', 0.9).padStart(7)} after ${p('after', 0.9).padStart(7)}  | paired: after−a ${fmt(medianInterval(diffs.get('after')!, splitmix32(size + 1)))}  pruning-only−a ${fmt(medianInterval(diffs.get('pruning only')!, splitmix32(size + 2)))}  b−a ${fmt(medianInterval(diffs.get('before (b)')!, splitmix32(size + 3)))}`;
  } finally {
    handle.close();
  }
}

const out = [
  '# memory.save latency — the base commit against this change',
  'instrument: end-to-end saveMemoryWithCandidates wall clock (performance.now), embedder not wired, per-save cap 5; all values in ms',
  `paired design: each round saves the SAME probe text through all four arms, in rotating order, in one process against one database; ${WARMUP} warm-up rounds discarded, ${SAMPLES} rounds`,
  "arms: 'before' = the base commit's statement (ORDER BY rank, replayed verbatim) with pruning off; 'after' = this change as shipped; 'pruning only' = pruning with the base statement; (b) repeats (a) as the noise band",
  `statistic: median of per-round paired differences against 'before (a)', with a ${BOOTSTRAP}-resample bootstrap 95% interval`,
  'corpora: the skewed generator and skewed realistic control (corpora.mts); the saving project holds 2%, 20% or 60% of all rows; probes are 80%-prefix and reversed rewrites of its memories',
  '',
];
for (const corpus of ['generator-skew', 'realistic-skew']) {
  for (const size of SIZES) {
    for (const [share, slot] of Object.entries(SHARE_SLOTS))
      out.push(await measure(corpus, size, share, slot as number));
    out.push('');
  }
}
console.log(out.join('\n'));
