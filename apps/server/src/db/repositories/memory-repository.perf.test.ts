import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../../test/db.js';
import { confirmations } from '../schema/confirmations.js';
import { consolidationOps, consolidationRuns } from '../schema/consolidation.js';
import { memoryRelations } from '../schema/memory-relations.js';
import { memory, type NewMemory } from '../schema/memory.js';

import { MemoryRepository } from './memory-repository.js';

function mem(overrides: Partial<NewMemory> & { id: string }): NewMemory {
  return {
    title: 't',
    content: 'c',
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

// The pre-rewrite correlated form, kept verbatim here as the equivalence oracle.
const LEGACY_NOT_EXISTS = `m.status = 'archived'
         AND NOT EXISTS (
             SELECT 1 FROM memory m2, json_each(m2.replaces) je
              WHERE je.value = m.id)
         AND NOT EXISTS (
             SELECT 1 FROM consolidation_ops co
              WHERE co.created_id = m.id
                 OR EXISTS (
                     SELECT 1 FROM json_each(co.affected_ids) je2
                      WHERE je2.value = m.id))
         AND NOT EXISTS (
             SELECT 1 FROM memory_relations r
              WHERE r.source_id = m.id OR r.target_id = m.id)
         AND NOT EXISTS (
             SELECT 1 FROM confirmations c WHERE c.memory_id = m.id)`;

describe('MemoryRepository — read-path performance (optimize-db-read-path)', () => {
  let t: TestDb;
  let repo: MemoryRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new MemoryRepository(t.handle.db);
  });

  afterEach(() => {
    t.cleanup();
  });

  describe('PURGE_PREDICATE NOT IN rewrite', () => {
    it('selects the identical id set as the legacy correlated-NOT EXISTS form', () => {
      // Archived rows: one purgeable, plus one held back by each reference kind.
      t.handle.db
        .insert(memory)
        .values([
          mem({ id: 'PURGE', status: 'archived' }),
          mem({ id: 'REF_REPLACES', status: 'archived' }),
          mem({ id: 'REF_CREATED', status: 'archived' }),
          mem({ id: 'REF_AFFECTED', status: 'archived' }),
          mem({ id: 'REF_REL_SRC', status: 'archived' }),
          mem({ id: 'REF_REL_TGT', status: 'archived' }),
          mem({ id: 'REF_CONFIRM', status: 'archived' }),
          mem({ id: 'ACTIVE', status: 'active' }),
          // A live row whose replaces references REF_REPLACES.
          mem({ id: 'SUCCESSOR', status: 'active', replaces: ['REF_REPLACES'] }),
        ])
        .run();

      t.handle.db
        .insert(consolidationRuns)
        .values([{ id: 'run1', startedAt: new Date(1_000), scope: 'global' }])
        .run();
      t.handle.db
        .insert(consolidationOps)
        .values([
          {
            id: 'op-created',
            runId: 'run1',
            opType: 'merge',
            affectedIds: [],
            createdId: 'REF_CREATED',
            appliedAt: new Date(1_000),
          },
          {
            id: 'op-affected',
            runId: 'run1',
            opType: 'merge',
            affectedIds: ['REF_AFFECTED'],
            createdId: null,
            appliedAt: new Date(1_000),
          },
          // The load-bearing case: a NULL created_id must NOT poison NOT IN.
          {
            id: 'op-null-created',
            runId: 'run1',
            opType: 'decay',
            affectedIds: [],
            createdId: null,
            appliedAt: new Date(1_000),
          },
        ])
        .run();

      t.handle.db
        .insert(memoryRelations)
        .values([
          {
            id: 'rel-src',
            judgmentId: 'j1',
            sourceId: 'REF_REL_SRC',
            targetId: 'ACTIVE',
            status: 'judged',
            createdAt: new Date(1_000),
          },
          {
            id: 'rel-tgt',
            judgmentId: 'j2',
            sourceId: 'ACTIVE',
            targetId: 'REF_REL_TGT',
            status: 'judged',
            createdAt: new Date(1_000),
          },
        ])
        .run();

      t.handle.db
        .insert(confirmations)
        .values([{ id: 'cf1', memoryId: 'REF_CONFIRM', eventTs: new Date(1_000) }])
        .run();

      const legacyIds = t.handle.raw
        .prepare<[], { id: string }>(`SELECT m.id FROM memory m WHERE ${LEGACY_NOT_EXISTS}`)
        .all()
        .map((r) => r.id)
        .sort();

      const newIds = repo.findPurgeableDisconnectedArchivedIds().sort();

      expect(newIds).toEqual(legacyIds);
      // Sanity: exactly the one unreferenced archived row is purgeable.
      expect(newIds).toEqual(['PURGE']);
      expect(repo.countPurgeableDisconnectedArchived()).toBe(1);
    });

    it('does not stop purging when a consolidation_ops row has a NULL created_id', () => {
      // A single archived, unreferenced row plus a NULL-created_id op row.
      t.handle.db
        .insert(memory)
        .values([mem({ id: 'LONE', status: 'archived' })])
        .run();
      t.handle.db
        .insert(consolidationRuns)
        .values([{ id: 'r', startedAt: new Date(1_000), scope: 'global' }])
        .run();
      t.handle.db
        .insert(consolidationOps)
        .values([
          {
            id: 'op-null',
            runId: 'r',
            opType: 'decay',
            affectedIds: [],
            createdId: null,
            appliedAt: new Date(1_000),
          },
        ])
        .run();

      expect(repo.findPurgeableDisconnectedArchivedIds()).toEqual(['LONE']);
    });
  });

  describe('recentForContext expression index', () => {
    function planFor(scope: 'global' | 'project', projectId: string | null): string {
      const conds = [
        scope === 'project'
          ? and(eq(memory.scope, 'project'), eq(memory.projectId, projectId ?? ''))
          : and(eq(memory.scope, 'global'), isNull(memory.projectId)),
        sql`${memory.status} != 'archived'`,
      ];
      const { sql: text, params } = t.handle.db
        .select()
        .from(memory)
        .where(and(...conds))
        .orderBy(sql`COALESCE(${memory.lastSeenAt}, ${memory.createdAt}) DESC`)
        .limit(20)
        .toSQL();
      return t.handle.raw
        .prepare<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${text}`)
        .all(...params)
        .map((r) => r.detail)
        .join(' | ');
    }

    it('uses memory_scope_seen_idx and avoids a temp-b-tree sort (global scope)', () => {
      const detail = planFor('global', null);
      expect(detail).toContain('USING INDEX memory_scope_seen_idx');
      expect(detail).not.toContain('TEMP B-TREE');
    });

    it('returns rows ordered by COALESCE(last_seen_at, created_at) DESC', () => {
      t.handle.db
        .insert(memory)
        .values([
          mem({ id: 'A', createdAt: new Date(1_000), lastSeenAt: new Date(5_000) }),
          mem({ id: 'B', createdAt: new Date(9_000), lastSeenAt: null }),
          mem({ id: 'C', createdAt: new Date(1_000), lastSeenAt: new Date(3_000) }),
          mem({ id: 'D', status: 'archived', createdAt: new Date(9_999), lastSeenAt: null }),
        ])
        .run();

      const ids = repo
        .recentForContext({ scope: 'global', projectId: null, includeArchived: false, limit: 20 })
        .map((m) => m.id);

      // Effective recency: B=9000, A=5000, C=3000; D excluded (archived).
      expect(ids).toEqual(['B', 'A', 'C']);
    });
  });
});
