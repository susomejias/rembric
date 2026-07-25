import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import {
  CONSOLIDATION_OP_TYPES,
  consolidationOps,
  consolidationRuns,
} from '../db/schema/consolidation.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { projectScope } from '../services/scope.js';
import { createTestDb, type TestDb, TestClock } from '../test/index.js';

import { DEFAULT_DECAY, findDecayCandidates } from './decay.js';
import {
  applyDecay,
  NotUndoableError,
  PurgedRowMissingError,
  REACTIVATE_UNDO_OP_TYPES,
  TERMINAL_OP_TYPES,
  undoOp,
  undoRun,
} from './operations.js';

let db: TestDb;
let repos: Repositories;
let projects: ProjectsService;
let memoryService: MemoryService;
let clock: TestClock;
let projectId: string;
let runId: string;

beforeEach(() => {
  db = createTestDb();
  clock = new TestClock();
  repos = createRepositories(db.handle.db);
  projects = new ProjectsService(repos, clock.now);
  memoryService = new MemoryService(repos, db.handle.db, clock.now);
  projectId = projects.create({ slug: 'app' }).id;

  runId = 'test-run-id';
  db.handle.db
    .insert(consolidationRuns)
    .values({ id: runId, startedAt: clock.value, scope: 'global' })
    .run();
});

afterEach(() => {
  db.cleanup();
});

/**
 * Seed a historical `merge` op the way the removed LLM consolidator once did
 * (two superseded predecessors + an active merged row + a journaled op). The
 * producer (`applyMerge`) is gone, but the spec requires such pre-upgrade rows
 * to stay renderable and undoable.
 */
function seedHistoricalMerge(): { aId: string; bId: string; mergedId: string; opId: string } {
  const a = memoryService.save({ type: 'user', title: 'a', content: 'a' }, projectScope(projectId));
  const b = memoryService.save({ type: 'user', title: 'b', content: 'b' }, projectScope(projectId));
  const mergedId = `merged-${a.id}`;
  repos.memory.insert({
    id: mergedId,
    scope: 'project',
    projectId,
    type: 'user',
    title: 'merged',
    content: 'merged',
    tags: [],
    status: 'active',
    replaces: [a.id, b.id],
    createdAt: clock.value,
    lastSeenAt: clock.value,
    source: { tokenName: 'consolidation' },
  });
  repos.memory.markSupersededMany([a.id, b.id]);
  const opId = `op-${a.id}`;
  repos.consolidation.insertOp({
    id: opId,
    runId,
    opType: 'merge',
    affectedIds: [a.id, b.id],
    createdId: mergedId,
    reasoning: 'historical',
    appliedAt: clock.value,
  });
  return { aId: a.id, bId: b.id, mergedId, opId };
}

describe('applyDecay', () => {
  it('archives only currently-active memories', () => {
    const a = memoryService.save(
      { type: 'user', title: 'a', content: 'a' },
      projectScope(projectId),
    );
    const b = memoryService.save(
      { type: 'user', title: 'b', content: 'b' },
      projectScope(projectId),
    );
    memoryService.archive(b.id, projectScope(projectId));

    applyDecay(repos, db.handle.db, {
      runId,
      ids: [a.id, b.id],
      reasoning: 'stale',
    });

    expect(memoryService.unsafeGetById(a.id)!.status).toBe('archived');
    expect(memoryService.unsafeGetById(b.id)!.status).toBe('archived');
  });
});

