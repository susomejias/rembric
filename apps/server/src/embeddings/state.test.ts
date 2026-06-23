import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { EmbeddingWorker } from '../services/embedding-worker.js';
import { MemoryService } from '../services/memory.js';
import { SCOPE_GLOBAL } from '../services/scope.js';
import { createTestDb, FakeEmbedder, type TestDb } from '../test/index.js';

import { EMBEDDING_INPUT_VERSION, EMBEDDING_MODEL_ID } from './embedder.js';
import { ensureVectorModel } from './state.js';

let db: TestDb;
let mem: MemoryService;

beforeEach(() => {
  db = createTestDb();
  mem = new MemoryService(createRepositories(db.handle.db), db.handle.db);
});

afterEach(() => db.cleanup());

function vecCount(): number {
  const row = db.handle.db.get<{ v: number }>(sql`SELECT COUNT(*) AS v FROM memory_vec`) as
    | { v: number }
    | undefined;
  return row?.v ?? 0;
}

describe('ensureVectorModel', () => {
  it('first run writes the marker without wiping an empty table', () => {
    const { wiped } = ensureVectorModel(createRepositories(db.handle.db), db.dataDir);
    expect(wiped).toBe(0);
    const marker = JSON.parse(readFileSync(join(db.dataDir, 'embedding-state.json'), 'utf8')) as {
      modelId: string;
      inputVersion: string;
    };
    expect(marker.modelId).toBe(EMBEDDING_MODEL_ID);
    expect(marker.inputVersion).toBe(EMBEDDING_INPUT_VERSION);
  });

  it('input-version mismatch (pre-v2 marker) wipes stale vectors and re-embeds', async () => {
    mem.save({ type: 'feedback', title: 'row', content: 'row' }, SCOPE_GLOBAL);
    await new EmbeddingWorker({
      repos: createRepositories(db.handle.db),
      embedder: new FakeEmbedder(),
    }).processBatch();
    expect(vecCount()).toBe(1);

    // Simulate a pre-v2 marker: correct model, but the old content-only recipe
    // (no inputVersion field). The recipe axis must force a re-embed.
    writeFileSync(
      join(db.dataDir, 'embedding-state.json'),
      JSON.stringify({ modelId: EMBEDDING_MODEL_ID }) + '\n',
    );
    const { wiped } = ensureVectorModel(createRepositories(db.handle.db), db.dataDir);
    expect(wiped).toBe(1);
    expect(vecCount()).toBe(0);

    const marker = JSON.parse(readFileSync(join(db.dataDir, 'embedding-state.json'), 'utf8')) as {
      inputVersion: string;
    };
    expect(marker.inputVersion).toBe(EMBEDDING_INPUT_VERSION);
  });

  it('matching marker is a no-op even with vectors present', async () => {
    ensureVectorModel(createRepositories(db.handle.db), db.dataDir);
    mem.save({ type: 'feedback', title: 'row', content: 'row' }, SCOPE_GLOBAL);
    await new EmbeddingWorker({
      repos: createRepositories(db.handle.db),
      embedder: new FakeEmbedder(),
    }).processBatch();
    expect(vecCount()).toBe(1);

    const { wiped } = ensureVectorModel(createRepositories(db.handle.db), db.dataDir);
    expect(wiped).toBe(0);
    expect(vecCount()).toBe(1);
  });

  it('model mismatch wipes stale vectors and the drain re-embeds (resumable backfill)', async () => {
    // Simulate the pre-upgrade era: vectors exist, no marker.
    mem.save(
      { type: 'feedback', title: 'old-vector-row', content: 'old-vector-row' },
      SCOPE_GLOBAL,
    );
    mem.save(
      { type: 'feedback', title: 'old-vector-row-2', content: 'old-vector-row-2' },
      SCOPE_GLOBAL,
    );
    const worker = new EmbeddingWorker({
      repos: createRepositories(db.handle.db),
      embedder: new FakeEmbedder(),
    });
    await worker.processBatch();
    expect(vecCount()).toBe(2);

    const { wiped } = ensureVectorModel(createRepositories(db.handle.db), db.dataDir);
    expect(wiped).toBe(2);
    expect(vecCount()).toBe(0);

    // The regular drain refills — in batches, resumable by construction.
    const batched = new EmbeddingWorker({
      repos: createRepositories(db.handle.db),
      embedder: new FakeEmbedder(),
      batchSize: 1,
    });
    await batched.processBatch();
    expect(vecCount()).toBe(1); // interrupted here → next call resumes
    await batched.processBatch();
    expect(vecCount()).toBe(2);
  });
});
