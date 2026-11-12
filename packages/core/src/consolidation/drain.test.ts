import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  consolidationOps,
  createDiagnostics,
  createRepositories,
  partitionKeyFor,
  projectScope,
  type ConsolidationOp,
  type Repositories,
  type Scope,
} from '@rembric/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';

import {
  CANDIDATE_POOL_SIZE,
  ConsolidationRunner,
  DRAIN_BUDGET_MS,
  DRAIN_MAX_PAIR_CHARS,
  DRAIN_ROW_CAP,
  findSaveTimeCandidates,
  loadEmbedder,
  MemoryService,
  ProjectsService,
  RelationsService,
  undoOp,
  type ConsolidationRunnerOptions,
} from '@rembric/core';

import type * as EmbedderModule from '../embeddings/embedder.js';
import type * as EntitiesModule from '../services/entities.js';
import { doctorReport } from '../test-support/doctor.js';
import { createTestDb, defaultProject, type TestDb } from '../test-support/index.js';

const control = vi.hoisted(() => ({ extractThrowsOn: null as string | null, embedderLoads: 0 }));

vi.mock('../services/entities.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EntitiesModule>();
  return {
    ...actual,
    extractEntities: (title: string, content: string) => {
      if (control.extractThrowsOn !== null && content.includes(control.extractThrowsOn)) {
        throw new Error('extractor failed');
      }
      return actual.extractEntities(title, content);
    },
  };
});

vi.mock('../embeddings/embedder.js', async (importOriginal) => {
  const actual = await importOriginal<typeof EmbedderModule>();
  return {
    ...actual,
    loadEmbedder: () => {
      control.embedderLoads++;
      throw new Error('the embedding model was loaded');
    },
  };
});

let db: TestDb;
let repos: Repositories;
let memorySvc: MemoryService;
let relations: RelationsService;
let pendings: RelationsService;
let projectsSvc: ProjectsService;
let scope: Scope;
let seq = 0;

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
  memorySvc = new MemoryService(repos, db.handle.db);
  relations = new RelationsService(repos, db.handle.db);
  let tick = Date.now() - 3_600_000;
  pendings = new RelationsService(repos, db.handle.db, () => new Date(tick++));
  projectsSvc = new ProjectsService(repos);
  scope = projectScope(defaultProject(db.handle).id);
  control.extractThrowsOn = null;
  control.embedderLoads = 0;
  seq = 0;
});

afterEach(() => db.cleanup());

function runner(overrides: Partial<ConsolidationRunnerOptions> = {}): ConsolidationRunner {
  return new ConsolidationRunner({
    repos,
    tx: db.handle.db,
    relations,
    projects: projectsSvc,
    agentSessions: { purgeEmpty: () => ({ deletedIds: [] }) },
    vectorIndexCurrent: () => true,
    drainClock: () => 0,
    ...overrides,
  });
}

