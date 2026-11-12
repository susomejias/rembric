import {
  consolidationOps,
  consolidationRuns,
  createRepositories,
  projectScope,
  type ConsolidationOp,
  type NewConsolidationOp,
  type Repositories,
  type Scope,
} from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  applyDecay,
  ConsolidationRunner,
  DRAIN_RETIRED_REASON,
  DRAIN_RULES_REASON,
  MemoryService,
  ProjectsService,
  RelationsService,
  RETIREMENT_ORPHAN_REASON,
  undoOp,
} from '@rembric/core';

import { createTestDb, type TestDb, TestClock } from '../test-support/index.js';

const DAY = 86_400_000;

let db: TestDb;
let repos: Repositories;
let clock: TestClock;
let scope: Scope;
let memory: MemoryService;
let relations: RelationsService;

beforeEach(() => {
  db = createTestDb();
  clock = new TestClock();
  repos = createRepositories(db.handle.db);
  scope = projectScope(new ProjectsService(repos, clock.now).create({ slug: 'app' }).id);
  memory = new MemoryService(repos, db.handle.db, clock.now);
  relations = new RelationsService(repos, db.handle.db, clock.now);
});

afterEach(() => db.cleanup());

function save(title: string, topicKey?: string) {
  clock.advance(1_000);
  return memory.save(
    { type: 'project', title, content: `${title} body`, ...(topicKey ? { topicKey } : {}) },
    scope,
  );
}

function pending(sourceId: string, targetId: string): string {
  clock.advance(1_000);
  return relations.createPending({ sourceId, targetId }).judgmentId;
}

const rel = (judgmentId: string) => repos.relations.findByJudgmentId(judgmentId)!;
const status = (id: string) => repos.memory.unsafeGetById(id)!.status;
const allOps = (): ConsolidationOp[] => db.handle.db.select().from(consolidationOps).all();
const orphanOps = () => allOps().filter((o) => o.opType === 'orphan_promote');
const opById = (id: string) => allOps().find((o) => o.id === id)!;
const opsOfType = (opType: string) => allOps().filter((o) => o.opType === opType);
const runs = () => db.handle.db.select().from(consolidationRuns).all();
const runOf = (runId: string) => runs().find((r) => r.id === runId)!;

function opFor(judgmentId: string): ConsolidationOp {
  const ops = orphanOps().filter((o) => o.createdId === judgmentId);
  expect(ops).toHaveLength(1);
  return ops[0]!;
}

function expectRetirementOrphan(judgmentId: string, runId?: string): ConsolidationOp {
  const r = rel(judgmentId);
  expect(r.status).toBe('orphaned');
  expect(r.markedByKind).toBe('consolidator');
  expect(r.reason?.startsWith(`${RETIREMENT_ORPHAN_REASON}: `)).toBe(true);
  const op = opFor(judgmentId);
  expect(op.reasoning?.startsWith(`orphaned: ${RETIREMENT_ORPHAN_REASON}: `)).toBe(true);
  expect(op.affectedIds).toEqual([r.sourceId, r.targetId]);
  expect(op.appliedAt.getTime()).toBe(r.judgedAt!.getTime());
  if (runId !== undefined) expect(op.runId).toBe(runId);
  return op;
}

function expectRetirementRun(runId: string, orphaned: number): void {
  const run = runOf(runId);
  expect(run.scope).toBe('maintenance');
  expect(JSON.parse(run.summary!)).toEqual({ kind: 'retirement_orphan', orphaned });
}

function mergeInput(ids: string[]) {
  return { ids, type: 'project' as const, title: 'merged', content: 'merged body', tags: [] };
}

function commitMerge(ids: string[], svc: MemoryService = memory) {
  const input = mergeInput(ids);
  const { fingerprint } = svc.previewMerge(input, scope);
  clock.advance(1_000);
  return svc.commitMerge(input, scope, fingerprint);
}

function sweepRunner(rels: RelationsService, extra: { orphanDeadlineMs?: number } = {}) {
  return new ConsolidationRunner({
    repos,
    tx: db.handle.db,
    relations: rels,
    projects: new ProjectsService(repos),
    agentSessions: { purgeEmpty: () => ({ deletedIds: [] }) },
    decay: { thresholdByType: {}, defaultThresholdMs: DAY, confidenceFloor: 1 },
    ...extra,
  });
}

function backdateLastSeen(id: string, msAgo: number): void {
  db.handle.raw
    .prepare('UPDATE memory SET last_seen_at = ? WHERE id = ?')
    .run(Date.now() - msAgo, id);
}