describe('undoOp / undoRun', () => {
  it('reverts an agent_memory_archive op: the archived memory is active again', () => {
    const m = memoryService.save(
      { type: 'user', title: 'm', content: 'm' },
      projectScope(projectId),
    );
    memoryService.archive(m.id, projectScope(projectId));
    expect(memoryService.unsafeGetById(m.id)!.status).toBe('archived');

    const op = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.opType, 'agent_memory_archive'))
      .get();
    expect(op).toBeDefined();

    undoOp(repos, db.handle.db, op!.id);

    expect(memoryService.unsafeGetById(m.id)!.status).toBe('active');
    const reverted = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.id, op!.id))
      .get();
    expect(reverted!.revertedAt).not.toBeNull();
  });

  it('reverts a historical merge: predecessors active again, merged-into archived', () => {
    const { aId, bId, mergedId, opId } = seedHistoricalMerge();

    undoOp(repos, db.handle.db, opId);

    expect(memoryService.unsafeGetById(aId)!.status).toBe('active');
    expect(memoryService.unsafeGetById(bId)!.status).toBe('active');
    expect(memoryService.unsafeGetById(mergedId)!.status).toBe('archived');

    const op = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.id, opId))
      .get();
    expect(op?.revertedAt).not.toBeNull();
  });

  it('refuses to undo an already-reverted op', () => {
    const { opId } = seedHistoricalMerge();
    undoOp(repos, db.handle.db, opId);
    expect(() => undoOp(repos, db.handle.db, opId)).toThrow(/already reverted/);
  });

  it('undoRun reverses every op in reverse order', () => {
    seedHistoricalMerge();
    const c = memoryService.save(
      { type: 'user', title: 'c', content: 'c' },
      projectScope(projectId),
    );
    applyDecay(repos, db.handle.db, {
      runId,
      ids: [c.id],
      reasoning: 'r',
    });

    const { reverted } = undoRun(repos, db.handle.db, runId);
    expect(reverted.length).toBe(2);
    expect(memoryService.unsafeGetById(c.id)!.status).toBe('active');
  });
});

describe('undoOp preserves topic_key convergence', () => {
  it('does not reactivate a decayed row whose topic slot a newer save claimed', () => {
    const r = memoryService.saveWithTopicKey(
      { type: 'user', title: 'r', content: 'r', topicKey: 'k' },
      projectScope(projectId),
    ).memory;
    const { opId } = applyDecay(repos, db.handle.db, {
      runId,
      ids: [r.id],
      reasoning: 'stale',
    });
    const n = memoryService.saveWithTopicKey(
      { type: 'user', title: 'n', content: 'n', topicKey: 'k' },
      projectScope(projectId),
    ).memory;

    const result = undoOp(repos, db.handle.db, opId);

    expect(memoryService.unsafeGetById(n.id)!.status).toBe('active');
    expect(memoryService.unsafeGetById(r.id)!.status).toBe('archived');
    expect(result.skipped).toEqual([{ id: r.id, topicKey: 'k', occupiedBy: n.id }]);
    const op = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.id, opId))
      .get();
    expect(op?.revertedAt).not.toBeNull();
  });

  it('reactivates normally when the topic slot is free (no regression)', () => {
    const r = memoryService.saveWithTopicKey(
      { type: 'user', title: 'r', content: 'r', topicKey: 'free' },
      projectScope(projectId),
    ).memory;
    const { opId } = applyDecay(repos, db.handle.db, {
      runId,
      ids: [r.id],
      reasoning: 'stale',
    });

    const result = undoOp(repos, db.handle.db, opId);

    expect(memoryService.unsafeGetById(r.id)!.status).toBe('active');
    expect(result.skipped).toEqual([]);
  });

  it('orphan_promote undo skips a target whose topic slot is occupied but still resets the relation', () => {
    const source = memoryService.save(
      { type: 'user', title: 'src', content: 'src' },
      projectScope(projectId),
    );
    const target = memoryService.saveWithTopicKey(
      { type: 'user', title: 'tgt', content: 'tgt', topicKey: 'k' },
      projectScope(projectId),
    ).memory;
    const pending = repos.relations.insert({
      id: `rel-${target.id}`,
      judgmentId: `jmt-${target.id}`,
      sourceId: source.id,
      targetId: target.id,
      relation: 'supersedes',
      status: 'judged',
      confidence: 1,
      markedByKind: 'agent',
      markedByActor: 'test',
      judgedAt: clock.value,
      createdAt: clock.value,
    })!;
    repos.memory.markSuperseded(target.id);
    repos.memory.setReplaces(source.id, [target.id]);
    const opId = `op-orphan-${target.id}`;
    repos.consolidation.insertOp({
      id: opId,
      runId,
      opType: 'orphan_promote',
      affectedIds: [source.id, target.id],
      createdId: pending.judgmentId,
      reasoning: 'supersedes: promoted',
      appliedAt: clock.value,
    });

    const n = memoryService.saveWithTopicKey(
      { type: 'user', title: 'n', content: 'n', topicKey: 'k' },
      projectScope(projectId),
    ).memory;

    const result = undoOp(repos, db.handle.db, opId);

    expect(memoryService.unsafeGetById(n.id)!.status).toBe('active');
    expect(memoryService.unsafeGetById(target.id)!.status).toBe('superseded');
    expect(result.skipped.map((s) => s.id)).toContain(target.id);
    expect(repos.relations.findByJudgmentId(pending.judgmentId)?.status).toBe('pending');
    expect(memoryService.unsafeGetById(source.id)!.replaces).not.toContain(target.id);
  });
});

