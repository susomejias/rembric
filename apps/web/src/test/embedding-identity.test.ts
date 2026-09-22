import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  EMBEDDING_DIMS,
  EMBEDDING_DTYPE,
  EMBEDDING_MODEL_ID,
  EMBEDDING_MODEL_REVISION,
  EMBEDDING_ONNX_ARTIFACT,
  EmbeddingWorker,
  MemoryService,
  embeddingOnnxArtifactPath,
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
      modelId: 'onnx-community/gte-multilingual-base',
      dtype: 'q8',
      dims: 768,
      revision: '2edbf5e672aab465f9ed4c154a8b61791c082c69',
      onnxArtifact: 'onnx/model_quantized.onnx',
    });
    expect(EMBEDDING_MODEL_ID).toBe('onnx-community/gte-multilingual-base');
    expect(EMBEDDING_DTYPE).toBe('q8');
    expect(EMBEDDING_DIMS).toBe(768);
    expect(EMBEDDING_MODEL_REVISION).toBe('2edbf5e672aab465f9ed4c154a8b61791c082c69');
    expect(EMBEDDING_ONNX_ARTIFACT).toBe('onnx/model_quantized.onnx');
  });

  it('keeps embedder.ts and fetch-model.mjs importing that source, not redefining it', () => {
    expect(embedderSource).toContain("from './model-identity.json'");
    expect(embedderSource).not.toContain('onnx-community/gte-multilingual-base');
    expect(fetchScript).toContain("from '../src/embeddings/model-identity.json'");
    expect(fetchScript).toContain('identity.modelId');
    expect(fetchScript).not.toContain('onnx-community/gte-multilingual-base');
    expect(fetchScript).not.toContain('2edbf5e672aab465f9ed4c154a8b61791c082c69');
  });

  it('keeps the Dockerfile model-bake gate pointing at the derived artifact path', () => {
    expect(dockerfile).toContain(embeddingOnnxArtifactPath('/models'));
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
