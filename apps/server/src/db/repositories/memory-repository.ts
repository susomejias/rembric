import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Db } from '../client.js';
import { confirmations, type NewConfirmation } from '../schema/confirmations.js';
import {
  memory,
  type Memory,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
  type NewMemory,
} from '../schema/memory.js';

export interface FindActiveByScopeOpts {
  scope: MemoryScope;
  projectId?: string | null;
  includeGlobal?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchMemoryIdsOpts {
  query?: string;
  scope: MemoryScope;
  projectId: string | null;
  status: MemoryStatus;
  type?: MemoryType;
  tag?: string;
  limit: number;
  offset: number;
}

export interface AdminListMemoriesOpts {
  status: MemoryStatus;
  type?: MemoryType;
  project?: { kind: 'global' } | { kind: 'project'; projectId: string };
  limit: number;
  offset: number;
}

export class MemoryRepository {
  constructor(private readonly db: Db) {}

  findActiveByScope(opts: FindActiveByScopeOpts): Memory[] {
    const projectFilter =
      opts.scope === 'project' && opts.projectId
        ? eq(memory.projectId, opts.projectId)
        : isNull(memory.projectId);

    const scopeFilter =
      opts.scope === 'project' && opts.includeGlobal
        ? or(
            and(eq(memory.scope, 'project'), projectFilter),
            and(eq(memory.scope, 'global'), isNull(memory.projectId)),
          )
        : and(eq(memory.scope, opts.scope), projectFilter);

    let query = this.db
      .select()
      .from(memory)
      .where(and(scopeFilter, eq(memory.status, 'active')))
      .orderBy(desc(memory.createdAt))
      .$dynamic();

    if (opts.limit !== undefined) query = query.limit(opts.limit);
    if (opts.offset !== undefined) query = query.offset(opts.offset);

    return query.all();
  }

  findActiveByTopicKey(opts: {
    scope: MemoryScope;
    projectId: string | null;
    topicKey: string;
  }): Memory | undefined {
    const scopeClause =
      opts.scope === 'project'
        ? sql`scope = 'project' AND project_id = ${opts.projectId}`
        : sql`scope = 'global' AND project_id IS NULL`;
    return this.db
      .select()
      .from(memory)
      .where(sql`${scopeClause} AND topic_key = ${opts.topicKey} AND status = 'active'`)
      .limit(1)
      .get();
  }

  /**
   * BM25 FTS5 candidate search for save-time detection: active in-scope
   * rows matching `matchExpr`, excluding the saved row and its links.
   */
  searchBm25Candidates(opts: {
    matchExpr: string;
    excludeId: string;
    scope: MemoryScope;
    projectId: string | null;
    excludeIds: string[];
    limit: number;
  }): { id: string; rank: number; content: string }[] {
    const scopeWhere =
      opts.scope === 'project'
        ? sql`scope = 'project' AND project_id = ${opts.projectId}`
        : sql`scope = 'global' AND project_id IS NULL`;
    return this.db.all<{ id: string; rank: number; content: string }>(
      sql`
        SELECT m.id AS id, memory_fts.rank AS rank, m.content AS content
        FROM memory_fts
          JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ${opts.matchExpr}
          AND m.id != ${opts.excludeId}
          AND ${scopeWhere}
          AND m.status = 'active'
          AND m.id NOT IN (SELECT value FROM json_each(${JSON.stringify(opts.excludeIds)}))
        ORDER BY rank
        LIMIT ${opts.limit}
      `,
    );
  }

