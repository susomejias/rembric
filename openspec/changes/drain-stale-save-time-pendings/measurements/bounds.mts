// Review M1 (per-pair cost for very large bodies, and a size bound above which the pair is unknown) and the
// per-run fixed cost of the undone-drain read. Rules v2. Synthetic text only.
// Run: DRAIN_SCRATCH=$(mktemp -d) pnpm --filter @rembric/core exec tsx ../../openspec/changes/drain-stale-save-time-pendings/measurements/bounds.mts
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const SCRATCH = process.env.DRAIN_SCRATCH;
if (!SCRATCH) throw new Error('set DRAIN_SCRATCH to a mktemp -d directory outside the workspace');

const P = await import('./drain-prototype.mts');

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

function body(seed: number, chars: number, style: 'prose' | 'identifiers'): string {
  const rng = splitmix32(seed);
  const parts: string[] = [];
  let n = 0;
  let i = 0;
  while (n < chars) {
    let w: string;
    if (style === 'identifiers' && i % 8 === 7) {
      w = `src/mod${Math.floor(rng() * 5000)}/file${Math.floor(rng() * 5000)}.ts`;
    } else {
      w = Array.from({ length: 4 + Math.floor(rng() * 6) }, () =>
        String.fromCharCode(97 + Math.floor(rng() * 26)),
      ).join('');
    }
    parts.push(w);
    n += w.length + 1;
    i += 1;
  }
  return parts.join(' ').slice(0, chars);
}

function unitVector(seed: number): Float32Array {
  const rng = splitmix32(seed * 7919 + 13);
  const v = new Float32Array(768);
  let n = 0;
  for (let i = 0; i < v.length; i += 1) {
    v[i] = rng() * 2 - 1;
    n += v[i]! * v[i]!;
  }
  for (let i = 0; i < v.length; i += 1) v[i]! /= Math.sqrt(n);
  return v;
}

const dataDir = join(SCRATCH, 'bounds');
mkdirSync(dataDir, { recursive: true });
const handle = P.openDb(dataDir);
const repos = P.db.createRepositories(handle.db);
const project = new P.core.ProjectsService(repos).create({ slug: 'bounds', displayName: 'bounds' });
const scope = P.db.projectScope(project.id);
const memory = new P.core.MemoryService(repos, handle.db);
const relations = new P.core.RelationsService(repos, handle.db);
let seq = 1;
const save = (content: string): any => {
  const seed = seq++;
  const { memory: m } = memory.saveWithTopicKey(
    { type: 'project', title: `bounds ${seed}`, content },
    scope,
  );
  const v = unitVector(seed);
  repos.vectors.insertEmbedding(m.id, Buffer.from(v.buffer), P.db.partitionKeyFor(project.id));
  repos.entities.linkMemory(
    m.id,
    project.id,
    P.core.extractEntities(m.title, m.content),
    m.createdAt,
  );
  return m;
};

const SIZES = [1_300, 20_000, 32_000, 50_000, 64_000, 80_000, 100_000, 200_000, 1_000_000];
const REPS = 5;
const out: string[] = [
  '# stale pending drain — per-pair bounds (rules v3 channels, measured with the size bound OFF; synthetic text)',
  `instrument: wall clock of one recheckPair call (performance.now), warm, median of ${REPS} repetitions; columns split the same call into its steps`,
  'texts: pseudo-random words; "identifiers" puts a path every 8th token so entity extraction has work; both endpoints get random vectors, so only lexical and entity work scale with size',
  `scratch ${dataDir}`,
  '',
  `${'body chars'.padStart(10)} ${'style'.padEnd(11)} ${'shape'.padEnd(13)} ${'rows'.padStart(7)} ${'lexical'.padStart(8)} ${'vector'.padStart(7)} ${'stored'.padStart(7)} ${'extract'.padStart(8)} ${'TOTAL'.padStart(8)}  (ms)`,
];
const ctx = P.createContext(handle, { rules: { ...P.RULES_V3, maxPairChars: undefined } });
const small = save(body(999_999, 1_300, 'prose'));
const results: { chars: number; total: number }[] = [];
for (const style of ['prose', 'identifiers'] as const) {
  for (const chars of SIZES) {
    const big = save(body(chars + (style === 'prose' ? 1 : 2), chars, style));
    const big2 = save(body(chars + (style === 'prose' ? 3 : 4), chars, style));
    const shapes: [string, any, any][] = [
      ['large->small', big, small],
      ['small->large', small, big],
      ['large->large', big, big2],
    ];
    for (const [shape, a, b] of shapes) {
      const pair = { judgmentId: 'probe', sourceId: a.id, targetId: b.id };
      const steps = {
        rows: [] as number[],
        lexical: [] as number[],
        vector: [] as number[],
        stored: [] as number[],
        extract: [] as number[],
        total: [] as number[],
      };
      for (let r = 0; r <= REPS; r += 1) {
        let t = performance.now();
        const rows = repos.memory.unsafeGetByIds([a.id, b.id]);
        const ra = rows.find((x: any) => x.id === a.id);
        const rb = rows.find((x: any) => x.id === b.id);
        const tRows = performance.now() - t;
        t = performance.now();
        P.core.tokenContainment(
          P.core.tokenSet(ra.content),
          P.core.tokenSet(`${rb.title}\n\n${rb.content}`),
        );
        const tLex = performance.now() - t;
        t = performance.now();
        ctx.reads.pairCosineDistance(a.id, b.id);
        const tVec = performance.now() - t;
        t = performance.now();
        repos.entities.findEntitiesForMemories([a.id, b.id]);
        const tStored = performance.now() - t;
        t = performance.now();
        P.core.extractEntities(ra.title, ra.content);
        P.core.extractEntities(rb.title, rb.content);
        const tExtract = performance.now() - t;
        t = performance.now();
        P.recheckPair(ctx, pair, project.id);
        const tTotal = performance.now() - t;
        if (r === 0) continue;
        steps.rows.push(tRows);
        steps.lexical.push(tLex);
        steps.vector.push(tVec);
        steps.stored.push(tStored);
        steps.extract.push(tExtract);
        steps.total.push(tTotal);
      }
      const m = (xs: number[]) => P.quantile(xs, 0.5).toFixed(2).padStart(7);
      out.push(
        `${P.pad(chars, 10)} ${style.padEnd(11)} ${shape.padEnd(13)} ${m(steps.rows)} ${m(steps.lexical).padStart(8)} ${m(steps.vector)} ${m(steps.stored)} ${m(steps.extract).padStart(8)} ${m(steps.total).padStart(8)}`,
      );
      results.push({ chars, total: P.quantile(steps.total, 0.5) });
    }
  }
}

