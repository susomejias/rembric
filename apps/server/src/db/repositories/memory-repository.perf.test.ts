import { and, eq, isNull, sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_DECAY } from '../../consolidation/decay.js';
import { REFUTED_PRIORITY_MS, reviewTtlEntries } from '../../services/review.js';
import { createTestDb, type TestDb } from '../../test/db.js';
import { seedProject } from '../../test/default-project.js';
import { confirmations } from '../schema/confirmations.js';
import { consolidationOps, consolidationRuns } from '../schema/consolidation.js';
import { memoryRelations } from '../schema/memory-relations.js';
import { memory, type MemoryType, type NewMemory } from '../schema/memory.js';

import { MemoryRepository } from './memory-repository.js';

function mem(overrides: Partial<NewMemory> & { id: string }): NewMemory {
  return {
    title: 't',
    content: 'c',
    scope: 'project',
    projectId: 'p0',
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

/**
 * Explains the SQL a repository call actually executes. Reconstructing the
 * query in the test instead would let an assertion pass against a query the
 * production path no longer runs.
 */
function explainWhileRunning(t: TestDb, run: () => void): string[] {
  const raw = t.handle.raw;
  const bound = raw.prepare.bind(raw);
  const seen: string[] = [];
  const wrap = (stmt: object, text: string): object =>
    new Proxy(stmt, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop);
        if (typeof value !== 'function') return value;
        const method = value as (...a: unknown[]) => unknown;
        if (prop === 'all' || prop === 'get' || prop === 'run') {
          return (...params: unknown[]) => {
            seen.push(
              ...bound<unknown[], { detail: string }>(`EXPLAIN QUERY PLAN ${text}`)
                .all(...params)
                .map((r) => r.detail),
            );
            return method.apply(target, params);
          };
        }
        return (...args: unknown[]) => {
          const result = method.apply(target, args);
          // `raw()` / `pluck()` return the statement itself, and drizzle
          // reaches the terminal all/get/run through them.
          return result === target ? wrap(target, text) : result;
        };
      },
    });
  // better-sqlite3 types `prepare` as generic over its row and parameter
  // tuples; the interceptor observes only SQL text and bound values, so the
  // generics are erased across this assignment.
  raw.prepare = ((text: string) => wrap(bound(text), text)) as typeof raw.prepare;
  try {
    run();
  } finally {
    Reflect.deleteProperty(raw, 'prepare');
  }
  return seen;
}

