import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { consolidationOps, consolidationRuns } from '../db/schema/consolidation.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { SCOPE_GLOBAL, projectScope } from '../services/scope.js';
import { createTestDb, type TestDb, TestClock } from '../test/index.js';

import { applyDecay, applyMerge, applySupersede, undoOp, undoRun } from './operations.js';

let db: TestDb;
let projects: ProjectsService;
let memoryService: MemoryService;
let clock: TestClock;
let projectId: string;
let runId: string;

beforeEach(() => {
  db = createTestDb();
  clock = new TestClock();
  projects = new ProjectsService(db.handle.db, clock.now);
  memoryService = new MemoryService(db.handle.db, clock.now);
  projectId = projects.create({ slug: 'app' }).id;

  runId = 'test-run-id';
  db.handle.db
    .insert(consolidationRuns)
    .values({ id: runId, startedAt: clock.value, llmProvider: 'mock', llmModel: 'mock' })
    .run();
});

afterEach(() => {
  db.cleanup();
});

describe('applyMerge', () => {
  it('inserts a new active memory, supersedes predecessors, and journals the op', () => {
    const a = memoryService.save(
      { type: 'user', content: 'prefers tabs' },
      projectScope(projectId),
    );
    const b = memoryService.save(
      { type: 'user', content: 'wants tab indentation' },
      projectScope(projectId),
    );

    const { mergedId, opId } = applyMerge(db.handle.db, {
      consolidationId: runId,
      predecessors: [a, b],
      mergedContent: 'prefers tabs for indentation',
      reasoning: 'both say the same thing',
    });

    const merged = memoryService.unsafeGetById(mergedId)!;
    expect(merged.status).toBe('active');
    expect(merged.replaces).toEqual([a.id, b.id]);

    expect(memoryService.unsafeGetById(a.id)!.status).toBe('superseded');
    expect(memoryService.unsafeGetById(b.id)!.status).toBe('superseded');

    const op = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.id, opId))
      .get();
    expect(op?.opType).toBe('merge');
    expect(op?.createdId).toBe(mergedId);
    expect(op?.affectedIds).toEqual([a.id, b.id]);
  });

  it('rejects predecessors spanning multiple scopes', () => {
    const a = memoryService.save({ type: 'user', content: 'p1' }, projectScope(projectId));
    const b = memoryService.save({ type: 'user', content: 'g1' }, SCOPE_GLOBAL);
    expect(() =>
      applyMerge(db.handle.db, {
        consolidationId: runId,
        predecessors: [a, b],
        mergedContent: 'x',
        reasoning: 'illegal',
      }),
    ).toThrow(/multiple scopes/);
  });

  it('rejects non-active predecessors', () => {
    const a = memoryService.save({ type: 'user', content: 'a' }, projectScope(projectId));
    const b = memoryService.save({ type: 'user', content: 'b' }, projectScope(projectId));
    memoryService.archive(a.id, projectScope(projectId));
    const aArchived = memoryService.unsafeGetById(a.id)!;
    expect(() =>
      applyMerge(db.handle.db, {
        consolidationId: runId,
        predecessors: [aArchived, b],
        mergedContent: 'x',
        reasoning: 'x',
      }),
    ).toThrow(/not active/);
  });
});

describe('applySupersede', () => {
  it('appends losers to the winner replaces array and flips them to superseded', () => {
    const winner = memoryService.save({ type: 'user', content: 'winner' }, projectScope(projectId));
    const loser = memoryService.save({ type: 'user', content: 'loser' }, projectScope(projectId));
    applySupersede(db.handle.db, {
      consolidationId: runId,
      winner,
      losers: [loser],
      reasoning: 'newer wins',
    });

    expect(memoryService.unsafeGetById(loser.id)!.status).toBe('superseded');
    const updatedWinner = memoryService.unsafeGetById(winner.id)!;
    expect(updatedWinner.replaces).toContain(loser.id);
  });
});

describe('applyDecay', () => {
  it('archives only currently-active memories', () => {
    const a = memoryService.save({ type: 'user', content: 'a' }, projectScope(projectId));
    const b = memoryService.save({ type: 'user', content: 'b' }, projectScope(projectId));
    memoryService.archive(b.id, projectScope(projectId));

    applyDecay(db.handle.db, {
      consolidationId: runId,
      ids: [a.id, b.id],
      reasoning: 'stale',
    });

    expect(memoryService.unsafeGetById(a.id)!.status).toBe('archived');
    expect(memoryService.unsafeGetById(b.id)!.status).toBe('archived');
  });
});

describe('undoOp / undoRun', () => {
  it('reverts a merge: predecessors active again, merged-into archived', () => {
    const a = memoryService.save({ type: 'user', content: 'a' }, projectScope(projectId));
    const b = memoryService.save({ type: 'user', content: 'b' }, projectScope(projectId));
    const { mergedId, opId } = applyMerge(db.handle.db, {
      consolidationId: runId,
      predecessors: [a, b],
      mergedContent: 'merged',
      reasoning: 'r',
    });

    undoOp(db.handle.db, opId);

    expect(memoryService.unsafeGetById(a.id)!.status).toBe('active');
    expect(memoryService.unsafeGetById(b.id)!.status).toBe('active');
    expect(memoryService.unsafeGetById(mergedId)!.status).toBe('archived');

    const op = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.id, opId))
      .get();
    expect(op?.revertedAt).not.toBeNull();
  });

  it('refuses to undo an already-reverted op', () => {
    const a = memoryService.save({ type: 'user', content: 'a' }, projectScope(projectId));
    const b = memoryService.save({ type: 'user', content: 'b' }, projectScope(projectId));
    const { opId } = applyMerge(db.handle.db, {
      consolidationId: runId,
      predecessors: [a, b],
      mergedContent: 'merged',
      reasoning: 'r',
    });
    undoOp(db.handle.db, opId);
    expect(() => undoOp(db.handle.db, opId)).toThrow(/already reverted/);
  });

  it('undoRun reverses every op in reverse order', () => {
    const a = memoryService.save({ type: 'user', content: 'a' }, projectScope(projectId));
    const b = memoryService.save({ type: 'user', content: 'b' }, projectScope(projectId));
    applyMerge(db.handle.db, {
      consolidationId: runId,
      predecessors: [a, b],
      mergedContent: 'merged',
      reasoning: 'r',
    });
    const c = memoryService.save({ type: 'user', content: 'c' }, projectScope(projectId));
    applyDecay(db.handle.db, { consolidationId: runId, ids: [c.id], reasoning: 'r' });

    const { reverted } = undoRun(db.handle.db, runId);
    expect(reverted.length).toBe(2);
    expect(memoryService.unsafeGetById(a.id)!.status).toBe('active');
    expect(memoryService.unsafeGetById(c.id)!.status).toBe('active');
  });
});
