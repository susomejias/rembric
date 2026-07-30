import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveTitle } from '../../services/memory.js';
import { createTestDb, type TestDb } from '../../test/db.js';
import { memory, type MemoryScope, type MemoryStatus, type NewMemory } from '../schema/memory.js';
import { projects } from '../schema/projects.js';

import { partitionKeyFor } from './scope-clause.js';
import { VectorsRepository } from './vectors-repository.js';

const DIMS = 768;

function unit(a: number, b: number): Float32Array {
  const v = new Float32Array(DIMS);
  const norm = Math.hypot(a, b);
  v[0] = a / norm;
  v[1] = b / norm;
  return v;
}

function row(overrides: Partial<NewMemory> & { id: string; content: string }): NewMemory {
  return {
    title: deriveTitle(overrides.content),
    scope: 'global',
    projectId: null,
    type: 'project',
    tags: [],
    status: 'active',
    replaces: [],
    createdAt: new Date(1_000),
    lastSeenAt: new Date(1_000),
    ...overrides,
  };
}

describe('VectorsRepository', () => {
  let t: TestDb;
  let repo: VectorsRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new VectorsRepository(t.handle.db);
    t.handle.db
      .insert(projects)
      .values([
        { id: 'p1', slug: 'project-one', createdAt: new Date(500) },
        { id: 'p2', slug: 'project-two', createdAt: new Date(500) },
      ])
      .run();
  });

  afterEach(() => {
    t.cleanup();
  });

  function insertWithEmbedding(
    id: string,
    embedding: Float32Array,
    opts: { scope?: MemoryScope; projectId?: string | null; status?: MemoryStatus } = {},
  ): void {
    const scope = opts.scope ?? 'global';
    const projectId = opts.projectId ?? null;
    const status = opts.status ?? 'active';
    t.handle.db
      .insert(memory)
      .values([row({ id, content: `content ${id}`, scope, projectId, status })])
      .run();
    repo.insertEmbedding(id, Buffer.from(embedding.buffer), partitionKeyFor(scope, projectId));
  }

  describe('knnCandidates', () => {
    it('returns in-scope active neighbors ordered by exact cosine distance, hydrated', () => {
      insertWithEmbedding('Q', unit(1, 0));
      insertWithEmbedding('A', unit(1, 0.1));
      insertWithEmbedding('B', unit(1, 0.4));
      insertWithEmbedding('C', unit(1, 1));
      insertWithEmbedding('S', unit(1, 0.05), { status: 'superseded' });

      const out = repo.knnCandidates({
        memoryId: 'Q',
        scope: 'global',
        projectId: null,
        excludeIds: [],
        limit: 2,
      });
      expect(out.map((n) => n.id)).toEqual(['A', 'B']);
      expect(out[0]!.distance).toBeCloseTo(1 - 1 / Math.hypot(1, 0.1), 5);
      expect(out[1]!.distance).toBeCloseTo(1 - 1 / Math.hypot(1, 0.4), 5);
      expect(out[0]!.title).toBe(deriveTitle('content A'));
      expect(out[0]!.content).toBe('content A');
    });

    it('over-fetch keeps result cardinality when the nearest neighbors are all excluded', () => {
      insertWithEmbedding('Q', unit(1, 0));
      insertWithEmbedding('A', unit(1, 0.1));
      insertWithEmbedding('B', unit(1, 0.2));
      insertWithEmbedding('C', unit(1, 0.5));
      insertWithEmbedding('D', unit(1, 1));

      const out = repo.knnCandidates({
        memoryId: 'Q',
        scope: 'global',
        projectId: null,
        excludeIds: ['A', 'B'],
        limit: 2,
      });
      expect(out.map((n) => n.id)).toEqual(['C', 'D']);
    });

    it('cross-scope rows never appear as candidates', () => {
      insertWithEmbedding('Q', unit(1, 0), { scope: 'project', projectId: 'p1' });
      insertWithEmbedding('IN', unit(1, 0.3), { scope: 'project', projectId: 'p1' });
      insertWithEmbedding('G', unit(1, 0), { scope: 'global', projectId: null });
      insertWithEmbedding('P2', unit(1, 0), { scope: 'project', projectId: 'p2' });

      const out = repo.knnCandidates({
        memoryId: 'Q',
        scope: 'project',
        projectId: 'p1',
        excludeIds: [],
        limit: 10,
      });
      expect(out.map((n) => n.id)).toEqual(['IN']);
    });

    it('is empty when the query row has no embedding yet', () => {
      t.handle.db
        .insert(memory)
        .values([row({ id: 'NOVEC', content: 'no vector yet' })])
        .run();
      expect(
        repo.knnCandidates({
          memoryId: 'NOVEC',
          scope: 'global',
          projectId: null,
          excludeIds: [],
          limit: 5,
        }),
      ).toEqual([]);
    });
  });

  describe('backlog count survives orphaned vec rows', () => {
    // `memory_vec` has no AFTER DELETE trigger, so a deleted memory leaves its
    // vector behind. A `count(memory) - count(memory_vec)` shortcut goes negative
    // there and would report a zero backlog while rows are genuinely pending.
    it('reports the real backlog when memory_vec holds more rows than memory', () => {
      insertWithEmbedding('m1', unit(1, 0));
      insertWithEmbedding('m2', unit(0, 1));
      t.handle.raw.exec("DELETE FROM memory WHERE id IN ('m1','m2')");
      t.handle.db
        .insert(memory)
        .values([row({ id: 'm3', content: 'needs an embedding' })])
        .run();

      expect(repo.adminBacklogCount()).toBe(1);
      expect(repo.findMissingEmbeddings(10).map((r) => r.id)).toEqual(['m3']);
    });

    // The case a `count(memory) - count(memory_vec)` shortcut cannot see: one
    // orphan against one pending row cancels to exactly zero.
    it('reports the real backlog when one orphan cancels one pending row', () => {
      insertWithEmbedding('m1', unit(1, 0));
      t.handle.raw.exec("DELETE FROM memory WHERE id = 'm1'");
      t.handle.db
        .insert(memory)
        .values([row({ id: 'm2', content: 'needs an embedding' })])
        .run();

      const memories = t.handle.raw.prepare('SELECT COUNT(*) v FROM memory').get();
      const vecs = t.handle.raw.prepare('SELECT COUNT(*) v FROM memory_vec').get();
      expect(memories).toEqual(vecs);
      expect(repo.adminBacklogCount()).toBe(1);
      expect(repo.findMissingEmbeddings(10).map((r) => r.id)).toEqual(['m2']);
    });

    it('reports zero when every memory is embedded', () => {
      insertWithEmbedding('m1', unit(1, 0));
      expect(repo.adminBacklogCount()).toBe(0);
      expect(repo.findMissingEmbeddings(10)).toEqual([]);
    });
  });

  describe('insertEmbedding status/type derivation (#257)', () => {
    it('derives status from the live memory row, not whatever was true earlier', () => {
      // Insert as 'active', then flip status BEFORE insertEmbedding runs —
      // simulating a supersede that lands while an embed was in flight.
      t.handle.db
        .insert(memory)
        .values([row({ id: 'RACE', content: 'content RACE', status: 'active' })])
        .run();
      t.handle.raw.prepare("UPDATE memory SET status = 'superseded' WHERE id = 'RACE'").run();

      repo.insertEmbedding('RACE', Buffer.from(unit(1, 0).buffer), partitionKeyFor('global', null));

      const row_ = t.handle.raw
        .prepare<[string], { status: string }>('SELECT status FROM memory_vec WHERE memory_id = ?')
        .get('RACE');
      expect(row_?.status).toBe('superseded');
    });

    it('inserts nothing if the memory row no longer exists', () => {
      repo.insertEmbedding('GONE', Buffer.from(unit(1, 0).buffer), partitionKeyFor('global', null));
      const count = t.handle.raw
        .prepare<[], { c: number }>('SELECT count(*) c FROM memory_vec')
        .get();
      expect(count?.c).toBe(0);
    });
  });
});
