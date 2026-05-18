import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { LlmError } from '../llm/index.js';
import { asLlmClient, createTestDb, MockLlmClient, type TestDb } from '../test/index.js';

import { EmbeddingWorker } from './embedding-worker.js';
import { MemoryService } from './memory.js';
import { SCOPE_GLOBAL } from './scope.js';

/**
 * 13.19 — embedding worker behavior.
 *
 * Covers:
 *   - backfill: every memory missing a vector gets one
 *   - retry semantics on transient failure
 *   - hard failure (auth, rate_limited) surfaces immediately
 *   - skips archived rows
 *   - is idempotent (running twice does not double-insert)
 */

let db: TestDb;
let mem: MemoryService;
let llm: MockLlmClient;
let worker: EmbeddingWorker;

beforeEach(() => {
  db = createTestDb();
  mem = new MemoryService(db.handle.db);
  llm = new MockLlmClient();
  worker = new EmbeddingWorker({
    db: db.handle.db,
    client: asLlmClient(llm),
    model: 'mock-embed',
    batchSize: 50,
  });
});

afterEach(() => db.cleanup());

function vecCount(): number {
  const row = db.handle.db.get<{ v: number }>(sql`SELECT COUNT(*) AS v FROM memory_vec`) as
    | { v: number }
    | undefined;
  return row?.v ?? 0;
}

describe('EmbeddingWorker', () => {
  it('backfills every active memory exactly once', async () => {
    mem.save({ type: 'feedback', content: 'one' }, SCOPE_GLOBAL);
    mem.save({ type: 'feedback', content: 'two' }, SCOPE_GLOBAL);
    mem.save({ type: 'feedback', content: 'three' }, SCOPE_GLOBAL);

    const { processed, failed } = await worker.processBatch();
    expect(processed).toBe(3);
    expect(failed).toBe(0);
    expect(vecCount()).toBe(3);

    // Running again is a no-op: no rows remain unembedded.
    const second = await worker.processBatch();
    expect(second.processed).toBe(0);
    expect(second.failed).toBe(0);
    expect(vecCount()).toBe(3);
  });

  it('skips archived memories', async () => {
    mem.save({ type: 'feedback', content: 'live' }, SCOPE_GLOBAL);
    const dead = mem.save({ type: 'feedback', content: 'dead' }, SCOPE_GLOBAL);
    mem.archive(dead.id, SCOPE_GLOBAL);

    const { processed } = await worker.processBatch();
    expect(processed).toBe(1);
    expect(vecCount()).toBe(1);
  });

  it('rethrows hard LLM errors (auth) so the caller can surface them', async () => {
    mem.save({ type: 'feedback', content: 'auth-fail-row' }, SCOPE_GLOBAL);
    llm.setEmbeddingResponder(() => {
      throw new LlmError('auth', 'forged-auth-error');
    });

    await expect(worker.processBatch()).rejects.toThrowError(LlmError);
  });

  it('counts and continues past soft failures (e.g. transient embedding error)', async () => {
    mem.save({ type: 'feedback', content: 'soft-fail-row-1' }, SCOPE_GLOBAL);
    mem.save({ type: 'feedback', content: 'soft-fail-row-2' }, SCOPE_GLOBAL);

    let call = 0;
    llm.setEmbeddingResponder((opts) => {
      call += 1;
      if (call === 1) {
        // Soft error: a domain error that isn't auth/rate_limited.
        throw new LlmError('network', 'transient network blip');
      }
      // Second call succeeds — fall back to deterministic embedding.
      return { embedding: new Float32Array(768), model: opts.model };
    });

    const { processed, failed } = await worker.processBatch();
    expect(failed).toBe(1);
    expect(processed).toBe(1);
    // Re-running should retry the previously failed row and succeed.
    llm.setEmbeddingResponder((opts) => ({
      embedding: new Float32Array(768),
      model: opts.model,
    }));
    const retry = await worker.processBatch();
    expect(retry.processed).toBe(1);
    expect(vecCount()).toBe(2);
  });
});