function axis(i: number): Buffer {
  const v = new Float32Array(768);
  v[i] = 1;
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function remember(
  content: string,
  opts: { scope?: Scope; vector?: Buffer | null; title?: string } = {},
): { id: string } {
  const s = opts.scope ?? scope;
  const m = memorySvc.save({ type: 'project', title: opts.title ?? `entry ${++seq}`, content }, s);
  if (opts.vector !== null) {
    repos.vectors.insertEmbedding(m.id, opts.vector ?? axis(0), partitionKeyFor(s.projectId));
  }
  return m;
}

interface Pair {
  sourceId: string;
  targetId: string;
  judgmentId: string;
}

function pending(sourceId: string, targetId: string): Pair {
  const row = pendings.createPending({ sourceId, targetId });
  return { sourceId, targetId, judgmentId: row.judgmentId };
}

function drainablePair(opts: { scope?: Scope; targetVector?: Buffer | null } = {}): Pair {
  const n = ++seq;
  const target = remember(`tango${n} uniform${n} victor${n}`, {
    scope: opts.scope,
    vector: opts.targetVector === undefined ? axis(1) : opts.targetVector,
    title: `topic ${n}`,
  });
  const source = remember(`alpha${n} bravo${n} charlie${n}`, {
    scope: opts.scope,
    vector: axis(0),
    title: `subject ${n}`,
  });
  return pending(source.id, target.id);
}

function vectorAt(cosine: number): Buffer {
  const v = new Float32Array(768);
  v[0] = cosine;
  v[1] = Math.sqrt(1 - cosine * cosine);
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

function sharedEntityPair(targetVector: Buffer | null): Pair {
  const p = drainablePair({ targetVector });
  for (const id of [p.sourceId, p.targetId]) {
    repos.entities.linkMemory(
      id,
      scope.projectId,
      [{ kind: 'ticket', value: `LOW-${seq}` }],
      new Date(),
    );
  }
  return p;
}

function keptUnknownPair(): Pair {
  return drainablePair({ targetVector: null });
}

function lexicalPair(): Pair {
  const n = ++seq;
  const target = remember(`deploy freeze friday kept${n}`, { vector: axis(1) });
  const source = remember('deploy freeze friday', { vector: axis(0) });
  return pending(source.id, target.id);
}

function statusOf(p: Pair): string | undefined {
  return repos.relations.findByJudgmentId(p.judgmentId)?.status;
}

function opsFor(p: Pair): ConsolidationOp[] {
  return db.handle.db
    .select()
    .from(consolidationOps)
    .where(eq(consolidationOps.createdId, p.judgmentId))
    .all();
}

interface DrainBlock {
  cursor: { createdAt: number; judgmentId: string } | null;
  examined: number;
  drainedRules: number;
  drainedRetired: number;
  keptAdmitted: number;
  keptUnknown: number;
}

function lastSummary(s: Scope = scope): { archives: number; orphaned: number; drain: DrainBlock } {
  const raw = repos.consolidation.latestFinishedRunSummary(`project:${s.projectId}`);
  if (raw === null) throw new Error('no finished run');
  return JSON.parse(raw) as { archives: number; orphaned: number; drain: DrainBlock };
}

function keyOf(p: Pair): { createdAt: number; judgmentId: string } {
  const rel = repos.relations.findByJudgmentId(p.judgmentId)!;
  return { createdAt: rel.createdAt.getTime(), judgmentId: rel.judgmentId };
}

/** Fake time advances by `stepMs` per evaluated pair, however often the step reads the clock. */
function pairPacedClock(stepMs: number): { drainClock: () => number; repos: Repositories } {
  let now = 0;
  const memoryRepo = Object.create(repos.memory) as Repositories['memory'];
  memoryRepo.findBoundedEndpoints = (o) => {
    now += stepMs;
    return repos.memory.findBoundedEndpoints(o);
  };
  return { drainClock: () => now, repos: { ...repos, memory: memoryRepo } };
}

function sweepOnce(r: ConsolidationRunner = runner(), s: Scope = scope) {
  return r.runScope({ projectId: s.projectId });
}

describe('drain — which pairs it orphans', () => {
  it('drains a pair no channel admits, journaled with the rules prefix and one timestamp', () => {
    const p = drainablePair();
    const pastClock = new RelationsService(repos, db.handle.db, () => new Date(1_000));
    const result = sweepOnce(runner({ relations: pastClock }));

    const rel = repos.relations.findByJudgmentId(p.judgmentId)!;
    expect(rel.status).toBe('orphaned');
    expect(rel.markedByKind).toBe('consolidator');
    expect(rel.reason).toMatch(/^stale under current rules: /);
    const ops = opsFor(p);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      opType: 'orphan_promote',
      runId: result.runId,
      affectedIds: [p.sourceId, p.targetId],
      createdId: p.judgmentId,
    });
    expect(ops[0]!.reasoning).toMatch(/^orphaned: stale under current rules: /);
    expect(rel.judgedAt!.getTime()).toBe(ops[0]!.appliedAt.getTime());
  });

  it('keeps a lexically admitted pair', () => {
    const p = lexicalPair();
    sweepOnce();
    expect(statusOf(p)).toBe('pending');
    expect(opsFor(p)).toEqual([]);
    expect(lastSummary().drain.keptAdmitted).toBe(1);
  });

  it('keeps a vector-admitted pair', () => {
    const p = drainablePair({ targetVector: axis(0) });
    sweepOnce();
    expect(statusOf(p)).toBe('pending');
    expect(lastSummary().drain.keptAdmitted).toBe(1);
  });

  it('keeps a pair sharing an entity the rarity gate would block', () => {
    for (let i = 0; i < 6; i++) {
      const m = remember(`ticket filler ${i}`, { vector: null });
      repos.entities.linkMemory(
        m.id,
        scope.projectId,
        [{ kind: 'ticket', value: 'PROJ-1' }],
        new Date(),
      );
    }
    const p = drainablePair({ targetVector: vectorAt(0.72) });
    for (const id of [p.sourceId, p.targetId]) {
      repos.entities.linkMemory(
        id,
        scope.projectId,
        [{ kind: 'ticket', value: 'PROJ-1' }],
        new Date(),
      );
    }
    const [source] = repos.memory.unsafeGetByIds([p.sourceId]);
    const detected = findSaveTimeCandidates(repos, source!, { perSaveMax: 50 }, [
      { kind: 'ticket', value: 'PROJ-1' },
    ]).candidates;
    expect(detected.some((c) => c.targetId === p.targetId)).toBe(false);

    sweepOnce();
    expect(statusOf(p)).toBe('pending');
    expect(lastSummary().drain.keptAdmitted).toBe(1);
  });

  it("keeps a pair outside today's pool and cap", () => {
    for (let i = 0; i < CANDIDATE_POOL_SIZE + 5; i++)
      remember('deploy freeze friday', { vector: null });
    const filler = Array.from({ length: 60 }, (_, i) => `filler${i}`).join(' ');
    const target = remember(`deploy freeze friday ${filler}`, { vector: axis(1) });
    const source = remember('deploy freeze friday', { vector: axis(0) });
    const p = pending(source.id, target.id);
    const [saved] = repos.memory.unsafeGetByIds([source.id]);
    expect(
      findSaveTimeCandidates(repos, saved!, { perSaveMax: 5 }).candidates.some(
        (c) => c.targetId === target.id,
      ),
    ).toBe(false);

    sweepOnce();
    expect(statusOf(p)).toBe('pending');
  });

  it('age does not decide: of two pairs created at the same instant only the unadmitted one drains', () => {
    const sameInstant = new RelationsService(
      repos,
      db.handle.db,
      () => new Date(Date.now() - 60_000),
    );
    pendings = sameInstant;
    const admitted = lexicalPair();
    const drainable = drainablePair();
    sweepOnce();
    expect(statusOf(admitted)).toBe('pending');
    expect(statusOf(drainable)).toBe('orphaned');
  });
});

