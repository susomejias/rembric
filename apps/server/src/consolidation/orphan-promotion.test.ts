import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { consolidationOps } from '../db/schema/consolidation.js';
import { memoryRelations } from '../db/schema/memory-relations.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { RelationsService } from '../services/relations.js';
import { projectScope, SCOPE_GLOBAL } from '../services/scope.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { undoRun } from './operations.js';
import { ConsolidationRunner } from './runner.js';

/**
 * Deadline-orphaning correctness (change `remove-llm-consolidation`).
 *
 * The contract:
 *   - `memory_relations` rows with `status='pending'` AND
 *     `created_at < now - orphanDeadlineMs` transition to `orphaned`,
 *     journaled as an `orphan_promote` op. No LLM is involved.
 *   - Pending rows younger than the deadline are NOT touched (between
 *     `JUDGMENT_ORPHAN_AFTER_MS` and the deadline they are re-exposed via
 *     `memory.context.pendingJudgments[]` instead).
 *   - Orphaning is undoable while the referenced rows exist.
 *   - The sweep is idempotent: a second forced run orphans nothing new.
 */

let db: TestDb;
let memory: MemoryService;
let relations: RelationsService;
let runner: ConsolidationRunner;

const orphanDeadlineMs = 60_000;

beforeEach(() => {
  db = createTestDb();
  memory = new MemoryService(createRepositories(db.handle.db), db.handle.db);
  relations = new RelationsService(createRepositories(db.handle.db), db.handle.db);
  runner = new ConsolidationRunner({
    repos: createRepositories(db.handle.db),
    tx: db.handle.db,
    relations,
    orphanDeadlineMs,
  });
});

afterEach(() => db.cleanup());

function backdate(judgmentId: string, msAgo: number): void {
  db.handle.raw
    .prepare(`UPDATE memory_relations SET created_at = ? WHERE judgment_id = ?`)
    .run(Date.now() - msAgo, judgmentId);
}

