import { getTableConfig, type SQLiteTable } from 'drizzle-orm/sqlite-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveTitle } from '../../services/memory.js';
import { createTestDb, type TestDb } from '../../test/db.js';
import { memory, type NewMemory } from '../schema/memory.js';
import { projects } from '../schema/projects.js';

import { EntitiesRepository } from './entities-repository.js';

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

describe('EntitiesRepository', () => {
  let t: TestDb;
  let repo: EntitiesRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new EntitiesRepository(t.handle.db);
    t.handle.db
      .insert(projects)
      .values([{ id: 'p1', slug: 'project-one', createdAt: new Date(500) }])
      .run();
  });

  afterEach(() => {
    t.cleanup();
  });

  function insertMemory(id: string, opts: Partial<NewMemory> = {}): void {
    t.handle.db
      .insert(memory)
      .values(row({ id, content: 'x', ...opts }))
      .run();
  }

  describe('linkMemory + findMemoriesByEntity', () => {
    it('links a memory to entities and finds it back by exact value', () => {
      insertMemory('m1', { content: 'apps/server/src/db/migrate.ts' });
      repo.linkMemory(
        'm1',
        'global',
        null,
        [{ kind: 'path', value: 'apps/server/src/db/migrate.ts' }],
        new Date(),
      );

      const found = repo.findMemoriesByEntity({
        scope: 'global',
        projectId: null,
        value: 'apps/server/src/db/migrate.ts',
        limit: 10,
      });
      expect(found.map((m) => m.id)).toEqual(['m1']);
    });

    it('the same path in two projects does not join them', () => {
      insertMemory('m1', { scope: 'project', projectId: 'p1' });
      repo.linkMemory('m1', 'project', 'p1', [{ kind: 'path', value: 'src/x.ts' }], new Date());

      const foundGlobal = repo.findMemoriesByEntity({
        scope: 'global',
        projectId: null,
        value: 'src/x.ts',
        limit: 10,
      });
      expect(foundGlobal).toEqual([]);
    });

    it('twenty linked memories all return, ordered chronologically', () => {
      for (let i = 0; i < 20; i++) {
        insertMemory(`m${i}`, { createdAt: new Date(1000 + i) });
        repo.linkMemory(
          `m${i}`,
          'global',
          null,
          [{ kind: 'error_code', value: 'ENOENT' }],
          new Date(),
        );
      }
      const found = repo.findMemoriesByEntity({
        scope: 'global',
        projectId: null,
        value: 'ENOENT',
        limit: 100,
      });
      expect(found).toHaveLength(20);
      expect(found[0]!.id).toBe('m19');
      expect(found[19]!.id).toBe('m0');
    });

    it('an unknown entity returns empty', () => {
      const found = repo.findMemoriesByEntity({
        scope: 'global',
        projectId: null,
        value: 'never-linked',
        limit: 10,
      });
      expect(found).toEqual([]);
    });

    it('excludes archived memories by default', () => {
      insertMemory('m1', { status: 'archived' });
      repo.linkMemory('m1', 'global', null, [{ kind: 'path', value: 'x.ts' }], new Date());
      expect(
        repo.findMemoriesByEntity({
          scope: 'global',
          projectId: null,
          value: 'x.ts',
          limit: 10,
        }),
      ).toEqual([]);
      expect(
        repo.findMemoriesByEntity({
          scope: 'global',
          projectId: null,
          value: 'x.ts',
          status: 'archived',
          limit: 10,
        }),
      ).toHaveLength(1);
    });

    it('filters by status, type, tag and topic_key like the ranked branches', () => {
      insertMemory('active-user', { type: 'user', tags: ['ops'], topicKey: 'topic/a' });
      insertMemory('superseded-project', { type: 'project', tags: [], status: 'superseded' });
      for (const id of ['active-user', 'superseded-project']) {
        repo.linkMemory(id, 'global', null, [{ kind: 'path', value: 'x.ts' }], new Date());
      }
      const base = { scope: 'global', projectId: null, value: 'x.ts', limit: 10 } as const;

      expect(
        repo
          .findMemoriesByEntity(base)
          .map((m) => m.id)
          .sort(),
      ).toEqual(['active-user', 'superseded-project']);
      expect(repo.findMemoriesByEntity({ ...base, status: 'active' }).map((m) => m.id)).toEqual([
        'active-user',
      ]);
      expect(repo.findMemoriesByEntity({ ...base, type: 'project' }).map((m) => m.id)).toEqual([
        'superseded-project',
      ]);
      expect(repo.findMemoriesByEntity({ ...base, tag: 'ops' }).map((m) => m.id)).toEqual([
        'active-user',
      ]);
      expect(repo.findMemoriesByEntity({ ...base, topicKey: 'topic/a' }).map((m) => m.id)).toEqual([
        'active-user',
      ]);
    });

    it('returns only the read scope, with no argument that widens it', () => {
      t.handle.db
        .insert(projects)
        .values([{ id: 'p2', slug: 'project-two', createdAt: new Date(500) }])
        .run();
      insertMemory('g1');
      insertMemory('p1m', { scope: 'project', projectId: 'p1' });
      insertMemory('p2m', { scope: 'project', projectId: 'p2' });
      repo.linkMemory('g1', 'global', null, [{ kind: 'path', value: 'shared.ts' }], new Date());
      repo.linkMemory('p1m', 'project', 'p1', [{ kind: 'path', value: 'shared.ts' }], new Date());
      repo.linkMemory('p2m', 'project', 'p2', [{ kind: 'path', value: 'shared.ts' }], new Date());

      const scoped = { scope: 'project', projectId: 'p1', value: 'shared.ts', limit: 10 } as const;
      expect(repo.findMemoriesByEntity(scoped).map((m) => m.id)).toEqual(['p1m']);
      // The non-vacuity control: the rows excluded above are reachable, so the
      // assertion is about the scope predicate rather than about an empty index.
      expect(repo.findMemoriesByEntity({ ...scoped, projectId: 'p2' }).map((m) => m.id)).toEqual([
        'p2m',
      ]);
    });

    it('is idempotent — linking the same memory twice does not duplicate', () => {
      insertMemory('m1');
      repo.linkMemory('m1', 'global', null, [{ kind: 'path', value: 'x.ts' }], new Date());
      repo.linkMemory('m1', 'global', null, [{ kind: 'path', value: 'x.ts' }], new Date());
      const found = repo.findMemoriesByEntity({
        scope: 'global',
        projectId: null,
        value: 'x.ts',
        limit: 10,
      });
      expect(found).toHaveLength(1);
    });
  });

  describe('findEntitiesForMemory', () => {
    it('projects a memory onto its linked entities', () => {
      insertMemory('m1');
      repo.linkMemory(
        'm1',
        'global',
        null,
        [
          { kind: 'path', value: 'x.ts' },
          { kind: 'error_code', value: 'ENOENT' },
        ],
        new Date(),
      );
      const found = repo.findEntitiesForMemory('m1');
      expect(found).toHaveLength(2);
      expect(found.map((e) => e.value).sort()).toEqual(['ENOENT', 'x.ts']);
    });

    it('returns empty for a memory with no linked entities', () => {
      insertMemory('m1');
      expect(repo.findEntitiesForMemory('m1')).toEqual([]);
    });
  });

  describe('scopeActiveMemoryCount and entityLinkCount', () => {
    it('count only active rows, excluding superseded and archived alike', () => {
      insertMemory('m1');
      insertMemory('m2');
      insertMemory('m3', { status: 'superseded' });
      insertMemory('m4', { status: 'superseded' });
      insertMemory('m5', { status: 'archived' });
      for (const id of ['m1', 'm2', 'm3', 'm4', 'm5']) {
        repo.linkMemory(id, 'global', null, [{ kind: 'path', value: 'x.ts' }], new Date());
      }

      expect(repo.scopeActiveMemoryCount({ scope: 'global', projectId: null })).toBe(2);
      expect(
        repo.entityLinkCount({ scope: 'global', projectId: null, kind: 'path', value: 'x.ts' }),
      ).toBe(2);
    });

    it('blocks what the non-archived population admitted: 2/4 active is over 0.15, 2/20 non-archived is under', () => {
      for (const id of ['a1', 'a2', 'a3', 'a4']) insertMemory(id);
      for (let i = 0; i < 16; i++) insertMemory(`s${i}`, { status: 'superseded' });
      repo.linkMemory('a1', 'global', null, [{ kind: 'path', value: 'x.ts' }], new Date());
      repo.linkMemory('a2', 'global', null, [{ kind: 'path', value: 'x.ts' }], new Date());

      const scopeTotal = repo.scopeActiveMemoryCount({ scope: 'global', projectId: null });
      const links = repo.entityLinkCount({
        scope: 'global',
        projectId: null,
        kind: 'path',
        value: 'x.ts',
      });
      expect(scopeTotal).toBe(4);
      expect(links).toBe(2);
    });

    it('excludeMemoryId excludes a given memory from both counts', () => {
      insertMemory('m1');
      insertMemory('m2');
      repo.linkMemory('m1', 'global', null, [{ kind: 'path', value: 'x.ts' }], new Date());
      repo.linkMemory('m2', 'global', null, [{ kind: 'path', value: 'x.ts' }], new Date());

      expect(
        repo.scopeActiveMemoryCount({ scope: 'global', projectId: null, excludeMemoryId: 'm1' }),
      ).toBe(1);
      expect(
        repo.entityLinkCount({
          scope: 'global',
          projectId: null,
          kind: 'path',
          value: 'x.ts',
          excludeMemoryId: 'm1',
        }),
      ).toBe(1);
    });
  });

  describe('findOtherMemoriesForEntity', () => {
    it('excludes the just-saved memory and explicit excludeIds', () => {
      insertMemory('m1');
      insertMemory('m2');
      insertMemory('m3');
      for (const id of ['m1', 'm2', 'm3']) {
        repo.linkMemory(id, 'global', null, [{ kind: 'path', value: 'x.ts' }], new Date());
      }
      const found = repo.findOtherMemoriesForEntity({
        scope: 'global',
        projectId: null,
        kind: 'path',
        value: 'x.ts',
        excludeMemoryId: 'm1',
        excludeIds: ['m2'],
        limit: 10,
      });
      expect(found.map((m) => m.id)).toEqual(['m3']);
    });

    // `created_at DESC` puts the superseded and archived rows ahead of the
    // active one, so a status predicate that admits them shows up at index 0
    // rather than being hidden by scan order.
    it('returns only active rows — a superseded row is not an entity-channel candidate', () => {
      insertMemory('m_active', { createdAt: new Date(1_000) });
      insertMemory('m_superseded', { status: 'superseded', createdAt: new Date(2_000) });
      insertMemory('m_archived', { status: 'archived', createdAt: new Date(3_000) });
      insertMemory('m_new', { createdAt: new Date(4_000) });
      for (const id of ['m_active', 'm_superseded', 'm_archived', 'm_new']) {
        repo.linkMemory(id, 'global', null, [{ kind: 'path', value: 'x.ts' }], new Date());
      }

      const found = repo.findOtherMemoriesForEntity({
        scope: 'global',
        projectId: null,
        kind: 'path',
        value: 'x.ts',
        excludeMemoryId: 'm_new',
        excludeIds: [],
        limit: 10,
      });
      expect(found.map((m) => m.id)).toEqual(['m_active']);
    });
  });

  describe('findMissingScans', () => {
    it('lists every never-scanned memory oldest first, archived included', () => {
      insertMemory('m2', { createdAt: new Date(2000) });
      insertMemory('m1', { createdAt: new Date(1000) });
      insertMemory('m3', { createdAt: new Date(3000), status: 'archived' });
      const pending = repo.findMissingScans(10);
      expect(pending.map((p) => p.id)).toEqual(['m1', 'm2', 'm3']);
    });

    it('excludes a memory once it has been scanned, even with zero entities found', () => {
      insertMemory('m1');
      repo.linkMemory('m1', 'global', null, [], new Date());
      expect(repo.findMissingScans(10)).toEqual([]);
    });
  });

  describe('adminBacklogCount', () => {
    it('counts every unscanned memory, and agrees with findMissingScans on archived rows', () => {
      insertMemory('m1');
      insertMemory('m2');
      insertMemory('m3', { status: 'archived' });
      repo.linkMemory('m1', 'global', null, [], new Date());
      expect(repo.adminBacklogCount()).toBe(2);
      expect(repo.adminBacklogCount()).toBe(repo.findMissingScans(100).length);
    });
  });

  describe('countPendingScans', () => {
    it('is scoped, and no argument widens it', () => {
      t.handle.db
        .insert(projects)
        .values([{ id: 'p2', slug: 'project-two', createdAt: new Date(500) }])
        .run();
      insertMemory('g1');
      insertMemory('m-p1', { scope: 'project', projectId: 'p1' });
      insertMemory('m-p2', { scope: 'project', projectId: 'p2' });

      expect(repo.countPendingScans({ scope: 'global', projectId: null })).toBe(1);
      expect(repo.countPendingScans({ scope: 'project', projectId: 'p1' })).toBe(1);
      expect(repo.countPendingScans({ scope: 'project', projectId: 'p2' })).toBe(1);
    });

    it('reaches zero once the scope is drained', () => {
      insertMemory('g1');
      expect(repo.countPendingScans({ scope: 'global', projectId: null })).toBe(1);
      repo.linkMemory('g1', 'global', null, [], new Date());
      expect(repo.countPendingScans({ scope: 'global', projectId: null })).toBe(0);
    });
  });

  describe('adminCountsByKind', () => {
    it('aggregates by kind', () => {
      insertMemory('m1');
      insertMemory('m2');
      repo.linkMemory(
        'm1',
        'global',
        null,
        [
          { kind: 'path', value: 'a.ts' },
          { kind: 'path', value: 'b.ts' },
        ],
        new Date(),
      );
      repo.linkMemory('m2', 'global', null, [{ kind: 'path', value: 'a.ts' }], new Date());

      const byKind = repo.adminCountsByKind();
      expect(byKind).toEqual([{ kind: 'path', count: 2 }]);
    });
  });

  describe('truncateAll', () => {
    it('wipes all derived rows and leaves memory untouched', () => {
      insertMemory('m1');
      repo.linkMemory('m1', 'global', null, [{ kind: 'path', value: 'a.ts' }], new Date());
      repo.truncateAll();
      expect(repo.findEntitiesForMemory('m1')).toEqual([]);
      expect(repo.adminBacklogCount()).toBe(1);
      const stillThere = t.handle.db.select().from(memory).all();
      expect(stillThere).toHaveLength(1);
    });

    it('clears the scan bookkeeping before the links', () => {
      const order: string[] = [];
      // A `Db` stub is the only way to observe statement ORDER, and order is
      // the guarantee: scan-first means an interrupted wipe leaves links the
      // drain re-writes idempotently, where links-first leaves scan rows that
      // read as a drained backlog over a permanently empty index.
      const recording = {
        delete: (table: SQLiteTable) => {
          order.push(getTableConfig(table).name);
          return { run: () => undefined };
        },
      } as unknown as ConstructorParameters<typeof EntitiesRepository>[0];

      new EntitiesRepository(recording).truncateAll();

      expect(order).toEqual(['memory_entity_scan', 'memory_entity_links', 'memory_entities']);
    });
  });

  describe('findMemoriesByEntity ordering', () => {
    it('breaks a same-millisecond tie deterministically so paging cannot repeat a row', () => {
      // A batch capture writes several memories inside one millisecond, which
      // makes `created_at DESC` a partial order. Without a tiebreaker SQLite may
      // return tied rows in any order, and the caller pages by slicing the
      // result — so page 2 can repeat or skip what page 1 showed.
      const tied = new Date(5_000);
      for (const id of ['m-a', 'm-b', 'm-c', 'm-d']) {
        insertMemory(id, { createdAt: tied, content: 'apps/tied.ts' });
        repo.linkMemory(id, 'global', null, [{ kind: 'path', value: 'apps/tied.ts' }], tied);
      }

      const base = { scope: 'global' as const, projectId: null, value: 'apps/tied.ts' };
      const all = repo.findMemoriesByEntity({ ...base, limit: 10 }).map((m) => m.id);
      expect(all).toEqual(['m-d', 'm-c', 'm-b', 'm-a']);

      // Two pages of two must partition the set, not overlap it.
      const page1 = repo
        .findMemoriesByEntity({ ...base, limit: 2 })
        .map((m) => m.id)
        .slice(0, 2);
      const page2 = repo
        .findMemoriesByEntity({ ...base, limit: 4 })
        .map((m) => m.id)
        .slice(2, 4);
      expect(new Set([...page1, ...page2]).size).toBe(4);
    });
  });
});