describe('drain — low confidence band', () => {
  it('drains an entity-only pair with a known cosine below the vector threshold', () => {
    const p = sharedEntityPair(vectorAt(0.65));
    sweepOnce();
    expect(statusOf(p)).toBe('orphaned');
    expect(opsFor(p)[0]!.reasoning).toMatch(/^orphaned: low confidence band: /);
    expect(lastSummary().drain.drainedRules).toBe(1);
  });

  it('drains a vector-only pair at 0.72', () => {
    const p = drainablePair({ targetVector: vectorAt(0.72) });
    sweepOnce();
    expect(statusOf(p)).toBe('orphaned');
    expect(opsFor(p)[0]!.reasoning).toMatch(/^orphaned: low confidence band: /);
  });

  it('keeps a vector-only pair at 0.76', () => {
    const p = drainablePair({ targetVector: vectorAt(0.76) });
    sweepOnce();
    expect(statusOf(p)).toBe('pending');
    expect(lastSummary().drain.keptAdmitted).toBe(1);
  });

  it('keeps an entity-only pair whose vector is missing', () => {
    const p = sharedEntityPair(null);
    sweepOnce();
    expect(statusOf(p)).toBe('pending');
    expect(lastSummary().drain.drainedRules).toBe(0);
  });

  it('keeps a lexically admitted pair whose cosine is in the low band', () => {
    const n = ++seq;
    const target = remember(`deploy freeze friday kept${n}`, { vector: vectorAt(0.72) });
    const source = remember('deploy freeze friday', { vector: axis(0) });
    const p = pending(source.id, target.id);
    sweepOnce();
    expect(statusOf(p)).toBe('pending');
  });

  it('keeps a low-cosine pair whose entity extraction fails', () => {
    const n = ++seq;
    const target = remember(`tango${n} boom-fail uniform${n}`, { vector: vectorAt(0.65) });
    const source = remember(`alpha${n} bravo${n} charlie${n}`, { vector: axis(0) });
    const p = pending(source.id, target.id);
    control.extractThrowsOn = 'boom-fail';
    sweepOnce();
    expect(statusOf(p)).toBe('pending');
    expect(lastSummary().drain.keptUnknown).toBe(1);
  });

  it('keeps an entity pair in the dense middle band', () => {
    const p = sharedEntityPair(vectorAt(0.72));
    sweepOnce();
    expect(statusOf(p)).toBe('pending');
  });
});

