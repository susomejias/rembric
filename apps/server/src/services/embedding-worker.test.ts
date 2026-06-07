import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { createTestDb, FakeEmbedder, type TestDb } from '../test/index.js';

import { EmbeddingWorker } from './embedding-worker.js';
import { MemoryService } from './memory.js';
import { SCOPE_GLOBAL } from './scope.js';

/**
 * 13.19 — embedding worker behavior (in-process embedder).
 *
 * Covers:
 *   - backfill: every memory missing a vector gets one
 *   - retry semantics on failure (skip now, retry next call)
 *   - skips archived rows
 *   - is idempotent (running twice does not double-insert)
 *   - early return without touching the embedder when nothing is pending
 */

let db: TestDb;
let mem: MemoryService;
let embedder: FakeEmbedder;
let worker: EmbeddingWorker;

beforeEach(() => {
  db = createTestDb();
  mem = new MemoryService(createRepositories(db.handle.db), db.handle.db);
  embedder = new FakeEmbedder();
  worker = new EmbeddingWorker({
    repos: createRepositories(db.handle.db),
    embedder,
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

  it('does not run inference when nothing is pending', async () => {
    const { processed } = await worker.processBatch();
    expect(processed).toBe(0);
    expect(embedder.calls.length).toBe(0);
  });

  it('embedNow inserts inline when the embedder is warm', async () => {
    const row = mem.save({ type: 'feedback', content: 'inline row' }, SCOPE_GLOBAL);
    const ok = await worker.embedNow(row.id, row.content);
    expect(ok).toBe(true);
    expect(vecCount()).toBe(1);
    // The drain has nothing left for this row.
    const { processed } = await worker.processBatch();
    expect(processed).toBe(0);
  });

  it('counts and continues past failures, retrying on the next call', async () => {
    mem.save({ type: 'feedback', content: 'fail-row-1' }, SCOPE_GLOBAL);
    mem.save({ type: 'feedback', content: 'fail-row-2' }, SCOPE_GLOBAL);
    embedder.failOnce(new Error('transient inference blip'));

    const { processed, failed } = await worker.processBatch();
    expect(failed).toBe(1);
    expect(processed).toBe(1);

    // Re-running retries the previously failed row and succeeds.
    const retry = await worker.processBatch();
    expect(retry.processed).toBe(1);
    expect(vecCount()).toBe(2);
  });
});
