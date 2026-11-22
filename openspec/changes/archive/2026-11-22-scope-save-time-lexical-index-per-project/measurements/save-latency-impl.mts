// Instrument: end-to-end saveMemoryWithCandidates wall clock (performance.now), embedder not wired, per-save cap 5.
// Phase 2: the implementation as shipped against the status quo after #469, replayed by wrapping the repositories
// (the global memory_fts statement and the global pruning statistics).
// Run: pnpm -r --filter "./packages/*" build && pnpm --filter @rembric/core exec tsx ../../openspec/changes/scope-save-time-lexical-index-per-project/measurements/save-latency-impl.mts <corpus-cache-dir>
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { freshCopy, load, quiet, SHARE_SLOTS, slugForSlot } = await import(
  new URL('./corpora.mts', import.meta.url).href
);
const P = await import(new URL('./prototype.mts', import.meta.url).href);
const { createDb, createRepositories, projectScope } = await load('@rembric/db');
const { MemoryService, RelationsService } = await load('@rembric/core');
const { saveMemoryWithCandidates } = await load('@rembric/mcp');

const CACHE = process.argv[2] ?? mkdtempSync(join(tmpdir(), 'rembric-corpora-'));
const SIZES = (process.env.SIZES ?? '1000,20000,50000').split(',').map(Number);
const WARMUP = 10;
const SAMPLES = 200;
const BOOTSTRAP = 2000;
const ARMS = ['d (a)', 'impl', 'd (b)'] as const;

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
const quantile = (xs: number[], q: number): number => {
  const s = [...xs].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))]!;
};
function medianInterval(diffs: number[], rng: () => number) {
  const medians: number[] = [];
  for (let b = 0; b < BOOTSTRAP; b += 1)
    medians.push(
      quantile(
        diffs.map(() => diffs[Math.floor(rng() * diffs.length)]!),
        0.5,
      ),
    );
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
    const raw = handle.raw;
    const repos = createRepositories(handle.db);
    const project = repos.projects.findBySlug(slugForSlot(corpus, slot));
    const pid: string = project.id;
    const stmt = raw.prepare(
      `SELECT m.id AS id, bm25(memory_fts) AS rank, m.title AS title, m.content AS content, m.topic_key AS topicKey
       FROM memory_fts JOIN memory m ON m.rowid = memory_fts.rowid
       WHERE memory_fts MATCH ? AND m.id != ? AND m.scope = 'project' AND m.project_id = ? AND m.status = 'active'
         AND m.id NOT IN (SELECT value FROM json_each(?))
       ORDER BY bm25(memory_fts) LIMIT ?`,
    );
    const statusQuo = {
      ...repos,
      memory: Object.assign(Object.create(repos.memory), {
        searchBm25Candidates: (o: {
          matchExpr: string;
          excludeId: string;
          excludeIds: string[];
          limit: number;
        }) => stmt.all(o.matchExpr, o.excludeId, pid, JSON.stringify(o.excludeIds), o.limit),
      }),
      termStatistics: Object.assign(Object.create(repos.termStatistics), {
        projectDocumentCount: () => repos.termStatistics.adminDocumentCount(),
        projectTokenTermFrequencies: (_scope: unknown, tokens: readonly string[]) =>
          P.tokenTermFrequencies(raw, 'memory_fts_vocab', tokens),
      }),
    };
    const scope = projectScope(pid);
    const sources = repos.memory.recentForContext({
      projectId: pid,
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
    const samples = new Map<string, number[]>(ARMS.map((a) => [a, []]));
    const diffs = new Map<string, number[]>(ARMS.slice(1).map((a) => [a, []]));
    for (let i = 0; i < WARMUP + SAMPLES; i += 1) {
      const round = new Map<string, number>();
      const base = nextInput(i);
      for (let k = 0; k < ARMS.length; k += 1) {
        const arm = ARMS[(i + k) % ARMS.length]!;
        const deps = {
          memory,
          relations,
          repos: arm === 'impl' ? repos : statusQuo,
          candidates: { perSaveMax: 5 },
        };
        const t0 = performance.now();
        await saveMemoryWithCandidates(deps, { ...base, title: `${base.title} ${arm}` }, scope);
        const dt = performance.now() - t0;
        round.set(arm, dt);
        if (i >= WARMUP) samples.get(arm)!.push(dt);
      }
      if (i >= WARMUP)
        for (const arm of ARMS.slice(1))
          diffs.get(arm)!.push(round.get(arm)! - round.get(ARMS[0])!);
    }
    const fmt = (m: { median: number; lo: number; hi: number }) =>
      `${m.median.toFixed(2)} [${m.lo.toFixed(2)}, ${m.hi.toFixed(2)}]`;
    const p = (name: string, q: number) => quantile(samples.get(name)!, q).toFixed(2);
    return `${corpus.padEnd(14)} ${String(size).padStart(6)} ${share.padStart(3)}  p50 d ${p('d (a)', 0.5).padStart(7)} impl ${p('impl', 0.5).padStart(7)}  p90 d ${p('d (a)', 0.9).padStart(7)} impl ${p('impl', 0.9).padStart(7)}  | paired: impl−d ${fmt(medianInterval(diffs.get('impl')!, splitmix32(size + 1)))}  noise d(b)−d(a) ${fmt(medianInterval(diffs.get('d (b)')!, splitmix32(size + 3)))}`;
  } finally {
    handle.close();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const out = [
  '# memory.save latency — status quo (d) against the Phase 2 implementation',
  'instrument: end-to-end saveMemoryWithCandidates wall clock (performance.now), embedder not wired, per-save cap 5; all values in ms',
  `paired design: each round saves the SAME probe text through all three arms, in rotating order, in one process against one database; ${WARMUP} warm-up rounds discarded, ${SAMPLES} rounds`,
  "arms: 'impl' = production repositories as shipped; 'd' = the #469 statement on memory_fts with global pruning statistics, replayed by wrapping; d (b) repeats d (a) as the noise band",
  'caveat: every arm runs with the per-project triggers installed (the boot reconciler built them), so every arm pays the extra write; write-cost.txt measures it separately',
  `statistic: median of per-round paired differences against 'd (a)', with a ${BOOTSTRAP}-resample bootstrap 95% interval`,
  "corpora: the skewed generator and skewed realistic control (corpora.mts); probes are 80%-prefix and reversed rewrites of the project's memories",
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
