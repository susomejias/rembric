// Validations 4, 5 and 6, the missing-vector half of the no-inference check, and two amendment probes.
// Instrument: relation status, journal rows and drain decisions on small synthetic scopes (not a timing).
// Run: DRAIN_SCRATCH=$(mktemp -d) pnpm --filter @rembric/core exec tsx ../../openspec/changes/drain-stale-save-time-pendings/measurements/mechanics.mts
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

function words(seed: number, n: number): string[] {
  const rng = splitmix32(seed * 2654435761);
  return Array.from({ length: n }, () =>
    Array.from({ length: 6 + Math.floor(rng() * 4) }, () =>
      String.fromCharCode(97 + Math.floor(rng() * 26)),
    ).join(''),
  );
}

function unitVector(seed: number): Float32Array {
  const rng = splitmix32(seed * 7919 + 13);
  const v = new Float32Array(768);
  let n = 0;
  for (let i = 0; i < v.length; i += 1) {
    v[i] = rng() * 2 - 1;
    n += v[i]! * v[i]!;
  }
  const inv = 1 / Math.sqrt(n);
  for (let i = 0; i < v.length; i += 1) v[i]! *= inv;
  return v;
}

let seedCounter = 1;
function env(slug: string) {
  const dataDir = join(SCRATCH!, `mechanics-${slug}`);
  mkdirSync(dataDir, { recursive: true });
  const handle = P.openDb(dataDir);
  const repos = P.db.createRepositories(handle.db);
  const project = new P.core.ProjectsService(repos).create({ slug, displayName: slug });
  const scope = P.db.projectScope(project.id);
  const clock = new P.TestClock();
  const memory = new P.core.MemoryService(repos, handle.db, clock.now);
  const relations = new P.core.RelationsService(repos, handle.db, clock.now);
  const save = (
    content: string,
    opts: { vector?: boolean; topicKey?: string; title?: string } = {},
  ): any => {
    clock.advance(1000);
    const seed = seedCounter++;
    const { memory: m } = memory.saveWithTopicKey(
      {
        type: 'project',
        title: opts.title ?? `synthetic ${seed} ${words(seed + 900_000, 1)[0]}`,
        content,
        ...(opts.topicKey ? { topicKey: opts.topicKey } : {}),
      },
      scope,
    );
    if (opts.vector !== false) {
      const v = unitVector(seed);
      repos.vectors.insertEmbedding(m.id, Buffer.from(v.buffer), P.db.partitionKeyFor(project.id));
    }
    repos.entities.linkMemory(
      m.id,
      project.id,
      P.core.extractEntities(m.title, m.content),
      m.createdAt,
    );
    return m;
  };
  const pend = (s: any, t: any): any => {
    clock.advance(1000);
    return relations.createPending({ sourceId: s.id, targetId: t.id });
  };
  const noisePair = (vectors: { source?: boolean; target?: boolean } = {}) => {
    const t = save(words(seedCounter + 500_000, 12).join(' '), { vector: vectors.target ?? true });
    const s = save(words(seedCounter + 700_000, 12).join(' '), { vector: vectors.source ?? true });
    return { s, t, rel: pend(s, t) };
  };
  const genuinePair = () => {
    const base = words(seedCounter + 300_000, 12);
    const t = save(base.join(' '));
    const s = save([...base.slice(0, 10), ...words(seedCounter + 400_000, 2)].join(' '));
    return { s, t, rel: pend(s, t) };
  };
  return {
    handle,
    repos,
    projectId: project.id,
    scope,
    clock,
    relations,
    save,
    pend,
    noisePair,
    genuinePair,
  };
}

function relRow(handle: any, judgmentId: string): any {
  // VERIFICATION READ (raw, read-only)
  return handle.raw
    .prepare(
      'SELECT status, relation, marked_by_kind AS markedByKind FROM memory_relations WHERE judgment_id = ?',
    )
    .get(judgmentId);
}

function opsFor(handle: any, judgmentId: string): number {
  // VERIFICATION READ (raw, read-only)
  return handle.raw
    .prepare(
      "SELECT count(*) AS n FROM consolidation_ops WHERE op_type = 'orphan_promote' AND created_id = ? AND reverted_at IS NULL",
    )
    .get(judgmentId).n;
}

function verdictOf(pass: any, judgmentId: string): string {
  const d = pass.decisions.find((x: any) => x.judgmentId === judgmentId);
  return d ? `${d.verdict} (${d.reason})` : 'not examined';
}