  searchMemoryIds(opts: SearchMemoryIdsOpts): string[] {
    const scopeClause =
      opts.scope === 'global'
        ? sql`(m.scope = 'global' AND m.project_id IS NULL)`
        : sql`(m.scope = 'project' AND m.project_id = ${opts.projectId})`;
    const typeClause = opts.type ? sql`AND m.type = ${opts.type}` : sql``;
    const tagClause = opts.tag
      ? sql`AND EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value = ${opts.tag})`
      : sql``;
    const statusClause = sql`AND m.status = ${opts.status}`;

    const rows = opts.query
      ? this.db.all<{ id: string }>(
          sql`
            SELECT m.id
            FROM memory m
            JOIN memory_fts f ON f.rowid = m.rowid
            WHERE memory_fts MATCH ${opts.query}
              AND ${scopeClause}
              ${statusClause}
              ${typeClause}
              ${tagClause}
            ORDER BY rank, m.created_at DESC
            LIMIT ${opts.limit} OFFSET ${opts.offset}
          `,
        )
      : this.db.all<{ id: string }>(
          sql`
            SELECT m.id
            FROM memory m
            WHERE ${scopeClause}
              ${statusClause}
              ${typeClause}
              ${tagClause}
            ORDER BY m.created_at DESC
            LIMIT ${opts.limit} OFFSET ${opts.offset}
          `,
        );
    return rows.map((r) => r.id);
  }

  /** @internal */
  unsafeGetById(id: string): Memory | undefined {
    return this.db.select().from(memory).where(eq(memory.id, id)).get();
  }

  /** @internal */
  unsafeGetByIds(ids: readonly string[]): Memory[] {
    if (ids.length === 0) return [];
    return this.db
      .select()
      .from(memory)
      .where(inArray(memory.id, [...ids]))
      .all();
  }

  /** Minimal scope tuple for same-scope assertions; no content leaks. */
  findScopeTupleById(
    id: string,
  ): { scope: MemoryScope; projectId: string | null; replaces: string[] } | undefined {
    return this.db
      .select({ scope: memory.scope, projectId: memory.projectId, replaces: memory.replaces })
      .from(memory)
      .where(eq(memory.id, id))
      .get();
  }

  setReplaces(id: string, replaces: string[]): void {
    this.db.update(memory).set({ replaces }).where(eq(memory.id, id)).run();
  }

  /** Newest memory whose `replaces[]` contains `id` (one supersede hop). */
  findSuccessorId(id: string): string | undefined {
    return this.db
      .all<{ id: string }>(
        sql`
          SELECT m.id
          FROM memory m, json_each(m.replaces) je
          WHERE je.value = ${id}
          ORDER BY m.created_at DESC
          LIMIT 1
        `,
      )
      .at(0)?.id;
  }

  countByStatus(status: MemoryStatus): number {
    const row = this.db
      .select({ value: count() })
      .from(memory)
      .where(eq(memory.status, status))
      .get();
    return row?.value ?? 0;
  }

  countConfirmations(memoryId: string): number {
    const row = this.db
      .select({ value: count() })
      .from(confirmations)
      .where(eq(confirmations.memoryId, memoryId))
      .get();
    return row?.value ?? 0;
  }

  insert(values: NewMemory): Memory | undefined {
    return this.db.insert(memory).values(values).returning().get();
  }

  markSuperseded(id: string): void {
    this.db
      .update(memory)
      .set({ status: 'superseded' as const })
      .where(and(eq(memory.id, id), eq(memory.status, 'active')))
      .run();
  }

  markArchived(id: string, lastSeenAt: Date): void {
    this.db
      .update(memory)
      .set({ status: 'archived', lastSeenAt })
      .where(and(eq(memory.id, id), eq(memory.status, 'active')))
      .run();
  }

  touchLastSeen(id: string, lastSeenAt: Date): void {
    this.db.update(memory).set({ lastSeenAt }).where(eq(memory.id, id)).run();
  }

  touchLastSeenBatch(ids: readonly string[], lastSeenAt: Date): void {
    if (ids.length === 0) return;
    this.db
      .update(memory)
      .set({ lastSeenAt })
      .where(inArray(memory.id, [...ids]))
      .run();
  }

  insertConfirmation(values: NewConfirmation): void {
    this.db.insert(confirmations).values(values).run();
  }

  //  The ONE escape hatch in the otherwise append-only contract for the
  //  `memory` table. The invariant test white-lists ONLY this file for
  //  `DELETE FROM memory`. Predicate MUST stay in lock-step between the
  //  count and the id selection, and with the spec at
  //  `openspec/specs/memory/spec.md::"Memories MAY be physically purged
  //  when archived and disconnected"`.

  countPurgeableDisconnectedArchived(): number {
    const row = this.db.get<{ v: number }>(sql`
      SELECT COUNT(*) AS v FROM memory m
       WHERE ${PURGE_PREDICATE}
    `) as { v: number } | undefined;
    return row?.v ?? 0;
  }