const BOUND = P.DRAIN_MAX_PAIR_CHARS;
const bounded = P.createContext(handle);
const hugeA = save(body(7_777_777, 1_000_000, 'prose'));
const hugeB = save(body(8_888_888, 1_300, 'prose'));
const hugeRel = relations.createPending({ sourceId: hugeA.id, targetId: hugeB.id });
const normA = save(body(5_555_555, 1_300, 'prose'));
const normB = save(body(6_666_666, 1_300, 'prose'));
const normRel = relations.createPending({ sourceId: normA.id, targetId: normB.id });
const ts: number[] = [];
let check: any;
for (let r = 0; r <= REPS; r += 1) {
  const t = performance.now();
  check = P.recheckPair(bounded, hugeRel, project.id);
  if (r > 0) ts.push(performance.now() - t);
}
const pass = P.drainOnePass(bounded, project.id, 100);
const verdict = (id: string) => {
  const d = pass.decisions.find((x: any) => x.judgmentId === id);
  return d ? `${d.verdict} (${d.reason})` : 'not examined';
};
out.push(
  '',
  `## size bound probe: rules v3 with DRAIN_MAX_PAIR_CHARS = ${BOUND} (title + content of either endpoint, measured with SQL length() before content is loaded)`,
  `1 MB source -> 1.3 KB target: recheck ${P.quantile(ts, 0.5).toFixed(2)} ms (status/length read only), decision ${verdict(hugeRel.judgmentId)}`,
  `control (must drain): a 1.3 KB noise pair with the bound on -> ${verdict(normRel.judgmentId)}`,
);

const opRun = P.ulid(Date.now());
repos.consolidation.insertRun({ id: opRun, startedAt: new Date(), scope: `project:${project.id}` });
out.push(
  '',
  '## per-run fixed read: reverted orphan_promote ops for one batch of 1 000 judgment ids (design D7 lookup; instrument: wall clock of one read, median of 7)',
);
let inserted = 0;
const batchIds = Array.from({ length: 1000 }, (_, i) => `j${i * 7}`);
for (const target of [1_000, 10_000, 100_000]) {
  handle.db.transaction(() => {
    for (; inserted < target; inserted += 1) {
      const id = P.ulid(Date.now() + inserted);
      repos.consolidation.insertOp({
        id,
        runId: opRun,
        opType: 'orphan_promote',
        affectedIds: ['a', 'b'],
        createdId: `j${inserted}`,
        reasoning:
          inserted % 3 === 0
            ? `orphaned: ${P.STALE_PREFIX}: synthetic`
            : 'orphaned: unjudged after 1209600000ms deadline',
        appliedAt: new Date(),
        revertedAt: inserted % 10 === 0 ? new Date() : null,
      });
    }
  });
  const xs: number[] = [];
  let size = 0;
  for (let r = 0; r < 7; r += 1) {
    const t = performance.now();
    size = ctx.reads.revertedOrphanIds(batchIds).size;
    xs.push(performance.now() - t);
  }
  out.push(
    `  consolidation_ops rows ${P.pad(target, 7)}: ${P.quantile(xs, 0.5).toFixed(2)} ms (${size} of the batch excluded)`,
  );
}
handle.close();
console.log(out.join('\n'));