const ok = (b: boolean) => (b ? 'PASS' : 'FAIL');
const out: string[] = [
  '# stale pending drain — mechanics (synthetic scopes), rules v3 unless a line names v1 or v2',
  'texts: pseudo-random words, so lexical containment is ~0 for noise pairs and 10/12 for genuine near-duplicates; vectors: seeded random unit vectors (cosine ~0); entities linked through EntitiesRepository.linkMemory as the save path does',
  `scratch root ${SCRATCH}`,
  '',
];

{
  const e = env('v4');
  const K = 30;
  const M = 70;
  const B = 20;
  const genuine = Array.from({ length: K }, () => e.genuinePair().rel.judgmentId);
  const noise = Array.from({ length: M }, () => e.noisePair().rel.judgmentId);
  const order = P.pendingIds(e.handle, e.projectId);
  const prefixOk = order.slice(0, K).every((id) => genuine.includes(id));
  out.push(
    '## validation 4 — no starvation, ceil(N/B) runs, idempotence',
    `backlog N = ${K + M}: the first ${K} rows in judgment_id order are genuine near-duplicates (kept), then ${M} noise rows; B = ${B}`,
    `setup check: the first ${K} pending ids are the genuine ones: ${ok(prefixOk)}`,
  );
  const ctx = P.createContext(e.handle);
  let starvedDrained = 0;
  const starvedSeen = new Set<string>();
  for (let i = 0; i < 10; i += 1) {
    const r = P.runDrain(ctx, { projectId: e.projectId, batch: B, cursor: null, useCursor: false });
    starvedDrained += r.drained;
    for (const d of r.decisions) starvedSeen.add(d.judgmentId);
  }
  out.push(
    `control without the cursor (always the first B rows): 10 runs drained ${starvedDrained}, distinct rows examined ${starvedSeen.size} — starvation reproduced: ${ok(starvedDrained === 0 && starvedSeen.size === B)}`,
  );
  const pass = P.drainOnePass(ctx, e.projectId, B);
  out.push('with the cursor:');
  pass.runs.forEach((r: any, i: number) => {
    out.push(
      `  run ${i + 1}: examined ${r.examined}, drained ${P.pad(r.drained, 2)}, kept ${P.pad(r.kept, 2)}, stop ${r.stopReason}, cursor ${r.cursor}`,
    );
  });
  const drainedIds = pass.decisions
    .filter((d: any) => d.verdict === 'drained')
    .map((d: any) => d.judgmentId);
  const allNoiseDrained = noise.every((id) => drainedIds.includes(id));
  const genuineKept = genuine.every((id) => relRow(e.handle, id).status === 'pending');
  out.push(
    `runs ${pass.runs.length} (ceil(${K + M}/${B}) = ${Math.ceil((K + M) / B)}); drained ${drainedIds.length}/${M} noise rows: ${ok(pass.runs.length === Math.ceil((K + M) / B) && allNoiseDrained)}; genuine rows still pending ${ok(genuineKept)}`,
  );
  const before = P.stateDigest(e.handle);
  const again = P.drainOnePass(ctx, e.projectId, B);
  const after = P.stateDigest(e.handle);
  out.push(
    `second full pass: ${again.runs.length} runs, examined ${again.decisions.length}, drained ${again.decisions.filter((d: any) => d.verdict === 'drained').length}`,
    `  memory_relations digest ${before.relations} -> ${after.relations}; consolidation_ops digest ${before.ops} -> ${after.ops}; consolidation_runs ${before.runs} -> ${after.runs} (one bookkeeping row per run)`,
    `  idempotent (relations and journal unchanged): ${ok(before.relations === after.relations && before.ops === after.ops)}`,
    '',
  );
  e.handle.close();
}