describe('orphan at retirement — every retirement path', () => {
  it('a topic_key revision orphans the superseded memory’s pending judgments on both sides', () => {
    const a = save('auth model', 'auth');
    const x = save('x');
    const y = save('y');
    const outgoing = pending(a.id, x.id);
    const incoming = pending(y.id, a.id);
    const unrelated = pending(x.id, y.id);

    clock.advance(1_000);
    const { memory: next } = memory.saveWithTopicKey(
      { type: 'project', title: 'auth model', content: 'auth v2', topicKey: 'auth' },
      scope,
    );

    expect(status(a.id)).toBe('superseded');
    const out = expectRetirementOrphan(outgoing);
    const inc = expectRetirementOrphan(incoming, out.runId);
    expect(rel(outgoing).judgedAt!.getTime()).toBe(next.createdAt.getTime());
    expect(out.reasoning).toContain('source superseded by topic_key revision');
    expect(inc.reasoning).toContain('target superseded by topic_key revision');
    expectRetirementRun(out.runId, 2);
    expect(rel(unrelated).status).toBe('pending');
  });

  it('a supersedes verdict through memory.judge orphans the target’s other pending judgments only', () => {
    const s = save('s');
    const t = save('t');
    const u = save('u');
    const verdict = pending(s.id, t.id);
    const onTarget = pending(t.id, u.id);
    const onSource = pending(s.id, u.id);

    clock.advance(1_000);
    relations.judge(verdict, { relation: 'supersedes', actor: 'agent', kind: 'agent' });

    expect(status(t.id)).toBe('superseded');
    expect(rel(verdict)).toMatchObject({ status: 'judged', relation: 'supersedes' });
    const op = expectRetirementOrphan(onTarget);
    expect(rel(onTarget).judgedAt!.getTime()).toBe(rel(verdict).judgedAt!.getTime());
    expect(op.reasoning).toContain('source superseded by supersedes verdict');
    expectRetirementRun(op.runId, 1);
    expect(rel(onSource).status).toBe('pending');
    expect(orphanOps()).toHaveLength(1);
  });

  it('a supersedes verdict through memory.compare orphans the target’s pending judgments, inserted or in place', () => {
    const s = save('s');
    const t = save('t');
    const u = save('u');
    const onT = pending(u.id, t.id);
    relations.compareInScope(
      { sourceId: s.id, targetId: t.id, relation: 'supersedes', confidence: 1, actor: 'agent' },
      scope,
    );
    expect(status(t.id)).toBe('superseded');
    expectRetirementOrphan(onT);

    const v = save('v');
    const w = save('w');
    const existing = pending(v.id, w.id);
    const onW = pending(w.id, u.id);
    relations.compareInScope(
      { sourceId: v.id, targetId: w.id, relation: 'supersedes', confidence: 1, actor: 'agent' },
      scope,
    );
    expect(status(w.id)).toBe('superseded');
    expect(rel(existing)).toMatchObject({ status: 'judged', relation: 'supersedes' });
    expectRetirementOrphan(onW);
  });

  it('a merge commit orphans every original’s pending judgments in the merge op’s run', () => {
    const a = save('a');
    const b = save('b');
    const x = save('x');
    const y = save('y');
    const onA = pending(a.id, x.id);
    const onB = pending(y.id, b.id);
    const between = pending(a.id, b.id);

    const { opId } = commitMerge([a.id, b.id]);

    const mergeRun = opById(opId).runId;
    for (const j of [onA, onB, between]) expectRetirementOrphan(j, mergeRun);
    expect(opFor(between).reasoning).toContain('source and target superseded by merge');
    expect(orphanOps()).toHaveLength(3);
    expect(JSON.parse(runOf(mergeRun).summary!)).toMatchObject({ kind: 'agent_memory_merge' });
  });

  it('memory.archive, which the dashboard archive actions share, orphans in the archive op’s run', () => {
    const m = save('m');
    const x = save('x');
    const y = save('y');
    const p = pending(m.id, x.id);
    const judged = pending(y.id, m.id);
    relations.judge(judged, { relation: 'related', actor: 'agent', kind: 'agent' });
    const judgedBefore = rel(judged);

    clock.advance(1_000);
    memory.archive(m.id, scope);

    const [archiveOp] = opsOfType('agent_memory_archive');
    const op = expectRetirementOrphan(p, archiveOp!.runId);
    expect(op.appliedAt.getTime()).toBe(archiveOp!.appliedAt.getTime());
    expect(op.reasoning).toContain('source archived by archive');
    expect(rel(judged)).toEqual(judgedBefore);
  });

  it('the decay pass orphans a decayed memory’s pending judgments in the sweep’s run', () => {
    const live = new RelationsService(repos, db.handle.db);
    const m = save('decays');
    const x = save('stays');
    const p = live.createPending({ sourceId: x.id, targetId: m.id }).judgmentId;
    backdateLastSeen(m.id, 2 * DAY);
    backdateLastSeen(x.id, 0);

    const { runId } = sweepRunner(live).runScope({ projectId: scope.projectId });

    expect(status(m.id)).toBe('archived');
    expect(status(x.id)).toBe('active');
    const [decayOp] = opsOfType('decay');
    expect(decayOp!.runId).toBe(runId);
    const op = expectRetirementOrphan(p, runId);
    expect(op.appliedAt.getTime()).toBe(decayOp!.appliedAt.getTime());
    expect(op.reasoning).toContain('target archived by decay');
  });

  it('a merge undo orphans the successor’s pending judgments into a new maintenance run', () => {
    const a = save('a');
    const b = save('b');
    const x = save('x');
    const { memory: successor, opId } = commitMerge([a.id, b.id]);
    const p = pending(successor.id, x.id);
    const mergeRun = opById(opId).runId;

    undoOp(repos, db.handle.db, opId);

    expect(status(successor.id)).toBe('archived');
    const op = expectRetirementOrphan(p);
    expect(op.runId).not.toBe(mergeRun);
    expect(op.reasoning).toContain('source archived by merge undo');
    expectRetirementRun(op.runId, 1);
    expect(allOps().filter((o) => o.runId === mergeRun)).toHaveLength(1);
  });

  it('a pair whose other endpoint is already retired is orphaned too', () => {
    const a = save('a');
    const b = save('b');
    const p = pending(a.id, b.id);
    repos.memory.markSuperseded(b.id);

    memory.archive(a.id, scope);

    const op = expectRetirementOrphan(p);
    expect(op.reasoning).toContain('source archived by archive');
  });

  it('a retirement with nothing pending opens no run and writes no op', () => {
    const a = save('a', 't');
    const s = save('s');
    const t = save('t');
    const verdict = pending(s.id, t.id);

    memory.saveWithTopicKey({ type: 'project', title: 'a', content: 'a v2', topicKey: 't' }, scope);
    relations.judge(verdict, { relation: 'supersedes', actor: 'agent', kind: 'agent' });

    expect(status(a.id)).toBe('superseded');
    expect(status(t.id)).toBe('superseded');
    expect(runs()).toHaveLength(0);
    expect(allOps()).toHaveLength(0);
  });

  it('the retirement prefix differs from the deadline, rules-drain and retired-drain prefixes', () => {
    const live = new RelationsService(repos, db.handle.db);
    const a = save('a');
    const b = save('b');
    const c = save('c');
    const d = save('d');
    const aged = live.createPending({ sourceId: a.id, targetId: b.id }).judgmentId;
    db.handle.raw
      .prepare('UPDATE memory_relations SET created_at = ? WHERE judgment_id = ?')
      .run(Date.now() - 10 * DAY, aged);
    const legacy = live.createPending({ sourceId: c.id, targetId: b.id }).judgmentId;
    repos.memory.markSuperseded(c.id);
    const retiring = live.createPending({ sourceId: d.id, targetId: a.id }).judgmentId;
    memory.archive(d.id, scope);
    backdateLastSeen(a.id, 0);
    backdateLastSeen(b.id, 0);
    sweepRunner(live, { orphanDeadlineMs: DAY }).runScope({ projectId: scope.projectId });

    const prefix = (j: string) =>
      opFor(j)
        .reasoning!.replace(/^orphaned: /, '')
        .split(':')[0];
    expect(prefix(aged)).toMatch(/^unjudged after/);
    expect(prefix(legacy)).toBe(DRAIN_RETIRED_REASON);
    expect(prefix(retiring)).toBe(RETIREMENT_ORPHAN_REASON);
    expect(new Set([prefix(aged), prefix(legacy), prefix(retiring), DRAIN_RULES_REASON]).size).toBe(
      4,
    );
  });
});