describe('deadline orphaning', () => {
  it('orphans a pending row older than the deadline and journals it', () => {
    const a = memory.save(
      { type: 'feedback', title: 'old fact', content: 'old fact' },
      SCOPE_GLOBAL,
    );
    const b = memory.save(
      { type: 'feedback', title: 'new fact', content: 'new fact' },
      SCOPE_GLOBAL,
    );
    const pending = relations.createPending({ sourceId: b.id, targetId: a.id });
    backdate(pending.judgmentId, orphanDeadlineMs + 10_000);

    const summary = runner.runAll({ force: true });
    const total = summary.runs.reduce((acc, r) => acc + r.ops.orphaned, 0);
    expect(total).toBe(1);

    const post = db.handle.db
      .select()
      .from(memoryRelations)
      .where(eq(memoryRelations.judgmentId, pending.judgmentId))
      .get();
    expect(post?.status).toBe('orphaned');

    const opsRows = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.opType, 'orphan_promote'))
      .all();
    expect(opsRows.length).toBe(1);
    expect(opsRows[0]!.affectedIds).toEqual([b.id, a.id]);
    expect(opsRows[0]!.createdId).toBe(pending.judgmentId);
    expect(opsRows[0]!.reasoning).toContain('deadline');
  });

  it('does not touch pending rows younger than the deadline', () => {
    const a = memory.save({ type: 'feedback', title: 'a', content: 'a' }, SCOPE_GLOBAL);
    const b = memory.save({ type: 'feedback', title: 'b', content: 'b' }, SCOPE_GLOBAL);
    const pending = relations.createPending({ sourceId: a.id, targetId: b.id });
    // No backdate — well within the window.

    runner.runAll({ force: true });

    const post = db.handle.db
      .select()
      .from(memoryRelations)
      .where(eq(memoryRelations.judgmentId, pending.judgmentId))
      .get();
    expect(post?.status).toBe('pending');
  });

  it('undoRun restores an orphaned row to pending', () => {
    const a = memory.save({ type: 'feedback', title: 'x', content: 'x' }, SCOPE_GLOBAL);
    const b = memory.save({ type: 'feedback', title: 'y', content: 'y' }, SCOPE_GLOBAL);
    const pending = relations.createPending({ sourceId: a.id, targetId: b.id });
    backdate(pending.judgmentId, orphanDeadlineMs + 10_000);

    const summary = runner.runAll({ force: true });
    const runId = summary.runs.find((r) => r.ops.orphaned > 0)!.runId;

    undoRun(createRepositories(db.handle.db), db.handle.db, runId);

    const relAfter = db.handle.db
      .select()
      .from(memoryRelations)
      .where(eq(memoryRelations.judgmentId, pending.judgmentId))
      .get();
    expect(relAfter?.status).toBe('pending');

    const opsAfter = db.handle.db
      .select()
      .from(consolidationOps)
      .where(and(eq(consolidationOps.opType, 'orphan_promote'), sql`reverted_at IS NOT NULL`))
      .all();
    expect(opsAfter.length).toBe(1);
  });

  it("orphans scope B's overdue pending even when scope A has more than a full batch overdue", () => {
    const projects = new ProjectsService(createRepositories(db.handle.db));
    const projA = projects.create({ slug: 'proj-a' });
    const projB = projects.create({ slug: 'proj-b' });

    const aIds: string[] = [];
    for (let i = 0; i < 52; i++) {
      aIds.push(
        memory.save({ type: 'feedback', title: `a${i}`, content: `a${i}` }, projectScope(projA.id))
          .id,
      );
    }
    const aJudgmentIds: string[] = [];
    for (let i = 0; i < 51; i++) {
      const p = relations.createPending({ sourceId: aIds[i]!, targetId: aIds[i + 1]! });
      backdate(p.judgmentId, orphanDeadlineMs + 10_000);
      aJudgmentIds.push(p.judgmentId);
    }

    const b1 = memory.save(
      { type: 'feedback', title: 'b1', content: 'b1' },
      projectScope(projB.id),
    );
    const b2 = memory.save(
      { type: 'feedback', title: 'b2', content: 'b2' },
      projectScope(projB.id),
    );
    const bPending = relations.createPending({ sourceId: b1.id, targetId: b2.id });
    backdate(bPending.judgmentId, orphanDeadlineMs + 10_000);

    const result = runner.runScope({ scope: 'project', projectId: projB.id });
    expect(result.ops.orphaned).toBe(1);

    const bRow = db.handle.db
      .select()
      .from(memoryRelations)
      .where(eq(memoryRelations.judgmentId, bPending.judgmentId))
      .get();
    expect(bRow?.status).toBe('orphaned');

    const aRows = db.handle.db
      .select({ status: memoryRelations.status })
      .from(memoryRelations)
      .where(inArray(memoryRelations.judgmentId, aJudgmentIds))
      .all();
    expect(aRows).toHaveLength(51);
    expect(aRows.every((r) => r.status === 'pending')).toBe(true);
  });

  it('is idempotent: a second forced run orphans nothing new', () => {
    const a = memory.save({ type: 'feedback', title: 'p', content: 'p' }, SCOPE_GLOBAL);
    const b = memory.save({ type: 'feedback', title: 'q', content: 'q' }, SCOPE_GLOBAL);
    const pending = relations.createPending({ sourceId: a.id, targetId: b.id });
    backdate(pending.judgmentId, orphanDeadlineMs + 10_000);

    const first = runner.runAll({ force: true });
    expect(first.runs.reduce((acc, r) => acc + r.ops.orphaned, 0)).toBe(1);

    const second = runner.runAll({ force: true });
    expect(second.runs.reduce((acc, r) => acc + r.ops.orphaned, 0)).toBe(0);
    expect(second.runs.reduce((acc, r) => acc + r.ops.archives, 0)).toBe(0);
  });
});