describe('drain — writes', () => {
  function digest(): string {
    const memories = db.handle.raw.prepare('SELECT * FROM memory ORDER BY id').all();
    const closed = db.handle.raw
      .prepare("SELECT * FROM memory_relations WHERE status != 'pending' ORDER BY id")
      .all();
    return JSON.stringify({ memories, closed });
  }

  it('changes no memory row and no closed relation', () => {
    const judged = drainablePair();
    relations.judge(judged.judgmentId, { relation: 'related', actor: 'test', kind: 'agent' });
    const orphaned = drainablePair();
    relations.orphanByOperator(orphaned.judgmentId);
    const p = drainablePair();
    const before = digest();
    sweepOnce();
    expect(statusOf(p)).toBe('orphaned');
    const after = JSON.parse(digest()) as {
      memories: unknown[];
      closed: { judgment_id: string }[];
    };
    const was = JSON.parse(before) as { memories: unknown[]; closed: { judgment_id: string }[] };
    expect(after.memories).toEqual(was.memories);
    expect(after.closed.filter((r) => r.judgment_id !== p.judgmentId)).toEqual(was.closed);
  });

  function failingJournal(failOn: (n: number) => boolean): Repositories['consolidation'] {
    const consolidation = Object.create(repos.consolidation) as Repositories['consolidation'];
    let n = 0;
    consolidation.insertOp = (values) => {
      if (values.opType === 'orphan_promote' && failOn(++n))
        throw new Error('journal insert failed');
      repos.consolidation.insertOp(values);
    };
    return consolidation;
  }

  it('a failed journal insert leaves the relation pending with no op', () => {
    const p = drainablePair();
    sweepOnce(runner({ repos: { ...repos, consolidation: failingJournal(() => true) } }));
    expect(statusOf(p)).toBe('pending');
    expect(opsFor(p)).toEqual([]);
  });

  it('a failure on the third pair keeps the first two drains and the run continues with the fourth', () => {
    const ps = [drainablePair(), drainablePair(), drainablePair(), drainablePair()];
    sweepOnce(runner({ repos: { ...repos, consolidation: failingJournal((n) => n === 3) } }));
    expect(ps.map(statusOf)).toEqual(['orphaned', 'orphaned', 'pending', 'orphaned']);
    expect(ps.map((p) => opsFor(p).length)).toEqual([1, 1, 0, 1]);
  });
});

describe('drain — fail-safe', () => {
  it('keeps a pair with a missing embedding', () => {
    const p = keptUnknownPair();
    sweepOnce();
    expect(statusOf(p)).toBe('pending');
    expect(lastSummary().drain.keptUnknown).toBe(1);
  });

  it('keeps a pair while the vector index is not current', () => {
    const p = drainablePair();
    sweepOnce(runner({ vectorIndexCurrent: () => false }));
    expect(statusOf(p)).toBe('pending');
    expect(lastSummary().drain.keptUnknown).toBe(1);
  });

  it('a runner built without vectorIndexCurrent drains no pair by the rules, only retired ones', () => {
    const stale = drainablePair();
    const retired = drainablePair();
    repos.memory.archiveOne(retired.targetId);
    sweepOnce(runner({ vectorIndexCurrent: undefined }));
    expect(statusOf(stale)).toBe('pending');
    expect(statusOf(retired)).toBe('orphaned');
  });

  it('calls vectorIndexCurrent once per drain step', () => {
    drainablePair();
    drainablePair();
    let calls = 0;
    sweepOnce(
      runner({
        vectorIndexCurrent: () => {
          calls++;
          return true;
        },
      }),
    );
    expect(calls).toBe(1);
  });

  it('keeps a pair whose entity extraction fails', () => {
    const p = drainablePair();
    control.extractThrowsOn = `tango${seq}`;
    sweepOnce();
    expect(statusOf(p)).toBe('pending');
    expect(lastSummary().drain.keptUnknown).toBe(1);
  });

  it('keeps an oversized pair and still drains an ordinary one', () => {
    const big = remember('x'.repeat(DRAIN_MAX_PAIR_CHARS + 1), { vector: axis(1) });
    const source = remember('lonely source words', { vector: axis(0) });
    const oversized = pending(source.id, big.id);
    const ordinary = drainablePair();
    sweepOnce();
    expect(statusOf(oversized)).toBe('pending');
    expect(statusOf(ordinary)).toBe('orphaned');
  });

  it('keeps a pair whose re-check throws, and the rest of the run continues', () => {
    const broken = drainablePair();
    const ordinary = drainablePair();
    const vectors = Object.create(repos.vectors) as Repositories['vectors'];
    vectors.pairCosineDistance = (projectId, sourceId, targetId) => {
      if (sourceId === broken.sourceId) throw new Error('vector read failed');
      return repos.vectors.pairCosineDistance(projectId, sourceId, targetId);
    };
    sweepOnce(runner({ repos: { ...repos, vectors } }));
    expect(statusOf(broken)).toBe('pending');
    expect(opsFor(broken)).toEqual([]);
    expect(statusOf(ordinary)).toBe('orphaned');
  });
});