describe('undoOp with purged rows', () => {
  it('blocks undo with PurgedRowMissingError listing the missing ids', () => {
    const c = memoryService.save(
      { type: 'user', title: 'will-be-purged', content: 'will-be-purged' },
      projectScope(projectId),
    );
    applyDecay(repos, db.handle.db, {
      runId,
      ids: [c.id],
      reasoning: 'r',
    });

    const opId = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.runId, runId))
      .get()!.id;

    // Physically purge the archived row to simulate a maintenance purge.
    db.handle.raw.prepare(`DELETE FROM memory WHERE id = ?`).run(c.id);

    let thrown: unknown;
    try {
      undoOp(repos, db.handle.db, opId);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(PurgedRowMissingError);
    expect((thrown as PurgedRowMissingError).missing).toEqual([c.id]);
    expect((thrown as PurgedRowMissingError).code).toBe('purged_row_missing');

    // Op stays unreverted.
    const op = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.id, opId))
      .get();
    expect(op?.revertedAt).toBeNull();
  });

  it('rejects undo of a session_purge op as NotUndoableError', () => {
    db.handle.db
      .insert(consolidationOps)
      .values({
        id: 'purge-op-1',
        runId,
        opType: 'session_purge',
        affectedIds: ['some-session'],
        createdId: null,
        reasoning: 'test',
        appliedAt: clock.value,
      })
      .run();

    let thrown: unknown;
    try {
      undoOp(repos, db.handle.db, 'purge-op-1');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotUndoableError);
    expect((thrown as NotUndoableError).code).toBe('not_undoable');
  });

  it('rejects undo of an archived_memory_purge op as NotUndoableError', () => {
    db.handle.db
      .insert(consolidationOps)
      .values({
        id: 'purge-op-2',
        runId,
        opType: 'archived_memory_purge',
        affectedIds: ['some-mem'],
        createdId: null,
        reasoning: 'test',
        appliedAt: clock.value,
      })
      .run();

    expect(() => undoOp(repos, db.handle.db, 'purge-op-2')).toThrow(NotUndoableError);
  });

  it('rejects undo of a prompt_purge op as NotUndoableError (fix-audited-defects)', () => {
    db.handle.db
      .insert(consolidationOps)
      .values({
        id: 'purge-op-3',
        runId,
        opType: 'prompt_purge',
        affectedIds: ['some-prompt'],
        createdId: null,
        reasoning: 'test',
        appliedAt: clock.value,
      })
      .run();

    let thrown: unknown;
    try {
      undoOp(repos, db.handle.db, 'purge-op-3');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(NotUndoableError);
    // The op must NOT be silently marked reverted while its rows stay gone.
    const op = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.id, 'purge-op-3'))
      .get();
    expect(op?.revertedAt).toBeNull();
  });
});

describe('op-type classification is exhaustive (fix-audited-defects)', () => {
  it('every CONSOLIDATION_OP_TYPES member falls into exactly one category', () => {
    const ORPHAN_PROMOTE = new Set(['orphan_promote']);
    const INERT = new Set(['noop', 'failed']);
    for (const t of CONSOLIDATION_OP_TYPES) {
      const memberships = [
        REACTIVATE_UNDO_OP_TYPES.has(t),
        TERMINAL_OP_TYPES.has(t),
        ORPHAN_PROMOTE.has(t),
        INERT.has(t),
      ].filter(Boolean).length;
      expect(memberships, `op type '${t}' must classify into exactly one category`).toBe(1);
    }
  });
});