describe('MemoryRepository — read-path performance (optimize-db-read-path)', () => {
  let t: TestDb;
  let repo: MemoryRepository;

  beforeEach(() => {
    t = createTestDb();
    seedProject(t.handle, 'p0', 'project-zero');
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

  describe('purgeByIds — SQLite bind-variable ceiling', () => {
    // Above SQLITE_MAX_VARIABLE_NUMBER (32 766).
    const OVER_BIND_CEILING = 40_000;

    it('purges an id list larger than the 32 766 bind-variable ceiling', () => {
      const insert = t.handle.raw.prepare(
        `INSERT INTO memory (id, scope, project_id, type, title, content, tags, status, replaces, created_at, last_seen_at)
         VALUES (?, 'global', NULL, 'project', 't', 'c', '[]', 'archived', '[]', 1000, 1000)`,
      );
      t.handle.raw.transaction(() => {
        for (let i = 0; i < OVER_BIND_CEILING; i++) insert.run(`m-${i}`);
      })();

      // Derived rows on a subset, so the entity DELETEs (which must precede the
      // memory DELETE — no ON DELETE CASCADE) are actually exercised.
      t.handle.raw
        .prepare(
          `INSERT INTO memory_entities (id, scope, project_id, kind, value, created_at) VALUES ('e1','global',NULL,'path','/tmp/x',1000)`,
        )
        .run();
      const link = t.handle.raw.prepare(
        `INSERT INTO memory_entity_links (entity_id, memory_id) VALUES ('e1', ?)`,
      );
      const scan = t.handle.raw.prepare(
        `INSERT INTO memory_entity_scan (memory_id, scanned_at) VALUES (?, 1000)`,
      );
      const vec = t.handle.raw.prepare(
        `INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding) VALUES (?, '__global__', 'archived', 'project', ?)`,
      );
      const embedding = Buffer.from(new Float32Array(768).buffer);
      t.handle.raw.transaction(() => {
        for (let i = 0; i < 10; i++) {
          link.run(`m-${i}`);
          scan.run(`m-${i}`);
          vec.run(`m-${i}`, embedding);
        }
      })();

      const ids = repo.findPurgeableDisconnectedArchivedIds();
      expect(ids).toHaveLength(OVER_BIND_CEILING);

      repo.purgeByIds(ids);

      const countOf = (table: string) =>
        (t.handle.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
      expect(countOf('memory')).toBe(0);
      expect(countOf('memory_entity_links')).toBe(0);
      expect(countOf('memory_entity_scan')).toBe(0);
      expect(countOf('memory_vec')).toBe(0);
      expect(countOf('memory_fts'), 'memory_ad must keep the FTS mirror in step').toBe(0);
    });
  });

  describe('findSuccessorId — memory_replaces join', () => {
    // The pre-rewrite json_each scan, kept verbatim as the equivalence oracle.
    function legacyFindSuccessorId(id: string): string | undefined {
      return t.handle.raw
        .prepare<
          [string],
          { id: string }
        >(`SELECT m.id FROM memory m, json_each(m.replaces) je WHERE je.value = ? ORDER BY m.created_at DESC LIMIT 1`)
        .get(id)?.id;
    }

    it('matches the legacy json_each scan for a simple chain', () => {
      t.handle.db
        .insert(memory)
        .values([
          mem({ id: 'M1', status: 'superseded' }),
          mem({ id: 'M2', status: 'active', replaces: ['M1'] }),
        ])
        .run();

      expect(repo.findSuccessorId('M1')).toBe(legacyFindSuccessorId('M1'));
      expect(repo.findSuccessorId('M1')).toBe('M2');
    });

    it('matches the legacy scan when a predecessor has no successor', () => {
      t.handle.db
        .insert(memory)
        .values([mem({ id: 'LONE', status: 'active' })])
        .run();
      expect(repo.findSuccessorId('LONE')).toBe(legacyFindSuccessorId('LONE'));
      expect(repo.findSuccessorId('LONE')).toBeUndefined();
    });

    it('picks the newest successor when more than one row claims the same predecessor', () => {
      t.handle.db
        .insert(memory)
        .values([
          mem({ id: 'M1', status: 'superseded' }),
          mem({ id: 'OLDER', status: 'superseded', replaces: ['M1'], createdAt: new Date(1_000) }),
          mem({ id: 'NEWER', status: 'active', replaces: ['M1'], createdAt: new Date(2_000) }),
        ])
        .run();

      expect(repo.findSuccessorId('M1')).toBe(legacyFindSuccessorId('M1'));
      expect(repo.findSuccessorId('M1')).toBe('NEWER');
    });

    it('a 500-row table does not make findSuccessorId scale with table size', () => {
      const rows: NewMemory[] = [mem({ id: 'HEAD', status: 'superseded' })];
      for (let i = 0; i < 499; i++) {
        rows.push(mem({ id: `filler-${i}`, status: 'archived' }));
      }
      t.handle.db.insert(memory).values(rows).run();
      t.handle.db
        .insert(memory)
        .values([mem({ id: 'TAIL', status: 'active', replaces: ['HEAD'] })])
        .run();

      const started = performance.now();
      for (let i = 0; i < 100; i++) repo.findSuccessorId('HEAD');
      const elapsedMs = performance.now() - started;

      expect(repo.findSuccessorId('HEAD')).toBe('TAIL');
      // A PK-indexed join stays sub-millisecond per call even repeated 100x;
      // the pre-rewrite json_each scan measured ~11ms per call on its own.
      expect(elapsedMs).toBeLessThan(200);
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
        .recentForContext({ projectId: 'p0', includeArchived: false, limit: 20 })
        .map((m) => m.id);

      // Effective recency: B=9000, A=5000, C=3000; D excluded (archived).
      expect(ids).toEqual(['B', 'A', 'C']);
    });
  });

  describe('textByIds — the search gate window text read', () => {
    it('resolves each id by primary key, and never drives from a scope index', () => {
      const detail = explainWhileRunning(t, () =>
        repo.textByIds({ ids: ['a', 'b', 'c'], projectId: 'p0' }),
      ).join(' | ');
      // One seek per id against `memory`'s TEXT primary-key autoindex. The
      // rejected plan drove from memory_scope_seen_idx and bloom-filtered the
      // whole scope, whose cost grows with the corpus rather than the id list.
      expect(detail).toContain('SEARCH m USING INDEX sqlite_autoindex_memory_1 (id=?)');
      expect(detail).not.toContain('memory_scope_seen_idx');
      expect(detail).not.toContain('SCAN m ');
      expect(detail).not.toContain('BLOOM FILTER');
    });

    it('keeps that plan for a project scope', () => {
      for (const opts of [{ ids: ['a'], scope: 'project' as const, projectId: 'p' }]) {
        const detail = explainWhileRunning(t, () => repo.textByIds(opts)).join(' | ');
        expect(detail).toContain('SEARCH m USING INDEX sqlite_autoindex_memory_1 (id=?)');
        expect(detail).not.toContain('memory_scope_seen_idx');
      }
    });

    // Asserted as a GROWTH RATIO, not an absolute budget. An absolute budget does
    // not discriminate here: the rejected corpus-proportional plan still runs in
    // ~0.16 ms at this scale, so any budget loose enough not to be flaky also
    // passes the plan this test exists to reject. Cost tracking the id list
    // rather than the corpus is the actual property, and quadrupling the table
    // is what measures it.
    it('does not get more expensive as the table grows', () => {
      const insertRange = (from: number, to: number) => {
        const rows = Array.from({ length: to - from }, (_, i) =>
          mem({ id: `bulk-${from + i}`, title: `Title ${from + i}`, content: `body ${from + i}` }),
        );
        for (let i = 0; i < rows.length; i += 500) {
          t.handle.db
            .insert(memory)
            .values(rows.slice(i, i + 500))
            .run();
        }
      };
      const ids = Array.from({ length: 16 }, (_, i) => `bulk-${i * 100}`);
      const perCallMs = () => {
        for (let i = 0; i < 50; i++) repo.textByIds({ ids, projectId: 'p0' });
        const start = performance.now();
        for (let i = 0; i < 200; i++) repo.textByIds({ ids, projectId: 'p0' });
        return (performance.now() - start) / 200;
      };

      insertRange(0, 2_000);
      expect(repo.textByIds({ ids, projectId: 'p0' })).toHaveLength(16);
      const small = perCallMs();

      insertRange(2_000, 8_000);
      const large = perCallMs();

      expect(large / small).toBeLessThan(2.5);
    });
  });

  describe('confirmations composite index on the review axis', () => {
    const planLines = (run: () => void) => explainWhileRunning(t, run);

    const ttlByType = reviewTtlEntries();
    const decayThresholds = Object.entries(DEFAULT_DECAY.thresholdByType).filter(
      (e): e is [MemoryType, number] => typeof e[1] === 'number',
    );
    const nowMs = 10_000_000_000;

    const reviewReads: Record<string, (repo: MemoryRepository) => void> = {
      findNeedsReview: (repo) => {
        repo.findNeedsReview({
          projectId: 'p0',
          nowMs,
          limit: 3,
          ttlByType,
          refutedPriorityMs: REFUTED_PRIORITY_MS,
        });
      },
      countNeedsReview: (repo) => {
        repo.countNeedsReview({ projectId: 'p0', nowMs, ttlByType });
      },
      adminCountNeedsReview: (repo) => {
        repo.adminCountNeedsReview({ nowMs, ttlByType });
      },
      findDecayCandidateIds: (repo) => {
        repo.findDecayCandidateIds({
          projectId: 'p0',
          nowMs,
          thresholdByType: decayThresholds,
          defaultThresholdMs: DEFAULT_DECAY.defaultThresholdMs,
          confidenceFloor: DEFAULT_DECAY.confidenceFloor,
        });
      },
    };

    beforeEach(() => {
      t.handle.db
        .insert(memory)
        .values([mem({ id: 'M1' }), mem({ id: 'M2', type: 'procedural' })])
        .run();
      t.handle.db
        .insert(confirmations)
        .values([
          { id: 'k1', memoryId: 'M1', eventTs: new Date(2_000), verdict: 'affirm' },
          { id: 'k2', memoryId: 'M1', eventTs: new Date(3_000), verdict: 'refute' },
          { id: 'k3', memoryId: 'M2', eventTs: new Date(4_000), verdict: 'affirm' },
        ])
        .run();
    });

    for (const [name, run] of Object.entries(reviewReads)) {
      it(`${name} reads confirmations only through the covering composite index`, () => {
        const touchesConfirmations = planLines(() => run(repo)).filter((line) =>
          line.includes('confirmations'),
        );

        // A CREATE INDEX the planner ignores is pure write cost on an
        // append-only table, so the plan is the assertion. COVERING is the
        // second half: `event_ts` in the index means no table lookup at all.
        expect(touchesConfirmations.length).toBeGreaterThan(0);
        for (const line of touchesConfirmations) {
          expect(line).toContain('USING COVERING INDEX confirmations_memory_verdict_ts_idx');
        }
      });
    }

    it('falls back to a non-covering scan of confirmations without the composite index', () => {
      t.handle.raw.exec('DROP INDEX confirmations_memory_verdict_ts_idx');
      const lines = planLines(() => reviewReads['countNeedsReview']!(repo)).filter((line) =>
        line.includes('confirmations'),
      );
      expect(lines.length).toBeGreaterThan(0);
      expect(lines.every((l) => l.includes('COVERING'))).toBe(false);
    });
  });
});