describe('drain — retired endpoints', () => {
  it('drains a superseded source and an archived target, undo restores them, and they are not drained again', () => {
    const first = memorySvc.saveWithTopicKey(
      { type: 'project', title: 'Auth model', content: 'auth via sessions', topicKey: 'auth' },
      scope,
    ).memory;
    const other = remember('unrelated counterpart words', { vector: null });
    const supersededSource = pending(first.id, other.id);
    repos.memory.markSuperseded(first.id);
    const archivedTarget = drainablePair();
    repos.memory.archiveOne(archivedTarget.targetId);

    sweepOnce();

    for (const p of [supersededSource, archivedTarget]) {
      expect(statusOf(p)).toBe('orphaned');
      expect(opsFor(p)).toHaveLength(1);
      expect(opsFor(p)[0]!.reasoning).toMatch(/^orphaned: endpoint retired: /);
    }
    expect(opsFor(supersededSource)[0]!.reasoning).toContain('source superseded');
    expect(opsFor(archivedTarget)[0]!.reasoning).toContain('target archived');
    expect(lastSummary().drain.drainedRetired).toBe(2);

    for (const p of [supersededSource, archivedTarget])
      undoOp(repos, db.handle.db, opsFor(p)[0]!.id);
    expect([supersededSource, archivedTarget].map(statusOf)).toEqual(['pending', 'pending']);

    sweepOnce();
    sweepOnce();
    expect([supersededSource, archivedTarget].map(statusOf)).toEqual(['pending', 'pending']);
    expect(opsFor(supersededSource)).toHaveLength(1);
  });

  it('keeps a pair whose endpoint row cannot be read', () => {
    const p = drainablePair();
    const memoryRepo = Object.create(repos.memory) as Repositories['memory'];
    memoryRepo.findBoundedEndpoints = (o) =>
      repos.memory.findBoundedEndpoints(o).filter((r) => r.id !== p.targetId);
    sweepOnce(runner({ repos: { ...repos, memory: memoryRepo } }));
    expect(statusOf(p)).toBe('pending');
    expect(lastSummary().drain.keptUnknown).toBe(1);
  });
});

describe('drain — scope', () => {
  it("another project's memories do not keep a pair", () => {
    const b = projectsSvc.create({ slug: 'project-b' });
    const p = drainablePair();
    const [source] = repos.memory.unsafeGetByIds([p.sourceId]);
    const twin = remember(source!.content, { scope: projectScope(b.id), vector: axis(0) });
    repos.entities.linkMemory(twin.id, b.id, [{ kind: 'ticket', value: 'ABC-9' }], new Date());
    repos.entities.linkMemory(
      p.sourceId,
      scope.projectId,
      [{ kind: 'ticket', value: 'ABC-9' }],
      new Date(),
    );
    sweepOnce();
    expect(statusOf(p)).toBe('orphaned');
  });

  it("one project's backlog does not starve another in the same call, and the budget is shared", () => {
    const a = projectScope(projectsSvc.create({ slug: 'project-a' }).id);
    const b = projectScope(projectsSvc.create({ slug: 'project-b' }).id);
    const inA = Array.from({ length: 4 }, () => drainablePair({ scope: a }));
    const inB = Array.from({ length: 3 }, () => drainablePair({ scope: b }));
    const paced = pairPacedClock(DRAIN_BUDGET_MS / 2);

    const summary = runner(paced).runAll({ force: true });

    const order = summary.runs
      .map((r) => r.scope.projectId)
      .filter((id) => id === a.projectId || id === b.projectId);
    const later = order[1] === b.projectId ? { s: b, pairs: inB } : { s: a, pairs: inA };
    const earlier = later.s === b ? { s: a, pairs: inA } : { s: b, pairs: inB };
    expect(lastSummary(earlier.s).drain.examined).toBeGreaterThanOrEqual(1);
    expect(lastSummary(later.s).drain.examined).toBe(1);
    expect(later.pairs.filter((p) => statusOf(p) === 'orphaned')).toHaveLength(1);
  });

  it('a project with one drainable relation drains it even after another project spent the budget', () => {
    const a = projectScope(projectsSvc.create({ slug: 'project-a' }).id);
    const b = projectScope(projectsSvc.create({ slug: 'project-b' }).id);
    const inA = Array.from({ length: 4 }, () => drainablePair({ scope: a }));
    const onlyB = drainablePair({ scope: b });
    const paced = pairPacedClock(DRAIN_BUDGET_MS / 2);
    runner(paced).runAll({ force: true });
    expect(inA.filter((p) => statusOf(p) === 'orphaned').length).toBeGreaterThanOrEqual(1);
    expect(statusOf(onlyB)).toBe('orphaned');
  });
});