describe('orphan at retirement — a failed journal rolls the whole retirement back', () => {
  function failingRepos(): Repositories {
    const consolidation = Object.create(repos.consolidation, {
      insertOp: {
        value: (values: NewConsolidationOp) => {
          if (values.opType === 'orphan_promote') throw new Error('journal down');
          repos.consolidation.insertOp(values);
        },
      },
    }) as Repositories['consolidation'];
    return { ...repos, consolidation };
  }

  function failing() {
    const r = failingRepos();
    return {
      repos: r,
      memory: new MemoryService(r, db.handle.db, clock.now),
      relations: new RelationsService(r, db.handle.db, clock.now),
    };
  }

  function expectUntouched(judgmentId: string, statuses: Record<string, string>): void {
    expect(rel(judgmentId).status).toBe('pending');
    expect(orphanOps()).toHaveLength(0);
    for (const [id, s] of Object.entries(statuses)) expect(status(id)).toBe(s);
  }

  it('topic_key revision', () => {
    const a = save('a', 't');
    const x = save('x');
    const p = pending(a.id, x.id);
    const before = runs().length;
    expect(() =>
      failing().memory.saveWithTopicKey(
        { type: 'project', title: 'a', content: 'a v2', topicKey: 't' },
        scope,
      ),
    ).toThrow('journal down');
    expectUntouched(p, { [a.id]: 'active' });
    expect(
      repos.memory.findActiveByTopicKey({ projectId: scope.projectId, topicKey: 't' })!.id,
    ).toBe(a.id);
    expect(runs()).toHaveLength(before);
  });

  it('supersedes verdict through memory.judge', () => {
    const s = save('s');
    const t = save('t');
    const u = save('u');
    const verdict = pending(s.id, t.id);
    const p = pending(t.id, u.id);
    expect(() =>
      failing().relations.judge(verdict, { relation: 'supersedes', actor: 'a', kind: 'agent' }),
    ).toThrow('journal down');
    expectUntouched(p, { [t.id]: 'active' });
    expect(rel(verdict).status).toBe('pending');
    expect(repos.memory.findReplaces(s.id)).toEqual([]);
  });

  it('supersedes verdict through memory.compare', () => {
    const s = save('s');
    const t = save('t');
    const u = save('u');
    const p = pending(u.id, t.id);
    expect(() =>
      failing().relations.compareInScope(
        { sourceId: s.id, targetId: t.id, relation: 'supersedes', confidence: 1, actor: 'a' },
        scope,
      ),
    ).toThrow('journal down');
    expectUntouched(p, { [t.id]: 'active' });
    expect(repos.relations.findBySourceAndTarget(s.id, t.id)).toBeUndefined();
  });

  it('memory.merge commit', () => {
    const a = save('a');
    const b = save('b');
    const x = save('x');
    const p = pending(a.id, x.id);
    expect(() => commitMerge([a.id, b.id], failing().memory)).toThrow('journal down');
    expectUntouched(p, { [a.id]: 'active', [b.id]: 'active' });
    expect(opsOfType('merge')).toHaveLength(0);
  });

  it('memory.archive and the dashboard archive actions', () => {
    const m = save('m');
    const x = save('x');
    const p = pending(m.id, x.id);
    expect(() => failing().memory.archive(m.id, scope)).toThrow('journal down');
    expectUntouched(p, { [m.id]: 'active' });
    expect(opsOfType('agent_memory_archive')).toHaveLength(0);
  });

  it('decay pass', () => {
    const m = save('m');
    const x = save('x');
    const p = pending(m.id, x.id);
    db.handle.db
      .insert(consolidationRuns)
      .values({ id: 'run-1', startedAt: clock.value, scope: `project:${scope.projectId}` })
      .run();
    expect(() =>
      applyDecay(failingRepos(), db.handle.db, { runId: 'run-1', ids: [m.id], reasoning: 'stale' }),
    ).toThrow('journal down');
    expectUntouched(p, { [m.id]: 'active' });
    expect(opsOfType('decay')).toHaveLength(0);
  });

  it('merge undo', () => {
    const a = save('a');
    const b = save('b');
    const x = save('x');
    const { memory: successor, opId } = commitMerge([a.id, b.id]);
    const p = pending(successor.id, x.id);
    expect(() => undoOp(failingRepos(), db.handle.db, opId)).toThrow('journal down');
    expectUntouched(p, { [successor.id]: 'active', [a.id]: 'superseded', [b.id]: 'superseded' });
    expect(opById(opId).revertedAt).toBeNull();
  });
});

describe('orphan at retirement — no stray writes', () => {
  it('only the retired memory changes status; every non-pending relation is untouched', () => {
    const m = save('m');
    const x = save('x');
    const judged = pending(x.id, m.id);
    relations.judge(judged, { relation: 'conflicts_with', actor: 'agent', kind: 'agent' });
    const orphaned = pending(m.id, x.id);
    relations.orphan(orphaned, 'earlier');
    const before = [rel(judged), rel(orphaned)];
    const others = db.handle.raw
      .prepare('SELECT id, status FROM memory WHERE id <> ? ORDER BY id')
      .all(m.id);

    memory.archive(m.id, scope);

    expect([rel(judged), rel(orphaned)]).toEqual(before);
    expect(
      db.handle.raw.prepare('SELECT id, status FROM memory WHERE id <> ? ORDER BY id').all(m.id),
    ).toEqual(others);
    expect(orphanOps()).toHaveLength(0);
  });
});
