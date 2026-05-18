import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EmbeddingWorker } from '../services/embedding-worker.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { RelationsService } from '../services/relations.js';
import { asLlmClient, createTestDb, MockLlmClient, type TestDb } from '../test/index.js';

import { ConsolidationRunner } from './runner.js';

/**
 * Runner happy-path tests for the v0.5 consolidator.
 *
 * The runner no longer does LLM-driven detection over the whole corpus
 * — that work moved to `memory.save`. What remains:
 *   - decay sweep (deterministic, no LLM)
 *   - orphan promotion (LLM judge over `memory_relations` rows whose
 *     `status='pending'` and `created_at` is older than the threshold)
 *
 * Detailed orphan-promotion correctness lives in
 * `consolidation/orphan-promotion.test.ts`.
 */

let db: TestDb;
let runner: ConsolidationRunner;

beforeEach(() => {
  db = createTestDb();
  const llm = new MockLlmClient();
  const worker = new EmbeddingWorker({
    db: db.handle.db,
    client: asLlmClient(llm),
    model: 'mock-embed',
  });
  const relations = new RelationsService(db.handle.db);
  // The services below are constructed for parity with the production
  // boot; they aren't directly exercised here.
  new ProjectsService(db.handle.db);
  new MemoryService(db.handle.db);

  runner = new ConsolidationRunner({
    db: db.handle.db,
    llm: asLlmClient(llm),
    model: 'mock-chat',
    batchSize: 50,
    relations,
    embeddingWorker: worker,
    llmEnabled: false, // disable orphan-promotion in these baseline tests
  });
});

afterEach(() => db.cleanup());

describe('ConsolidationRunner.runAll', () => {
  it('produces zero ops against an empty database', async () => {
    const summary = await runner.runAll();
    for (const r of summary.runs) {
      expect(r.ops.archives).toBe(0);
      expect(r.ops.orphanPromoted).toBe(0);
      expect(r.ops.orphanFailed).toBe(0);
    }
  });

  it('records one consolidation_runs row per scope, summary closed', async () => {
    const summary = await runner.runAll();
    expect(summary.runs.length).toBeGreaterThan(0);
    for (const r of summary.runs) {
      expect(r.runId.length).toBeGreaterThan(0);
    }
  });
});