describe('drain — bounds and cursor', () => {
  it('kept rows at the head do not starve later rows', () => {
    const kept = Array.from({ length: DRAIN_ROW_CAP + 10 }, () => lexicalPair());
    const drainable = [drainablePair(), drainablePair(), drainablePair()];
    sweepOnce();
    expect(lastSummary().drain.examined).toBe(DRAIN_ROW_CAP);
    expect(drainable.map(statusOf)).toEqual(['pending', 'pending', 'pending']);
    sweepOnce();
    expect(drainable.map(statusOf)).toEqual(['orphaned', 'orphaned', 'orphaned']);
    expect(kept.every((p) => statusOf(p) === 'pending')).toBe(true);
  });

  it('wraps to the lowest key and reaches a pair that became drainable after the cursor passed it', () => {
    const early = keptUnknownPair();
    const late = [keptUnknownPair(), keptUnknownPair()];
    sweepOnce();
    expect(lastSummary().drain.cursor).toEqual(keyOf(late[1]!));
    repos.vectors.insertEmbedding(early.targetId, axis(1), partitionKeyFor(scope.projectId));
    sweepOnce();
    expect(statusOf(early)).toBe('orphaned');
  });

  it('the budget ends a run after two pairs and the next run resumes at the third', () => {
    const ps = Array.from({ length: 5 }, () => keptUnknownPair());
    const paced = pairPacedClock(DRAIN_BUDGET_MS / 2);
    const r = runner(paced);
    sweepOnce(r);
    expect(lastSummary().drain).toMatchObject({ examined: 2, cursor: keyOf(ps[1]!) });
    sweepOnce(r);
    expect(lastSummary().drain).toMatchObject({ examined: 2, cursor: keyOf(ps[3]!) });
  });

  it('a step that begins with the shared budget spent examines exactly one pair', () => {
    const a = projectScope(projectsSvc.create({ slug: 'project-a' }).id);
    const b = projectScope(projectsSvc.create({ slug: 'project-b' }).id);
    const inA = [drainablePair({ scope: a }), drainablePair({ scope: a })];
    const inB = [
      drainablePair({ scope: b, targetVector: null }),
      drainablePair({ scope: b, targetVector: null }),
    ];
    const paced = pairPacedClock(DRAIN_BUDGET_MS * 2);
    const relationsRepo = Object.create(repos.relations) as Repositories['relations'];
    const limits = new Map<string, number[]>();
    relationsRepo.listExaminablePendingInScope = (o) => {
      limits.set(o.projectId, [...(limits.get(o.projectId) ?? []), o.limit]);
      return repos.relations.listExaminablePendingInScope(o);
    };
    const summary = runner({
      ...paced,
      repos: { ...paced.repos, relations: relationsRepo },
    }).runAll({
      force: true,
    });
    const order = summary.runs
      .map((r) => r.scope.projectId)
      .filter((id) => id === a.projectId || id === b.projectId);
    const [first, second] = order[0] === a.projectId ? [a, b] : [b, a];
    const secondPairs = second === b ? inB : inA;
    expect(lastSummary(first).drain.examined).toBe(1);
    expect(lastSummary(second).drain).toMatchObject({
      examined: 1,
      cursor: keyOf(secondPairs[0]!),
    });
    expect(limits.get(second.projectId)).toEqual([1]);
  });

  it('a first pair slower than the whole budget still completes, and the step stops after it', () => {
    const ps = [keptUnknownPair(), keptUnknownPair(), keptUnknownPair()];
    sweepOnce(runner(pairPacedClock(DRAIN_BUDGET_MS * 10)));
    expect(lastSummary().drain).toMatchObject({ examined: 1, cursor: keyOf(ps[0]!) });
  });

  it('time spent in decay and deadline orphaning does not consume the drain budget', () => {
    Array.from({ length: 5 }, () => keptUnknownPair());
    let now = 0;
    const slowDeadline = Object.create(relations) as RelationsService;
    slowDeadline.findPendingOlderThanInScope = (o) => {
      now += DRAIN_BUDGET_MS * 10;
      return relations.findPendingOlderThanInScope(o);
    };
    sweepOnce(runner({ relations: slowDeadline, drainClock: () => now }));
    expect(lastSummary().drain.examined).toBe(5);
  });

  it('reads the reverted drain ids once per sweep call, not once per project', () => {
    projectsSvc.create({ slug: 'project-a' });
    projectsSvc.create({ slug: 'project-b' });
    const consolidation = Object.create(repos.consolidation) as Repositories['consolidation'];
    let reads = 0;
    consolidation.listRevertedOrphanPromoteCreatedIds = () => {
      reads++;
      return repos.consolidation.listRevertedOrphanPromoteCreatedIds();
    };
    const summary = runner({ repos: { ...repos, consolidation } }).runAll({ force: true });
    expect(summary.runs).toHaveLength(3);
    expect(reads).toBe(1);
  });

  it('a 5 000-row backlog is examined in capped runs that resume from the cursor', () => {
    const sources = Array.from({ length: 100 }, (_, i) =>
      remember(`origin${i} words${i}`, { vector: axis(0) }),
    );
    const targets = Array.from({ length: 50 }, (_, i) =>
      remember(`destination${i} terms${i}`, { vector: axis(1) }),
    );
    for (const s of sources) for (const t of targets) pending(s.id, t.id);

    sweepOnce();
    expect(lastSummary().drain.examined).toBe(DRAIN_ROW_CAP);
    expect(repos.relations.countRowsByStatus().find((r) => r.status === 'pending')?.count).toBe(
      5_000 - DRAIN_ROW_CAP,
    );
    let examined = DRAIN_ROW_CAP;
    let runs = 1;
    while (examined < 5_000) {
      sweepOnce();
      const d = lastSummary().drain;
      expect(d.examined).toBeLessThanOrEqual(DRAIN_ROW_CAP);
      examined += d.examined;
      runs++;
    }
    expect(runs).toBe(Math.ceil(5_000 / DRAIN_ROW_CAP));
    expect(repos.relations.countRowsByStatus().find((r) => r.status === 'pending')).toBeUndefined();
  });
});