  findPurgeableDisconnectedArchivedIds(): string[] {
    return this.db
      .all<{ id: string }>(
        sql`
        SELECT m.id FROM memory m
         WHERE ${PURGE_PREDICATE}
      `,
      )
      .map((r) => r.id);
  }

  /**
   * Physically delete the given memory rows plus their `memory_vec`
   * shadow rows. Derived data is dropped first so the FTS/vec triggers
   * never observe a half-deleted state. Callers run this inside a
   * transaction together with the journaling inserts.
   */
  purgeByIds(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const placeholders = sql.join(
      ids.map((id) => sql`${id}`),
      sql.raw(', '),
    );
    this.db.run(sql`DELETE FROM memory_vec WHERE memory_id IN (${placeholders})`);
    this.db.run(sql`DELETE FROM memory WHERE id IN (${placeholders})`);
  }

  /**
   * FTS5 keyword search across ALL scopes, hydrated rows. Rank-ordered id
   * selection; hydration order follows the IN-list scan, matching the
   * previous inline dashboard query.
   */
  adminSearchFts(query: string, limit: number, offset: number): Memory[] {
    const ids = this.db
      .all<{ id: string }>(
        sql`
          SELECT m.id
          FROM memory m
          JOIN memory_fts f ON f.rowid = m.rowid
          WHERE memory_fts MATCH ${query}
          ORDER BY rank, m.created_at DESC
          LIMIT ${limit} OFFSET ${offset}
        `,
      )
      .map((r) => r.id);
    return this.unsafeGetByIds(ids);
  }

  adminList(opts: AdminListMemoriesOpts): Memory[] {
    const conditions: SQL[] = [eq(memory.status, opts.status)];
    if (opts.type) conditions.push(eq(memory.type, opts.type));
    if (opts.project?.kind === 'global') {
      conditions.push(eq(memory.scope, 'global'), isNull(memory.projectId));
    } else if (opts.project?.kind === 'project') {
      conditions.push(eq(memory.scope, 'project'), eq(memory.projectId, opts.project.projectId));
    }
    return this.db
      .select()
      .from(memory)
      .where(and(...conditions))
      .orderBy(desc(memory.createdAt))
      .limit(opts.limit)
      .offset(opts.offset)
      .all();
  }

  adminGetByIds(ids: readonly string[]): Memory[] {
    return this.unsafeGetByIds(ids);
  }

  adminCountConfirmations(memoryId: string): number {
    return this.countConfirmations(memoryId);
  }

  /** Memory count per agent session, keyed by session id. */
  adminCountBySession(): Record<string, number> {
    const rows = this.db
      .select({ sessionId: memory.sessionId, n: count() })
      .from(memory)
      .where(isNotNull(memory.sessionId))
      .groupBy(memory.sessionId)
      .all();
    const out: Record<string, number> = {};
    for (const r of rows) {
      if (r.sessionId) out[r.sessionId] = r.n;
    }
    return out;
  }

  adminListBySession(sessionId: string): Memory[] {
    return this.db
      .select()
      .from(memory)
      .where(eq(memory.sessionId, sessionId))
      .orderBy(memory.createdAt)
      .all();
  }

  /** Memories created per UTC day bucket (epoch-ms / 86400000) since `since`. */
  adminCountCreatedByDay(since: Date): { day: number; n: number }[] {
    const day = sql<number>`(created_at / 86400000)`;
    return this.db
      .select({ day, n: count() })
      .from(memory)
      .where(gte(memory.createdAt, since))
      .groupBy(day)
      .orderBy(day)
      .all();
  }
}

/**
 * Disconnected-archived purge predicate, shared verbatim by the count
 * and the id selection:
 *   - status = 'archived'
 *   - no other memory row references this id in its `replaces` JSON
 *   - no consolidation_ops row references this id via `affected_ids`
 *     or `created_id`
 *   - no memory_relations row references this id as source or target
 *   - no confirmations row references this id as `memory_id`
 */
const PURGE_PREDICATE = sql`m.status = 'archived'
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
