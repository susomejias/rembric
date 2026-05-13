import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { consolidationOps } from '../db/schema/consolidation.js';
import { EmbeddingWorker } from '../services/embedding-worker.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { projectScope } from '../services/scope.js';
import { asLlmClient, createTestDb, MockLlmClient, type TestDb } from '../test/index.js';

import { ConsolidationRunner } from './runner.js';

let db: TestDb;
let projects: ProjectsService;
let memory: MemoryService;
let llm: MockLlmClient;
let runner: ConsolidationRunner;

beforeEach(() => {
  db = createTestDb();
  projects = new ProjectsService(db.handle.db);
  memory = new MemoryService(db.handle.db);
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
    embeddingWorker: worker,
  });
});

afterEach(() => {
  db.cleanup();
});

describe('ConsolidationRunner.runAll', () => {
  it('produces zero ops against an empty database', async () => {
    const summary = await runner.runAll();
    for (const r of summary.runs) {
      expect(r.ops.merges).toBe(0);
      expect(r.ops.supersedes).toBe(0);
      expect(r.ops.archives).toBe(0);
      expect(r.ops.noops).toBe(0);
      expect(r.ops.failed).toBe(0);
    }
  });

  it('keeps unrelated pairs separate when the judge says keep_separate', async () => {
    const project = projects.findOrCreate('app');
    memory.save({ type: 'user', content: 'apples' }, projectScope(project.id));
    memory.save({ type: 'user', content: 'oranges' }, projectScope(project.id));

    llm.setChatJsonResponse({
      decision: 'keep_separate',
      affectedIds: ['a', 'b'],
      reasoning: 'different fruits',
    });

    const summary = await runner.runAll();
    const projectRun = summary.runs.find((r) => r.scope.scope === 'project');
    expect(projectRun?.ops.merges).toBe(0);
    expect(projectRun?.ops.noops).toBeGreaterThanOrEqual(1);
  });

  it('idempotency: a second runAll on stable state produces no new merge/supersede ops', async () => {
    const project = projects.findOrCreate('app');
    memory.save({ type: 'user', content: 'a' }, projectScope(project.id));
    memory.save({ type: 'user', content: 'b' }, projectScope(project.id));

    llm.setChatJsonResponse({
      decision: 'keep_separate',
      affectedIds: ['a', 'b'],
      reasoning: 'distinct',
    });

    await runner.runAll();
    const opsAfterFirst = db.handle.db.select().from(consolidationOps).all().length;
    await runner.runAll();
    const opsAfterSecond = db.handle.db.select().from(consolidationOps).all().length;

    // Second run may add more noop journals on the same pair, but neither
    // run should produce merges or supersedes against unrelated content.
    const merges = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.opType, 'merge'))
      .all();
    const supersedes = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.opType, 'supersede'))
      .all();
    expect(merges.length).toBe(0);
    expect(supersedes.length).toBe(0);
    expect(opsAfterSecond).toBeGreaterThanOrEqual(opsAfterFirst);
  });
});