describe('drain — undo and the deadline', () => {
  it('an undone drain is never drained again by the drain', () => {
    const p = drainablePair();
    sweepOnce();
    undoOp(repos, db.handle.db, opsFor(p)[0]!.id);
    sweepOnce();
    sweepOnce();
    expect(statusOf(p)).toBe('pending');
    expect(opsFor(p)).toHaveLength(1);
  });

  it('an undone drain that crosses the deadline is orphaned by the deadline step', () => {
    const p = drainablePair();
    const r = runner({ orphanDeadlineMs: 2 * 3_600_000 });
    sweepOnce(r);
    expect(opsFor(p)[0]!.reasoning).toMatch(/^orphaned: stale under current rules: /);
    undoOp(repos, db.handle.db, opsFor(p)[0]!.id);
    db.handle.raw
      .prepare('UPDATE memory_relations SET created_at = ? WHERE judgment_id = ?')
      .run(Date.now() - 3 * 3_600_000, p.judgmentId);
    sweepOnce(r);
    expect(statusOf(p)).toBe('orphaned');
    const live = opsFor(p).filter((o) => o.revertedAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]!.reasoning).toContain('deadline');
  });
});

describe('drain — summary and journal', () => {
  it('a back-to-back run with no writes drains nothing', () => {
    drainablePair();
    drainablePair();
    keptUnknownPair();
    lexicalPair();
    sweepOnce();
    expect(lastSummary().drain.drainedRules).toBe(2);
    sweepOnce();
    expect(lastSummary()).toMatchObject({
      archives: 0,
      orphaned: 0,
      drain: { drainedRules: 0, drainedRetired: 0 },
    });
  });

  it('deadline, rules-drain and retired-endpoint ops carry three different reasoning prefixes', () => {
    const r = runner({ orphanDeadlineMs: 2 * 3_600_000 });
    const aged = lexicalPair();
    db.handle.raw
      .prepare('UPDATE memory_relations SET created_at = ? WHERE judgment_id = ?')
      .run(Date.now() - 3 * 3_600_000, aged.judgmentId);
    const stale = drainablePair();
    const retired = drainablePair();
    repos.memory.archiveOne(retired.targetId);
    sweepOnce(r);
    const prefixes = [aged, stale, retired].map((p) =>
      opsFor(p)[0]!.reasoning!.split(':')[1]!.trim(),
    );
    expect(prefixes[0]).toMatch(/deadline/);
    expect(prefixes[1]).toBe('stale under current rules');
    expect(prefixes[2]).toBe('endpoint retired');
  });

  it('the summary keeps archives and orphaned on top and nests the cursor and counts under drain', () => {
    const first = drainablePair();
    drainablePair();
    const retired = drainablePair();
    repos.memory.archiveOne(retired.targetId);
    keptUnknownPair();
    lexicalPair();
    sweepOnce();
    const summary = lastSummary();
    expect(Object.keys(summary)).toEqual(['archives', 'orphaned', 'drain']);
    expect(summary.drain).toEqual({
      cursor: summary.drain.cursor,
      examined: 5,
      drainedRules: 2,
      drainedRetired: 1,
      keptAdmitted: 1,
      keptUnknown: 1,
    });
    expect(Object.keys(summary.drain)).toEqual([
      'cursor',
      'examined',
      'drainedRules',
      'drainedRetired',
      'keptAdmitted',
      'keptUnknown',
    ]);
    expect(statusOf(first)).toBe('orphaned');
  });

  it('memory.doctor lastRunOps holds exactly archives and orphaned after a run that drained', () => {
    drainablePair();
    runner().sweepFor(null);
    expect(lastSummary().drain.drainedRules).toBe(1);
    const report = doctorReport(db.handle, db.dataDir, createDiagnostics(db.handle));
    expect(Object.keys(report.consolidation.lastRunOps).sort()).toEqual(['archives', 'orphaned']);
  });
});

