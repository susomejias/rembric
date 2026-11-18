import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  EMBEDDING_DIMS,
  EMBEDDING_INPUT_VERSION,
  EmbeddingWorker,
  type Embedder,
  ensureVectorModel,
  vectorIdentityMatches,
} from '@rembric/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, partitionKeyFor, type DbHandle } from '@rembric/db';

import {
  createMigrationFixture,
  type MigrationFixture,
} from '../test-support/migration-fixture.js';

const MIGRATION = '0040_memory_vec_384.sql';

type Row = Record<string, unknown>;

let fx: MigrationFixture;

const hashEmbedder: Embedder = {
  modelId: 'hash-test-embedder',
  embed: (text) => {
    const digest = createHash('sha256').update(text).digest();
    const v = new Float32Array(EMBEDDING_DIMS);
    for (let i = 0; i < EMBEDDING_DIMS; i++) v[i] = digest[i % digest.length]! - 128;
    const norm = Math.hypot(...v);
    return Promise.resolve(v.map((x) => x / norm));
  },
};

const open = (): DbHandle => fx.open();
const vector = (dims: number, fill: number): Buffer =>
  Buffer.from(new Float32Array(dims).fill(fill).buffer);

function seed(handle: DbHandle): void {
  handle.raw.exec(`
    INSERT INTO projects (id, slug, display_name, archived_at, created_at)
      VALUES ('01PROJECTALPHA', 'alpha', NULL, NULL, 1000);
    INSERT INTO memory (id, scope, project_id, type, title, content, created_at, status)
      VALUES ('01MEMACTIVE', 'project', '01PROJECTALPHA', 'project', 'Active', 'active body', 1000, 'active');
    INSERT INTO memory (id, scope, project_id, type, title, content, created_at, status)
      VALUES ('01MEMSUPERSEDED', 'project', '01PROJECTALPHA', 'project', 'Old', 'old body', 900, 'superseded');
  `);
  const insert = handle.raw.prepare(
    'INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding) VALUES (?, ?, ?, ?, ?)',
  );
  insert.run('01MEMACTIVE', '01PROJECTALPHA', 'active', 'project', vector(768, 0.1));
  insert.run('01MEMSUPERSEDED', '01PROJECTALPHA', 'superseded', 'project', vector(768, 0.2));
}

beforeEach(() => {
  fx = createMigrationFixture(MIGRATION);
  fx.stagePrior();
});

afterEach(() => fx.cleanup());

describe('migration 0040 — memory_vec rebuilt at 384 dimensions', () => {
  it('drops every previous-model vector and leaves memory rows byte-identical', () => {
    const pre = open();
    seed(pre);
    const before = pre.raw.prepare<[], Row>('SELECT * FROM memory ORDER BY id').all();
    expect(before).toHaveLength(2);
    expect(pre.raw.prepare('SELECT count(*) AS n FROM memory_vec').get()).toEqual({ n: 2 });
    pre.close();

    fx.stage();
    const handle = open();
    try {
      expect(handle.raw.prepare('SELECT * FROM memory ORDER BY id').all()).toEqual(before);
      expect(handle.raw.prepare('SELECT count(*) AS n FROM memory_vec').get()).toEqual({ n: 0 });
      expect(handle.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('accepts a 384-dim vector and refuses a 768-dim one', () => {
    fx.stage();
    const handle = open();
    try {
      handle.raw.exec(`
        INSERT INTO projects (id, slug, display_name, archived_at, created_at)
          VALUES ('01PROJECTALPHA', 'alpha', NULL, NULL, 1000);
        INSERT INTO memory (id, scope, project_id, type, title, content, created_at, status)
          VALUES ('01MEMNEW', 'project', '01PROJECTALPHA', 'project', 'New', 'new body', 1000, 'active');
      `);
      const insert = handle.raw.prepare(
        'INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding) VALUES (?, ?, ?, ?, ?)',
      );
      expect(() =>
        insert.run('01MEMNEW', '01PROJECTALPHA', 'active', 'project', vector(768, 0.1)),
      ).toThrow(/dimension/i);
      insert.run('01MEMNEW', '01PROJECTALPHA', 'active', 'project', vector(384, 0.1));
      expect(handle.raw.prepare('SELECT count(*) AS n FROM memory_vec').get()).toEqual({ n: 1 });
    } finally {
      handle.close();
    }
  });

  it('keeps the status trigger mirroring memory.status into the rebuilt index', () => {
    fx.stage();
    const handle = open();
    try {
      handle.raw.exec(`
        INSERT INTO projects (id, slug, display_name, archived_at, created_at)
          VALUES ('01PROJECTALPHA', 'alpha', NULL, NULL, 1000);
        INSERT INTO memory (id, scope, project_id, type, title, content, created_at, status)
          VALUES ('01MEMNEW', 'project', '01PROJECTALPHA', 'project', 'New', 'new body', 1000, 'active');
      `);
      handle.raw
        .prepare(
          'INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding) VALUES (?, ?, ?, ?, ?)',
        )
        .run('01MEMNEW', '01PROJECTALPHA', 'active', 'project', vector(384, 0.1));
      handle.raw.exec("UPDATE memory SET status = 'archived' WHERE id = '01MEMNEW'");
      expect(
        handle.raw.prepare("SELECT status FROM memory_vec WHERE memory_id = '01MEMNEW'").get(),
      ).toEqual({ status: 'archived' });
    } finally {
      handle.close();
    }
  });

  it('re-embeds an upgraded data directory through the identity reset and serves kNN from it', async () => {
    const pre = open();
    seed(pre);
    pre.close();
    writeFileSync(
      join(fx.dataDir, 'embedding-state.json'),
      JSON.stringify({
        modelId: 'onnx-community/gte-multilingual-base',
        inputVersion: EMBEDDING_INPUT_VERSION,
      }),
    );

    fx.stage();
    const handle = open();
    try {
      const repos = createRepositories(handle.db);
      expect(vectorIdentityMatches(fx.dataDir)).toBe(false);
      expect(ensureVectorModel(repos, fx.dataDir).markerWritten).toBe(true);
      expect(vectorIdentityMatches(fx.dataDir)).toBe(true);

      const worker = new EmbeddingWorker({ repos, embedder: hashEmbedder });
      while ((await worker.processBatch()).processed > 0) {
        /* drain */
      }
      const embedded = handle.raw
        .prepare<[], { memory_id: string }>('SELECT memory_id FROM memory_vec ORDER BY memory_id')
        .all()
        .map((r) => r.memory_id);
      expect(embedded).toEqual(['01MEMACTIVE', '01MEMSUPERSEDED']);

      const query = await hashEmbedder.embed('Active\n\nactive body');
      const hits = repos.vectors.knnByQueryVector({
        queryVector: query,
        partitionKeys: [partitionKeyFor('01PROJECTALPHA')],
        status: 'active',
        rankWindowSize: 5,
      });
      expect(hits[0]?.id).toBe('01MEMACTIVE');
      expect(hits[0]?.distance).toBeCloseTo(0, 5);
    } finally {
      handle.close();
    }
  });
});
