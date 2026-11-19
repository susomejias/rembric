import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EMBEDDING_DIMS,
  EMBEDDING_DTYPE,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_REVISION,
  EMBEDDING_ONNX_ARTIFACT,
  EMBEDDING_POOLING,
  EmbeddingWorker,
  MemoryService,
  embeddingOnnxArtifactPath,
  rerankOnnxArtifactPath,
  vectorIdentityMatches,
} from '@rembric/core';
import { createRepositories } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resetVectorModelOnLoad } from '../lib/services';

import { FakeEmbedder, createTestDb, defaultProjectScope, type TestDb } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');

const dockerfile = readFileSync(join(repoRoot, 'apps/web/Dockerfile'), 'utf8');
const fetchScript = readFileSync(join(repoRoot, 'packages/core/scripts/fetch-model.mjs'), 'utf8');
const embedderSource = readFileSync(
  join(repoRoot, 'packages/core/src/embeddings/embedder.ts'),
  'utf8',
);
const identitySource = JSON.parse(
  readFileSync(join(repoRoot, 'packages/core/src/embeddings/model-identity.json'), 'utf8'),
) as Record<string, unknown>;

describe('embedding model identity has a single source', () => {
  it('pins the frozen recipe in the shared identity module', () => {
    expect(identitySource).toEqual({
      modelId: 'hindsight-ai/hs-embed-1',
      dtype: 'fp32',
      dims: 384,
      pooling: 'mean',
      maxTokens: 1024,
      revision: '3164caa4db95a03faac8a327f914f7c8f42d2f98',
      onnxArtifact: 'onnx/model.onnx',
    });
    expect(EMBEDDING_MODEL_ID).toBe('hindsight-ai/hs-embed-1');
    expect(EMBEDDING_DTYPE).toBe('fp32');
    expect(EMBEDDING_POOLING).toBe('mean');
    expect(EMBEDDING_DIMS).toBe(384);
    expect(EMBEDDING_MODEL_REVISION).toBe('3164caa4db95a03faac8a327f914f7c8f42d2f98');
    expect(EMBEDDING_ONNX_ARTIFACT).toBe('onnx/model.onnx');
  });

  it('keeps embedder.ts and fetch-model.mjs importing that source, not redefining it', () => {
    expect(embedderSource).toContain("from './model-identity.json'");
    expect(embedderSource).not.toContain('hindsight-ai/hs-embed-1');
    expect(embedderSource).not.toMatch(/pooling: '(cls|mean)'/);
    expect(fetchScript).toContain("from '../src/embeddings/model-identity.json'");
    expect(fetchScript).toContain("from '../src/rerank/model-identity.json'");
    expect(fetchScript).toContain('identity.modelId');
    expect(fetchScript).not.toContain('hindsight-ai/hs-embed-1');
    expect(fetchScript).toContain('e.maxTokens');
    expect(fetchScript).not.toContain('hindsight-ai/hs-rerank-1');
    expect(fetchScript).not.toContain('3164caa4db95a03faac8a327f914f7c8f42d2f98');
  });

  it('keeps the newest memory_vec definition at the compiled-in dimension', () => {
    const migrationsDir = join(repoRoot, 'packages/db/src/migrations');
    const definitions = readdirSync(migrationsDir)
      .filter((f) => f.endsWith('.sql'))
      .sort()
      .map((f) => readFileSync(join(migrationsDir, f), 'utf8'))
      .filter((sql) => sql.includes('CREATE VIRTUAL TABLE `memory_vec`'));
    expect(definitions.at(-1)).toContain(`embedding FLOAT[${EMBEDDING_DIMS}]`);
  });

  it('keeps the Dockerfile model-bake gate pointing at the derived artifact path', () => {
    expect(dockerfile).toContain(embeddingOnnxArtifactPath('/models'));
    expect(dockerfile).toContain(rerankOnnxArtifactPath('/models'));
  });
});

describe('vector-identity check runs when the embedder first loads', () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.cleanup());

  function seedStaleVector(): ReturnType<typeof createRepositories> {
    const repos = createRepositories(db.handle.db);
    const mem = new MemoryService(repos, db.handle.db);
    mem.save({ type: 'feedback', title: 'row', content: 'row' }, defaultProjectScope(db.handle));
    return repos;
  }

  it('wipes vectors and settles the marker when the recorded identity does not match', async () => {
    const repos = seedStaleVector();
    await new EmbeddingWorker({ repos, embedder: new FakeEmbedder() }).processBatch();
    expect(repos.vectors.count()).toBe(1);

    const outcome = resetVectorModelOnLoad({ vectors: repos.vectors }, db.dataDir);

    expect(outcome.wiped).toBe(1);
    expect(repos.vectors.count()).toBe(0);
    expect(vectorIdentityMatches(db.dataDir)).toBe(true);
  });

  it('leaves vectors untouched when the recorded identity already matches', async () => {
    const repos = createRepositories(db.handle.db);
    resetVectorModelOnLoad({ vectors: repos.vectors }, db.dataDir);

    const mem = new MemoryService(repos, db.handle.db);
    mem.save({ type: 'feedback', title: 'row', content: 'row' }, defaultProjectScope(db.handle));
    await new EmbeddingWorker({ repos, embedder: new FakeEmbedder() }).processBatch();
    expect(repos.vectors.count()).toBe(1);

    const outcome = resetVectorModelOnLoad({ vectors: repos.vectors }, db.dataDir);

    expect(outcome.wiped).toBe(0);
    expect(repos.vectors.count()).toBe(1);
  });

  it('defers (never throws) when the reset itself fails, so the load path stays usable', () => {
    const outcome = resetVectorModelOnLoad(
      {
        vectors: {
          count: () => {
            throw new Error('vector table unavailable');
          },
          deleteAll: () => undefined,
        } as unknown as ReturnType<typeof createRepositories>['vectors'],
      },
      db.dataDir,
    );

    expect(outcome.deferred).toBe(true);
    expect(outcome.wiped).toBe(0);
  });
});
