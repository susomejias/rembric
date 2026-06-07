import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../../test/db.js';
import { confirmations } from '../schema/confirmations.js';
import { memory, type NewMemory } from '../schema/memory.js';
import { projects } from '../schema/projects.js';

import { MemoryRepository } from './memory-repository.js';

function row(overrides: Partial<NewMemory> & { id: string; content: string }): NewMemory {
  return {
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

describe('MemoryRepository', () => {
  let t: TestDb;
  let repo: MemoryRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new MemoryRepository(t.handle.db);
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

  describe('adminSearchFts', () => {
    beforeEach(() => {
      t.handle.db
        .insert(memory)
        .values([
          row({ id: '01A', content: 'alpha bravo', createdAt: new Date(1_000) }),
          row({
            id: '01B',
            content: 'bravo charlie',
            createdAt: new Date(2_000),
            scope: 'project',
            projectId: 'p1',
            status: 'archived',
          }),
          row({ id: '01C', content: 'delta', createdAt: new Date(3_000) }),
        ])
        .run();
    });

    it('matches across all scopes and statuses', () => {
      const hits = repo.adminSearchFts('bravo', 10, 0);
      expect(hits.map((m) => m.id).sort()).toEqual(['01A', '01B']);
    });

    it('returns hydrated rows', () => {
      const [hit] = repo.adminSearchFts('delta', 10, 0);
      expect(hit?.content).toBe('delta');
      expect(hit?.status).toBe('active');
    });

    it('pages consistently with limit/offset', () => {
      const all = repo.adminSearchFts('bravo', 2, 0).map((m) => m.id);
      const first = repo.adminSearchFts('bravo', 1, 0).map((m) => m.id);
      const second = repo.adminSearchFts('bravo', 1, 1).map((m) => m.id);
      expect([...first, ...second].sort()).toEqual([...all].sort());
    });

    it('returns empty for no matches', () => {
      expect(repo.adminSearchFts('zulu', 10, 0)).toEqual([]);
    });
  });

  describe('adminList', () => {
    beforeEach(() => {
      t.handle.db
        .insert(memory)
        .values([
          row({ id: '02A', content: 'g active', createdAt: new Date(1_000) }),
          row({ id: '02B', content: 'g archived', status: 'archived', createdAt: new Date(2_000) }),
          row({
            id: '02C',
            content: 'p1 active',
            scope: 'project',
            projectId: 'p1',
            type: 'feedback',
            createdAt: new Date(3_000),
          }),
          row({
            id: '02D',
            content: 'p2 active',
            scope: 'project',
            projectId: 'p2',
            createdAt: new Date(4_000),
          }),
        ])
        .run();
    });

    it('filters by status and orders newest first', () => {
      const rows = repo.adminList({ status: 'active', limit: 10, offset: 0 });
      expect(rows.map((m) => m.id)).toEqual(['02D', '02C', '02A']);
    });

    it('filters by type', () => {
      const rows = repo.adminList({ status: 'active', type: 'feedback', limit: 10, offset: 0 });
      expect(rows.map((m) => m.id)).toEqual(['02C']);
    });

    it('filters global-only', () => {
      const rows = repo.adminList({
        status: 'active',
        project: { kind: 'global' },
        limit: 10,
        offset: 0,
      });
      expect(rows.map((m) => m.id)).toEqual(['02A']);
    });

    it('filters by project id', () => {
      const rows = repo.adminList({
        status: 'active',
        project: { kind: 'project', projectId: 'p2' },
        limit: 10,
        offset: 0,
      });
      expect(rows.map((m) => m.id)).toEqual(['02D']);
    });

    it('respects limit and offset', () => {
      const rows = repo.adminList({ status: 'active', limit: 1, offset: 1 });
      expect(rows.map((m) => m.id)).toEqual(['02C']);
    });
  });

  describe('absorbed query helpers', () => {
    beforeEach(() => {
      t.handle.db
        .insert(memory)
        .values([
          row({ id: '03A', content: 'global one', createdAt: new Date(1_000) }),
          row({
            id: '03B',
            content: 'project one',
            scope: 'project',
            projectId: 'p1',
            createdAt: new Date(2_000),
          }),
          row({ id: '03C', content: 'gone', status: 'superseded', createdAt: new Date(3_000) }),
        ])
        .run();
    });

    it('findById / findByIds / adminGetByIds', () => {
      expect(repo.findById('03A')?.content).toBe('global one');
      expect(repo.findById('nope')).toBeUndefined();
      expect(repo.findByIds([])).toEqual([]);
      expect(
        repo
          .adminGetByIds(['03A', '03B'])
          .map((m) => m.id)
          .sort(),
      ).toEqual(['03A', '03B']);
    });

    it('findActiveByScope scopes correctly', () => {
      expect(repo.findActiveByScope({ scope: 'global' }).map((m) => m.id)).toEqual(['03A']);
      expect(
        repo.findActiveByScope({ scope: 'project', projectId: 'p1' }).map((m) => m.id),
      ).toEqual(['03B']);
      expect(
        repo
          .findActiveByScope({ scope: 'project', projectId: 'p1', includeGlobal: true })
          .map((m) => m.id),
      ).toEqual(['03B', '03A']);
    });

    it('countByStatus', () => {
      expect(repo.countByStatus('active')).toBe(2);
      expect(repo.countByStatus('superseded')).toBe(1);
      expect(repo.countByStatus('archived')).toBe(0);
    });
  });

  it('adminCountConfirmations counts events for a memory', () => {
    t.handle.db
      .insert(memory)
      .values([row({ id: '04A', content: 'confirmed' })])
      .run();
    t.handle.db
      .insert(confirmations)
      .values([
        { id: 'c1', memoryId: '04A', eventTs: new Date(1_000) },
        { id: 'c2', memoryId: '04A', eventTs: new Date(2_000) },
      ])
      .run();
    expect(repo.adminCountConfirmations('04A')).toBe(2);
    expect(repo.adminCountConfirmations('missing')).toBe(0);
  });
});
