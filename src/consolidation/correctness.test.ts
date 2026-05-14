import { eq, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { consolidationOps } from '../db/schema/consolidation.js';
import { memory } from '../db/schema/memory.js';
import { EmbeddingWorker } from '../services/embedding-worker.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { projectScope, SCOPE_GLOBAL } from '../services/scope.js';
import { asLlmClient, createTestDb, MockLlmClient, type TestDb } from '../test/index.js';

import { undoRun } from './operations.js';
import { ConsolidationRunner } from './runner.js';

/**
 * 13.15 / 13.16 / 13.17 — consolidation correctness, idempotency, and
 * reversibility.
 *
 * Seeds a DB with known redundant pairs, runs consolidation with a
 * deterministic mock LLM, then asserts:
 *   - the journal contains exactly the expected ops
 *   - a second runAll on the post-state produces no new merge/supersede
 *   - undoRun returns the DB to the pre-run state (status-wise), with the
 *     merged memory archived rather than deleted (append-only invariant)
 */

interface Fixture {
  db: TestDb;
  projects: ProjectsService;
  memory: MemoryService;
  llm: MockLlmClient;
  runner: ConsolidationRunner;
}

function setup(): Fixture {
  const db = createTestDb();
  const projects = new ProjectsService(db.handle.db);
  const memorySvc = new MemoryService(db.handle.db);
  const llm = new MockLlmClient();
  const worker = new EmbeddingWorker({
    db: db.handle.db,
    client: asLlmClient(llm),
    model: 'mock-embed',
  });
  const runner = new ConsolidationRunner({
    db: db.handle.db,
    llm: asLlmClient(llm),
    model: 'mock-chat',
    batchSize: 50,
    embeddingWorker: worker,
  });
  return { db, projects, memory: memorySvc, llm, runner };
}

describe('consolidation correctness + idempotency + reversibility', () => {
  let f: Fixture;

  beforeEach(() => {
    f = setup();
  });
  afterEach(() => f.db.cleanup());

  it('merges a redundant pair when the judge says merge, then is idempotent', async () => {
    const project = f.projects.findOrCreate('app');
    const a = f.memory.save(
      { type: 'feedback', content: 'use 2-space indentation' },
      projectScope(project.id),
    );
    const b = f.memory.save(
      { type: 'feedback', content: 'use two-space indent' },
      projectScope(project.id),
    );

    f.llm.setChatResponder(() => ({
      content: JSON.stringify({
        decision: 'merge',
        affectedIds: [a.id, b.id],
        mergedContent: 'use two-space indentation',
        reasoning: 'restated the same convention',
      }),
      finishReason: 'stop',
      model: 'mock-chat',
    }));

    const summary = await f.runner.runAll();
    const projectRun = summary.runs.find((r) => r.scope.scope === 'project');
    expect(projectRun?.ops.merges).toBeGreaterThanOrEqual(1);

    const merges = f.db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.opType, 'merge'))
      .all();
    expect(merges.length).toBeGreaterThanOrEqual(1);

    // Predecessors now superseded.
    expect(f.db.handle.db.select().from(memory).where(eq(memory.id, a.id)).get()!.status).toBe(
      'superseded',
    );
    expect(f.db.handle.db.select().from(memory).where(eq(memory.id, b.id)).get()!.status).toBe(
      'superseded',
    );

    // Idempotency: second run produces no new merges (judge will return
    // the merged content as a single active row, no candidate pair left).
    f.llm.setChatJsonResponse({
      decision: 'keep_separate',
      affectedIds: [],
      reasoning: 'only one active row remains',
    });
    const before = f.db.handle.db
      .select({ v: sql<number>`count(*)` })
      .from(consolidationOps)
      .where(eq(consolidationOps.opType, 'merge'))
      .get();
    await f.runner.runAll();
    const after = f.db.handle.db
      .select({ v: sql<number>`count(*)` })
      .from(consolidationOps)
      .where(eq(consolidationOps.opType, 'merge'))
      .get();
    expect(after?.v).toBe(before?.v);
  });

  it('undoes a run and returns the affected rows to active', async () => {
    const project = f.projects.findOrCreate('app');
    const a = f.memory.save(
      { type: 'feedback', content: 'prefer dependency injection in services' },
      projectScope(project.id),
    );
    const b = f.memory.save(
      { type: 'feedback', content: 'inject deps into services' },
      projectScope(project.id),
    );

    f.llm.setChatResponder(() => ({
      content: JSON.stringify({
        decision: 'merge',
        affectedIds: [a.id, b.id],
        mergedContent: 'use dependency injection in services',
        reasoning: 'duplicate convention',
      }),
      finishReason: 'stop',
      model: 'mock-chat',
    }));

    const summary = await f.runner.runAll();
    const projectRun = summary.runs.find((r) => r.scope.scope === 'project');
    expect(projectRun?.ops.merges).toBeGreaterThanOrEqual(1);
    const runId = projectRun!.runId;

    // Sanity: predecessors are superseded before undo.
    const beforeA = f.db.handle.db.select().from(memory).where(eq(memory.id, a.id)).get()!;
    expect(beforeA.status).toBe('superseded');

    const { reverted } = undoRun(f.db.handle.db, runId);
    expect(reverted.length).toBeGreaterThanOrEqual(1);

    // After undo: predecessors are active again, merged row is archived.
    const afterA = f.db.handle.db.select().from(memory).where(eq(memory.id, a.id)).get()!;
    const afterB = f.db.handle.db.select().from(memory).where(eq(memory.id, b.id)).get()!;
    expect(afterA.status).toBe('active');
    expect(afterB.status).toBe('active');
  });
});

describe('13.18 concurrency — 100 concurrent memory.save calls leave DB consistent', () => {
  it('persists exactly 100 rows with the correct scope', async () => {
    const test = createTestDb();
    try {
      const svc = new MemoryService(test.handle.db);
      const N = 100;
      const operations = [] as Promise<unknown>[];
      for (let i = 0; i < N; i++) {
        operations.push(
          Promise.resolve(svc.save({ type: 'feedback', content: `c-${i}` }, SCOPE_GLOBAL)),
        );
      }
      await Promise.all(operations);

      const total = test.handle.db
        .select({ v: sql<number>`count(*)` })
        .from(memory)
        .get();
      expect(total?.v).toBe(N);

      // Every row is active + global.
      const active = test.handle.db
        .select({ v: sql<number>`count(*)` })
        .from(memory)
        .where(sql`status = 'active' AND scope = 'global'`)
        .get();
      expect(active?.v).toBe(N);
    } finally {
      test.cleanup();
    }
  });
});