describe('reactivation durability (fix-audited-defects)', () => {
  it('stamps last_seen_at on reactivate so the next sweep does not re-archive the row', () => {
    // Save the memory with a last_seen_at far past its type's decay window
    // (reference = 3650 days) so the ORIGINAL timestamp alone would make it
    // decay-eligible again after undo — that is exactly the bug: reactivate()
    // used to leave last_seen_at untouched. `reference` is used deliberately
    // (separate-access-from-usefulness): it has no review TTL, so it can
    // never become escalation-eligible — this test is specifically about
    // the recency+confidence decay path, not escalation, and an ancient
    // `createdAt` on a TTL-having type would otherwise trip escalation too.
    clock.set(new Date('2000-01-01T00:00:00Z'));
    const m = memoryService.save(
      { type: 'reference', title: 'm', content: 'm' },
      projectScope(projectId),
    );

    const { opId } = applyDecay(repos, db.handle.db, {
      runId,
      ids: [m.id],
      reasoning: 'stale',
    });
    expect(memoryService.unsafeGetById(m.id)!.status).toBe('archived');

    undoOp(repos, db.handle.db, opId);
    expect(memoryService.unsafeGetById(m.id)!.status).toBe('active');

    const candidates = findDecayCandidates(
      repos,
      { scope: 'project', projectId },
      DEFAULT_DECAY,
      new Date(),
    );
    expect(candidates).not.toContain(m.id);
  });

  it('does not record a confirmation, so the review baseline is unchanged', () => {
    clock.set(new Date('2020-01-01T00:00:00Z'));
    const m = memoryService.save(
      { type: 'user', title: 'm', content: 'm' },
      projectScope(projectId),
    );
    const beforeConfirmations = repos.memory.countConfirmations(m.id);

    const { opId } = applyDecay(repos, db.handle.db, {
      runId,
      ids: [m.id],
      reasoning: 'stale',
    });
    undoOp(repos, db.handle.db, opId);

    expect(repos.memory.countConfirmations(m.id)).toBe(beforeConfirmations);
  });
});

describe('escalation', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;

  it('escalation is derived at read time and never archives: a long-unaffirmed but frequently-read memory stays out of the decay candidates', () => {
    const m = memoryService.save(
      { type: 'project', title: 'Plan', content: 'plan' },
      projectScope(projectId),
    );

    // Frequent reads keep last_seen_at fresh, so the recency rule cannot fire.
    // project's TTL is 3 months, so 350 days is well past escalation.
    for (let i = 0; i < 10; i++) {
      clock.advance(35 * DAY_MS);
      memoryService.get(m.id, projectScope(projectId));
    }

    const candidates = findDecayCandidates(
      repos,
      { scope: 'project', projectId },
      DEFAULT_DECAY,
      clock.value,
    );
    expect(candidates).not.toContain(m.id);

    const seen = memoryService.get(m.id, projectScope(projectId));
    expect(seen?.reviewState).toBe('needs_review');
    expect(seen?.reviewEscalated).toBe(true);
  });

  it('does NOT trip escalation before the multiplier threshold is reached', () => {
    const m = memoryService.save(
      { type: 'project', title: 'Plan', content: 'plan' },
      projectScope(projectId),
    );

    clock.advance(60 * DAY_MS); // inside the first TTL: not even needs_review
    memoryService.get(m.id, projectScope(projectId));

    const candidates = findDecayCandidates(
      repos,
      { scope: 'project', projectId },
      DEFAULT_DECAY,
      clock.value,
    );
    expect(candidates).not.toContain(m.id);
  });

  it('a confirmation resets the escalation baseline', () => {
    const m = memoryService.save(
      { type: 'project', title: 'Plan', content: 'plan' },
      projectScope(projectId),
    );

    clock.advance(200 * DAY_MS);
    memoryService.confirm(m.id, projectScope(projectId));
    clock.advance(60 * DAY_MS); // baseline moved: well inside the window again
    memoryService.get(m.id, projectScope(projectId));

    const candidates = findDecayCandidates(
      repos,
      { scope: 'project', projectId },
      DEFAULT_DECAY,
      clock.value,
    );
    expect(candidates).not.toContain(m.id);
  });
});