describe('drain — no model inference', () => {
  it('decides from stored vectors with the model never loaded, and keeps a pair with no vector', () => {
    expect(() => loadEmbedder()).toThrow('the embedding model was loaded');
    control.embedderLoads = 0;
    const withVectors = drainablePair();
    const withoutVector = keptUnknownPair();
    sweepOnce();
    expect(statusOf(withVectors)).toBe('orphaned');
    expect(statusOf(withoutVector)).toBe('pending');
    expect(control.embedderLoads).toBe(0);
  });

  it('a wiped vector index keeps every pair the lexical and entity checks do not admit', () => {
    const ps = [drainablePair(), drainablePair(), drainablePair()];
    repos.vectors.deleteAll();
    sweepOnce();
    expect(ps.map(statusOf)).toEqual(['pending', 'pending', 'pending']);
    expect(lastSummary().drain.keptUnknown).toBe(3);
  });

  it('the runner options carry no embedder', () => {
    expectTypeOf<keyof ConsolidationRunnerOptions>().toEqualTypeOf<
      | 'repos'
      | 'tx'
      | 'relations'
      | 'projects'
      | 'agentSessions'
      | 'decay'
      | 'orphanDeadlineMs'
      | 'minIntervalMs'
      | 'vectorIndexCurrent'
      | 'drainClock'
    >();
    expectTypeOf<keyof ConsolidationRunnerOptions>().not.toEqualTypeOf<
      | 'repos'
      | 'tx'
      | 'relations'
      | 'projects'
      | 'agentSessions'
      | 'decay'
      | 'orphanDeadlineMs'
      | 'minIntervalMs'
      | 'vectorIndexCurrent'
      | 'drainClock'
      | 'embedder'
    >();
  });

  const here = dirname(fileURLToPath(import.meta.url));

  function valueImportClosure(entry: string): string[] {
    const seen = new Set<string>();
    const stack = [entry];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (seen.has(file)) continue;
      seen.add(file);
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(
        /^(?:import|export)\s+(?!type\s)(?:[^'";]*?\sfrom\s+)?['"](\.{1,2}\/[^'"]+)['"]/gm,
      )) {
        stack.push(resolve(dirname(file), m[1]!).replace(/\.js$/, '.ts'));
      }
    }
    return [...seen];
  }

  const reachesEmbeddings = (entry: string) =>
    valueImportClosure(resolve(here, entry)).filter((f) => f.includes('/embeddings/'));

  it("the drain's import graph reaches no embedding module", () => {
    expect(reachesEmbeddings('./runner.ts')).toEqual([]);
    expect(reachesEmbeddings('../services/save-time-candidates.ts')).toEqual([]);
    expect(valueImportClosure(resolve(here, './runner.ts'))).toContain(
      resolve(here, '../services/save-time-candidates.ts'),
    );
  });

  it('control: the same scan detects the embedding import of the embedding worker', () => {
    expect(reachesEmbeddings('../services/embedding-worker.ts').length).toBeGreaterThan(0);
  });
});
