import { and, eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { consolidationOps } from '../db/schema/consolidation.js';
import { memoryRelations } from '../db/schema/memory-relations.js';
import { memory as memoryTable } from '../db/schema/memory.js';
import { EmbeddingWorker } from '../services/embedding-worker.js';
import { MemoryService } from '../services/memory.js';
import { RelationsService } from '../services/relations.js';
import { SCOPE_GLOBAL } from '../services/scope.js';
import { asLlmClient, createTestDb, MockLlmClient, type TestDb } from '../test/index.js';

import { undoRun } from './operations.js';
import { ConsolidationRunner } from './runner.js';

/**
 * Orphan-promotion correctness for the v0.5 consolidator.
 *
 * The contract:
 *   - `memory_relations` rows with `status='pending'` AND
 *     `created_at < now - orphanAfterMs` get LLM-judged.
 *   - A `merge` or `supersede` verdict transitions the row to
 *     `status='judged'` with `relation='supersedes'`,
 *     `markedByKind='consolidator'`, `markedByActor='consolidator'`.
 *   - A `keep_separate` verdict transitions to `status='judged'` with
 *     `relation='not_conflict'`.
 *   - Malformed / failed LLM verdicts mark the row `status='orphaned'`.
 *   - Pending rows newer than the threshold are NOT touched.
 */

let db: TestDb;
let memory: MemoryService;
let relations: RelationsService;
let llm: MockLlmClient;
let runner: ConsolidationRunner;

const orphanAfterMs = 60_000;

beforeEach(() => {
  db = createTestDb();
  memory = new MemoryService(db.handle.db);
  relations = new RelationsService(db.handle.db);
  llm = new MockLlmClient();
  const worker = new EmbeddingWorker({
    db: db.handle.db,
    client: asLlmClient(llm),
    model: 'mock-embed',
  });
  runner = new ConsolidationRunner({
    db: db.handle.db,
    llm: asLlmClient(llm),
    model: 'mock-chat',
    batchSize: 50,
    relations,
    orphanAfterMs,
    embeddingWorker: worker,
  });
});

afterEach(() => db.cleanup());

function backdate(judgmentId: string, msAgo: number): void {
  db.handle.raw
    .prepare(`UPDATE memory_relations SET created_at = ? WHERE judgment_id = ?`)
    .run(Date.now() - msAgo, judgmentId);
}

describe('orphan promotion', () => {
  it('LLM judge "supersede" closes the pending row as supersedes', async () => {
    const a = memory.save({ type: 'feedback', content: 'old fact' }, SCOPE_GLOBAL);
    const b = memory.save({ type: 'feedback', content: 'new fact' }, SCOPE_GLOBAL);
    const pending = relations.createPending({ sourceId: b.id, targetId: a.id });
    backdate(pending.judgmentId, orphanAfterMs + 10_000);

    llm.setChatJsonResponse({
      decision: 'supersede',
      affectedIds: [a.id, b.id],
      winnerId: b.id,
      reasoning: 'newer wins',
    });

    const summary = await runner.runAll();
    const total = summary.runs.reduce((acc, r) => acc + r.ops.orphanPromoted, 0);
    expect(total).toBeGreaterThanOrEqual(1);

    const post = db.handle.db
      .select()
      .from(memoryRelations)
      .where(eq(memoryRelations.judgmentId, pending.judgmentId))
      .get();
    expect(post?.status).toBe('judged');
    expect(post?.relation).toBe('supersedes');
    expect(post?.markedByKind).toBe('consolidator');
  });

  it('LLM judge "keep_separate" closes the pending row as not_conflict', async () => {
    const a = memory.save({ type: 'feedback', content: 'about cats' }, SCOPE_GLOBAL);
    const b = memory.save({ type: 'feedback', content: 'about dogs' }, SCOPE_GLOBAL);
    const pending = relations.createPending({ sourceId: a.id, targetId: b.id });
    backdate(pending.judgmentId, orphanAfterMs + 10_000);

    llm.setChatJsonResponse({
      decision: 'keep_separate',
      affectedIds: [a.id, b.id],
      reasoning: 'unrelated topics',
    });

    await runner.runAll();
    const post = db.handle.db
      .select()
      .from(memoryRelations)
      .where(eq(memoryRelations.judgmentId, pending.judgmentId))
      .get();
    expect(post?.status).toBe('judged');
    expect(post?.relation).toBe('not_conflict');
  });

  it('LLM failure marks the row as orphaned', async () => {
    const a = memory.save({ type: 'feedback', content: 'a' }, SCOPE_GLOBAL);
    const b = memory.save({ type: 'feedback', content: 'b' }, SCOPE_GLOBAL);
    const pending = relations.createPending({ sourceId: a.id, targetId: b.id });
    backdate(pending.judgmentId, orphanAfterMs + 10_000);

    llm.setChatResponder(() => {
      throw new Error('LLM down');
    });

    const summary = await runner.runAll();
    const failed = summary.runs.reduce((acc, r) => acc + r.ops.orphanFailed, 0);
    expect(failed).toBeGreaterThanOrEqual(1);

    const post = db.handle.db
      .select()
      .from(memoryRelations)
      .where(eq(memoryRelations.judgmentId, pending.judgmentId))
      .get();
    expect(post?.status).toBe('orphaned');
  });

  it('writes a consolidation_ops journal entry for each orphan_promote', async () => {
    const a = memory.save({ type: 'feedback', content: 'judged-row' }, SCOPE_GLOBAL);
    const b = memory.save({ type: 'feedback', content: 'judged-row-2' }, SCOPE_GLOBAL);
    const pending = relations.createPending({ sourceId: a.id, targetId: b.id });
    backdate(pending.judgmentId, orphanAfterMs + 10_000);

    llm.setChatJsonResponse({
      decision: 'keep_separate',
      affectedIds: [a.id, b.id],
      reasoning: 'unrelated',
    });

    await runner.runAll();

    const opsRows = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.opType, 'orphan_promote'))
      .all();
    expect(opsRows.length).toBe(1);
    expect(opsRows[0]!.affectedIds).toEqual([a.id, b.id]);
    expect(opsRows[0]!.createdId).toBe(pending.judgmentId);
  });

  it('undoRun rolls an orphan_promote back to pending and reactivates supersede targets', async () => {
    const a = memory.save({ type: 'feedback', content: 'survivor' }, SCOPE_GLOBAL);
    const b = memory.save({ type: 'feedback', content: 'will-be-superseded' }, SCOPE_GLOBAL);
    const pending = relations.createPending({ sourceId: a.id, targetId: b.id });
    backdate(pending.judgmentId, orphanAfterMs + 10_000);

    llm.setChatJsonResponse({
      decision: 'supersede',
      affectedIds: [a.id, b.id],
      winnerId: a.id,
      reasoning: 'a wins',
    });

    const summary = await runner.runAll();
    const judged = db.handle.db
      .select()
      .from(memoryRelations)
      .where(eq(memoryRelations.judgmentId, pending.judgmentId))
      .get();
    expect(judged?.status).toBe('judged');
    expect(judged?.relation).toBe('supersedes');

    const bAfter = db.handle.db.select().from(memoryTable).where(eq(memoryTable.id, b.id)).get();
    expect(bAfter?.status).toBe('superseded');

    // Pick the run that journaled the orphan_promote and undo it.
    const opsBefore = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.opType, 'orphan_promote'))
      .all();
    expect(opsBefore.length).toBe(1);

    const runId = summary.runs.find((r) => r.ops.orphanPromoted > 0)!.runId;
    undoRun(db.handle.db, runId);

    const bRestored = db.handle.db.select().from(memoryTable).where(eq(memoryTable.id, b.id)).get();
    expect(bRestored?.status).toBe('active');

    const relAfter = db.handle.db
      .select()
      .from(memoryRelations)
      .where(eq(memoryRelations.judgmentId, pending.judgmentId))
      .get();
    expect(relAfter?.status).toBe('pending');
    expect(relAfter?.relation).toBeNull();

    const aAfterUndo = db.handle.db
      .select()
      .from(memoryTable)
      .where(eq(memoryTable.id, a.id))
      .get();
    expect(aAfterUndo?.replaces).not.toContain(b.id);

    const opsAfter = db.handle.db
      .select()
      .from(consolidationOps)
      .where(and(eq(consolidationOps.opType, 'orphan_promote'), sql`reverted_at IS NOT NULL`))
      .all();
    expect(opsAfter.length).toBe(1);
  });

  it('pending rows younger than the threshold are not touched', async () => {
    const a = memory.save({ type: 'feedback', content: 'a' }, SCOPE_GLOBAL);
    const b = memory.save({ type: 'feedback', content: 'b' }, SCOPE_GLOBAL);
    const pending = relations.createPending({ sourceId: a.id, targetId: b.id });
    // No backdate — the row was just inserted, so it's well within the
    // age window.

    llm.setChatJsonResponse({
      decision: 'keep_separate',
      affectedIds: [a.id, b.id],
      reasoning: 'should not be reached',
    });

    await runner.runAll();

    const post = db.handle.db
      .select()
      .from(memoryRelations)
      .where(eq(memoryRelations.judgmentId, pending.judgmentId))
      .get();
    expect(post?.status).toBe('pending');
    expect(llm.chatCalls.length).toBe(0);
  });
});