{
  const e = env('v5');
  const f1 = e.noisePair({ target: false });
  const f2 = e.noisePair();
  const f2target = e.save(words(seedCounter + 810_000, 12).join(' '), { topicKey: 'topic/f2' });
  const f2b = { s: f2.s, t: f2target, rel: e.pend(f2.s, f2target) };
  e.save(words(seedCounter + 820_000, 12).join(' '), { topicKey: 'topic/f2' });
  const f3 = e.noisePair();
  e.repos.memory.archiveActive([f3.s.id]);
  const f4 = e.noisePair();
  const f5 = e.noisePair();
  const f6 = e.noisePair();
  const c1 = e.noisePair();
  const c2 = e.noisePair();
  const statuses = e.repos.memory.unsafeGetByIds([f2target.id, f3.s.id]);
  const spy = P.throwingEmbedder();
  // VERIFICATION READ (raw, read-only)
  const vecCount = () => e.handle.raw.prepare('SELECT count(*) AS n FROM memory_vec').get().n;
  const vecOf = (id: string) =>
    e.handle.raw.prepare('SELECT count(*) AS n FROM memory_vec WHERE memory_id = ?').get(id).n;
  const vecBefore = vecCount();
  const throwingEntities = new Proxy(e.repos.entities, {
    get(target, prop, receiver) {
      if (prop === 'findEntitiesForMemories') {
        return (ids: string[]) => {
          if (ids.includes(f4.s.id)) throw new Error('simulated read failure');
          return target.findEntitiesForMemories(ids);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const droppingMemory = new Proxy(e.repos.memory, {
    get(target, prop, receiver) {
      if (prop === 'unsafeGetByIds') {
        return (ids: string[]) => target.unsafeGetByIds(ids).filter((m: any) => m.id !== f5.t.id);
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const extract = (title: string, content: string) => {
    if (title === f6.s.title) throw new Error('simulated extractor failure');
    return P.core.extractEntities(title, content);
  };
  const repos = { ...e.repos, entities: throwingEntities, memory: droppingMemory };
  const baseReads = P.createReads(e.handle);
  const reads = {
    ...baseReads,
    endpointRows: (a: string, b: string, max: number) =>
      baseReads.endpointRows(a, b, max).filter((m: any) => m.id !== f5.t.id),
  };
  const pass = P.drainOnePass(
    P.createContext(e.handle, { repos, reads, embedder: spy.embedder, extract }),
    e.projectId,
    100,
  );
  out.push(
    '## validation 5 — fail-safe and retired endpoints (one run, B = 100, a throwing spy embedder in the context)',
    `setup check: f2 target status ${statuses.find((m: any) => m.id === f2target.id)?.status}, f3 source status ${statuses.find((m: any) => m.id === f3.s.id)?.status}; f1 target has a vector: ${vecOf(f1.t.id) === 1}`,
    `runs ${pass.runs.length}, examined ${pass.runs[0]?.examined} of ${pass.runs[0]?.selected} selected — the run continued past the throws: ${ok(pass.runs.length === 1 && pass.runs[0].examined === pass.runs[0].selected)}`,
    `  f1 missing target vector        -> ${verdictOf(pass, f1.rel.judgmentId)}`,
    `  f2 superseded target            -> ${verdictOf(pass, f2b.rel.judgmentId)}`,
    `  f2 other pair, both active      -> ${verdictOf(pass, f2.rel.judgmentId)}`,
    `  f3 archived source              -> ${verdictOf(pass, f3.rel.judgmentId)}`,
    `  f4 entity read throws           -> ${verdictOf(pass, f4.rel.judgmentId)}`,
    `  f5 target row cannot be read    -> ${verdictOf(pass, f5.rel.judgmentId)}`,
    `  f6 entity extraction throws     -> ${verdictOf(pass, f6.rel.judgmentId)}`,
    `  c1 control                      -> ${verdictOf(pass, c1.rel.judgmentId)}`,
    `  c2 control                      -> ${verdictOf(pass, c2.rel.judgmentId)}`,
    `  retired drains journaled with the 'endpoint retired' prefix: ${e.handle.raw.prepare("SELECT count(*) AS n FROM consolidation_ops WHERE reasoning LIKE 'orphaned: endpoint retired:%'").get().n} (expected 2)`,
    `missing vector not embedded on the fly: spy embedder calls ${spy.calls()}, f1 target vectors ${vecOf(f1.t.id)}, memory_vec rows ${vecBefore} -> ${vecCount()}: ${ok(spy.calls() === 0 && vecOf(f1.t.id) === 0 && vecCount() === vecBefore)}`,
  );
  const plain = P.drainOnePass(P.createContext(e.handle), e.projectId, 100);
  out.push(
    `controls (must drain) without the injected failures: f4 -> ${verdictOf(plain, f4.rel.judgmentId)}; f5 -> ${verdictOf(plain, f5.rel.judgmentId)}; f6 -> ${verdictOf(plain, f6.rel.judgmentId)}`,
  );
  const v = unitVector(424242);
  e.repos.vectors.insertEmbedding(
    f1.t.id,
    Buffer.from(v.buffer),
    P.db.partitionKeyFor(e.projectId),
  );
  const withVector = P.drainOnePass(P.createContext(e.handle), e.projectId, 100);
  out.push(
    `control (must drain): f1 after its target vector is stored -> ${verdictOf(withVector, f1.rel.judgmentId)}`,
  );
  const retiredOps = e.handle.raw
    .prepare(
      "SELECT id FROM consolidation_ops WHERE reasoning LIKE 'orphaned: endpoint retired:%' AND reverted_at IS NULL",
    )
    .all();
  for (const op of retiredOps) P.core.undoOp(e.repos, e.handle.db, op.id);
  const fresh = e.noisePair();
  e.repos.memory.archiveActive([fresh.t.id]);
  const afterUndo = P.drainOnePass(P.createContext(e.handle), e.projectId, 100);
  out.push(
    `undone retired drains (${retiredOps.length} ops reverted with undoOp) on the next pass: f2 -> ${verdictOf(afterUndo, f2b.rel.judgmentId)}; f3 -> ${verdictOf(afterUndo, f3.rel.judgmentId)}`,
    `control (must drain): a new pair with an archived target -> ${verdictOf(afterUndo, fresh.rel.judgmentId)}`,
    '',
  );
  e.handle.close();
}

{
  const e = env('v5b');
  const pairs = Array.from({ length: 5 }, () => e.noisePair());
  const genuine = e.genuinePair();
  let calls = 0;
  const stale = P.drainOnePass(
    P.createContext(e.handle, {
      vectorIndexCurrent: () => {
        calls += 1;
        return false;
      },
    }),
    e.projectId,
    100,
  );
  const keptByIndex = pairs.filter(
    (p) => verdictOf(stale, p.rel.judgmentId) === 'kept (fail-safe:vector-index-not-current)',
  ).length;
  out.push(
    '## validation 5b — injected vectorIndexCurrent() predicate (review B2)',
    `predicate returns false: ${keptByIndex}/5 noise pairs kept as fail-safe:vector-index-not-current; genuine lexical pair -> ${verdictOf(stale, genuine.rel.judgmentId)}; predicate calls ${calls} for ${stale.runs.length} run(s): ${ok(keptByIndex === 5)}`,
  );
  const current = P.drainOnePass(
    P.createContext(e.handle, { vectorIndexCurrent: () => true }),
    e.projectId,
    100,
  );
  const drainedNow = pairs.filter(
    (p) => verdictOf(current, p.rel.judgmentId) === 'drained (drained:stale)',
  ).length;
  out.push(
    `control (must drain): predicate returns true -> ${drainedNow}/5 noise pairs drained: ${ok(drainedNow === 5)}`,
    '',
  );
  e.handle.close();
}

{
  const e = env('v5c');
  const projectB = new P.core.ProjectsService(e.repos).create({
    slug: 'v5c-b',
    displayName: 'v5c-b',
  });
  const scopeB = P.db.projectScope(projectB.id);
  const memB = new P.core.MemoryService(e.repos, e.handle.db, e.clock.now);
  const saveB = (content: string) => {
    e.clock.advance(1000);
    const seed = seedCounter++;
    const { memory: m } = memB.saveWithTopicKey(
      { type: 'project', title: `b ${seed}`, content },
      scopeB,
    );
    const v = unitVector(seed);
    e.repos.vectors.insertEmbedding(m.id, Buffer.from(v.buffer), P.db.partitionKeyFor(projectB.id));
    e.repos.entities.linkMemory(
      m.id,
      projectB.id,
      P.core.extractEntities(m.title, m.content),
      m.createdAt,
    );
    return m;
  };
  for (let i = 0; i < 10; i += 1) e.noisePair();
  for (let i = 0; i < 10; i += 1) {
    const t = saveB(words(seedCounter + 610_000, 12).join(' '));
    const s = saveB(words(seedCounter + 620_000, 12).join(' '));
    e.clock.advance(1000);
    e.relations.createPending({ sourceId: s.id, targetId: t.id });
  }
  let fake = 0;
  const clock = () => (fake += 10);
  const ctx = P.createContext(e.handle, { clock });
  const cursors = new Map<string, string | null>();
  const sweep = P.runSweep(ctx, [e.projectId, projectB.id], { cap: 100, budgetMs: 45, cursors });
  const [ra, rb] = sweep.runs;
  fake = 0;
  const control = P.runDrain(P.createContext(e.handle, { clock }), {
    projectId: projectB.id,
    batch: 100,
    cursor: cursors.get(projectB.id)!,
    budgetMs: 45,
  });
  // VERIFICATION READ (raw, read-only)
  const summary = e.handle.raw
    .prepare('SELECT summary FROM consolidation_runs WHERE id = ?')
    .get(ra.runId).summary;
  out.push(
    '## validation 5c — one budget shared by a sweep call, at least one pair per run, nested summary (design D7; injected clock advancing 10 per read)',
    `sweep over 2 scopes, budget 45: scope A examined ${ra.examined} (stop ${ra.stopReason}), scope B examined ${rb.examined} (stop ${rb.stopReason}) — B still progressed by exactly one pair: ${ok(ra.examined > 1 && rb.examined === 1)}`,
    `control: scope B alone with its own 45 budget examined ${control.examined}: ${ok(control.examined > 1)}`,
    `run summary written by finishRun: ${summary}`,
    '',
  );
  e.handle.close();
}

{
  const e = env('v6');
  const a1 = e.noisePair();
  const a2 = e.noisePair();
  const a3 = e.noisePair();
  const a4 = e.noisePair();
  const failingJournal = new Proxy(e.repos.consolidation, {
    get(target, prop, receiver) {
      if (prop === 'insertOp') {
        return (values: any) => {
          if (values.createdId === a1.rel.judgmentId) throw new Error('simulated journal failure');
          return target.insertOp(values);
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });
  const repos = { ...e.repos, consolidation: failingJournal };
  const hooks = {
    beforeWrite: (pair: any) => {
      if (pair.judgmentId === a3.rel.judgmentId) {
        e.relations.judge(a3.rel.judgmentId, {
          relation: 'related',
          actor: 'concurrent-agent',
          kind: 'agent',
          reason: 'judged between selection and drain',
        });
      }
    },
  };
  const pass = P.drainOnePass(P.createContext(e.handle, { repos, hooks }), e.projectId, 100);
  const r1 = relRow(e.handle, a1.rel.judgmentId);
  const r3 = relRow(e.handle, a3.rel.judgmentId);
  out.push(
    '## validation 6 — atomicity and concurrency (one run, B = 100)',
    `  a1 journal insert throws -> ${verdictOf(pass, a1.rel.judgmentId)}; relation ${r1.status}, drain ops ${opsFor(e.handle, a1.rel.judgmentId)}: ${ok(r1.status === 'pending' && opsFor(e.handle, a1.rel.judgmentId) === 0)} (rolled back)`,
    `  a2 control              -> ${verdictOf(pass, a2.rel.judgmentId)}; drain ops ${opsFor(e.handle, a2.rel.judgmentId)}`,
    `  a3 judged before write  -> ${verdictOf(pass, a3.rel.judgmentId)}; relation ${r3.status}/${r3.relation} by ${r3.markedByKind}, drain ops ${opsFor(e.handle, a3.rel.judgmentId)}: ${ok(r3.status === 'judged' && r3.relation === 'related' && opsFor(e.handle, a3.rel.judgmentId) === 0)}`,
    `  a4 control              -> ${verdictOf(pass, a4.rel.judgmentId)}; drain ops ${opsFor(e.handle, a4.rel.judgmentId)}`,
  );
  const retry = P.drainOnePass(P.createContext(e.handle), e.projectId, 100);
  out.push(
    `control (must drain): a1 on the next pass without the failing journal -> ${verdictOf(retry, a1.rel.judgmentId)}; relation ${relRow(e.handle, a1.rel.judgmentId).status}, drain ops ${opsFor(e.handle, a1.rel.judgmentId)}`,
    '',
  );
  e.handle.close();
}

{
  const e = env('gap');
  const t = e.save(`${words(seedCounter + 100, 10).join(' ')} see src/lib/session-store.ts`);
  const s = e.save(`${words(seedCounter + 200, 10).join(' ')} changed src/lib/session-store.ts`);
  const g1 = { s, t, rel: e.pend(s, t) };
  const n1 = e.noisePair();
  const v1 = P.createContext(e.handle, { rules: P.RULES_V1 });
  const v2 = P.createContext(e.handle);
  const dry = (ctx: any, rel: any, amend: any = {}) =>
    P.keepReason(P.recheckPair(ctx, rel, e.projectId, { amend }), ctx.rules) ?? 'DRAIN';
  const worker = new P.core.EntityBackfillWorker({ repos: e.repos, tx: e.handle.db });
  const row = (label: string) => {
    out.push(
      `  ${label.padEnd(38)} g1: v1 ${dry(v1, g1.rel).padEnd(6)} v1+scan-guard ${dry(v1, g1.rel, { entityScanGuard: true }).padEnd(36)} v2 ${dry(v2, g1.rel).padEnd(7)}| n1: v1 ${dry(v1, n1.rel).padEnd(6)} v1+scan-guard ${dry(v1, n1.rel, { entityScanGuard: true }).padEnd(36)} v2 ${dry(v2, n1.rel)}`,
    );
  };
  out.push(
    '## probe A — entity channel during an entity-index reset',
    'g1 = a genuine pair only the entity channel admits (shared path src/lib/session-store.ts, unrelated wording and vectors); n1 = a noise pair; dry re-checks (no write)',
    'v1 = stored links only (the first rules); v1+scan-guard = the amendment proposed under v1; v2 = v3 here = stored links OR re-extraction (review B3)',
  );
  row('index intact (control: g1 kept)');
  worker.resetIndex();
  row('after EntityBackfillWorker.resetIndex()');
  worker.processBatch({ force: true });
  row('after the backfill re-scans');
  worker.resetIndex();
  const real = P.drainOnePass(v2, e.projectId, 100);
  out.push(
    `  real v3 pass inside the reset window: g1 -> ${verdictOf(real, g1.rel.judgmentId)}; n1 -> ${verdictOf(real, n1.rel.judgmentId)}`,
    '  (the v1 run of this probe, kept in v1-mechanics.txt, wrote the false drain of g1 inside the window)',
    '',
  );
  e.handle.close();
}

{
  const e = env('undo');
  const pairs = Array.from({ length: 5 }, () => e.noisePair());
  const ctx = P.createContext(e.handle);
  const p1 = P.drainOnePass(ctx, e.projectId, 100);
  P.core.undoRun(e.repos, e.handle.db, p1.runs[0].runId);
  const p2 = P.drainOnePass(P.createContext(e.handle, { rules: P.RULES_V2 }), e.projectId, 100);
  const redrained = p2.decisions.filter((d: any) => d.verdict === 'drained').length;
  P.core.undoRun(e.repos, e.handle.db, p2.runs[0].runId);
  const fresh = e.noisePair();
  const p3 = P.drainOnePass(ctx, e.projectId, 100);
  const undoneKept = pairs.filter((p) =>
    verdictOf(p3, p.rel.judgmentId).startsWith('kept (excluded:operator-undo)'),
  ).length;
  out.push(
    '## validation 7b — undo is final for the drain (rules v3, design D7; this was probe B under v2)',
    `v3 pass 1 drained ${p1.decisions.filter((d: any) => d.verdict === 'drained').length}/5 stale pairs; undoRun; a v2 pass re-drained ${redrained}/5 (the v2 behaviour); undoRun again`,
    `v3 pass 3: undone rows excluded ${undoneKept}/5: ${ok(undoneKept === 5)}; control (must drain) a new noise pair -> ${verdictOf(p3, fresh.rel.judgmentId)}`,
  );
  const old = e.noisePair();
  const runner = new P.core.ConsolidationRunner({
    repos: e.repos,
    tx: e.handle.db,
    relations: new P.core.RelationsService(e.repos, e.handle.db),
    projects: { getDefault: () => ({ id: e.projectId }) },
    agentSessions: { purgeEmpty: () => ({ deletedIds: [] }) },
  });
  const first = runner.runScope({ projectId: e.projectId });
  const deadlineOp = e.repos.consolidation
    .listActiveOps(first.runId)
    .find((op: any) => op.createdId === old.rel.judgmentId);
  if (deadlineOp) P.core.undoOp(e.repos, e.handle.db, deadlineOp.id);
  const afterUndo = relRow(e.handle, old.rel.judgmentId).status;
  const drainAfterDeadlineUndo = P.drainOnePass(ctx, e.projectId, 100);
  out.push(
    `a v3 drain pass after an undone DEADLINE orphan op: that row -> ${verdictOf(drainAfterDeadlineUndo, old.rel.judgmentId)} (the exclusion keys on any reverted orphan_promote op)`,
  );
  runner.runScope({ projectId: e.projectId });
  out.push(
    `context, the existing deadline step (unchanged by the drain): runScope orphans a pending row older than 14 days (${first.ops.orphaned} orphaned in that run, this row included: ${deadlineOp ? 'yes' : 'no'}); undoOp restores it to ${afterUndo}; the next runScope orphans it again -> ${relRow(e.handle, old.rel.judgmentId).status}`,
  );
  e.handle.close();
}

console.log(out.join('\n'));
