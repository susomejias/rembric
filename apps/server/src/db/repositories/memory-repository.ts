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

import { scopeWhere } from './scope-clause.js';

// BM25 column weights for the interactive search lexical branch, in
// `memory_fts` declaration order (content, tags, title). A title hit is a
// strong relevance signal, so title is weighted above content. Save-time
// candidate detection deliberately keeps default (unweighted) ranking so its
// calibrated FTS_THRESHOLD is undisturbed.
const FTS_WEIGHT_CONTENT = 1.0;
const FTS_WEIGHT_TAGS = 1.0;
const FTS_WEIGHT_TITLE = 2.0;

export interface FindActiveByScopeOpts {
  scope: MemoryScope;
  projectId?: string | null;
  includeGlobal?: boolean;
  limit?: number;
  offset?: number;
}

export interface SearchMemoryIdsOpts {
  scope: MemoryScope;
  projectId: string | null;
  status: MemoryStatus;
  type?: MemoryType;
  tag?: string;
  limit: number;
  offset: number;
}

export interface SearchBm25IdsOpts {
  /** Pre-sanitized FTS5 MATCH expression (see services/hybrid-search.ts). */
  matchExpr: string;
  scope: MemoryScope;
  projectId: string | null;
  status: MemoryStatus;
  type?: MemoryType;
  tag?: string;
  /** Bounded rank window depth (no OFFSET — fusion paginates in memory). */
  limit: number;
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
    return this.db
      .select()
      .from(memory)
      .where(
        sql`${scopeWhere(opts.scope, opts.projectId)} AND topic_key = ${opts.topicKey} AND status = 'active'`,
      )
      .limit(1)
      .get();
  }

  /**
   * BM25 FTS5 candidate search for save-time detection: active in-scope
   * rows matching `matchExpr`, excluding the saved row and its links.
   *
   * Deliberately ordered by the DEFAULT (unweighted) `rank`, unlike the
   * interactive `searchBm25Ids` (which applies the FTS_WEIGHT_* title boost):
   * the save-time `FTS_THRESHOLD` was calibrated on unweighted BM25, so
   * reweighting here would silently de-calibrate candidate surfacing. (The
   * MATCH does now span the `title` column too, so a saved row's content tokens
   * can match an existing row's title — a small, intentional recall widening;
   * the rank/threshold math is unchanged.)
   */
  searchBm25Candidates(opts: {
    matchExpr: string;
    excludeId: string;
    scope: MemoryScope;
    projectId: string | null;
    excludeIds: string[];
    limit: number;
  }): { id: string; rank: number; title: string; content: string }[] {
    return this.db.all<{ id: string; rank: number; title: string; content: string }>(
      sql`
        SELECT m.id AS id, memory_fts.rank AS rank, m.title AS title, m.content AS content
        FROM memory_fts
          JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ${opts.matchExpr}
          AND m.id != ${opts.excludeId}
          AND ${scopeWhere(opts.scope, opts.projectId, 'm')}
          AND m.status = 'active'
          AND m.id NOT IN (SELECT value FROM json_each(${JSON.stringify(opts.excludeIds)}))
        ORDER BY rank
        LIMIT ${opts.limit}
      `,
    );
  }

  /** Recent in-scope memories (memory.context), newest by last-seen/created. */
  recentForContext(opts: {
    scope: MemoryScope;
    projectId: string | null;
    includeArchived: boolean;
    limit: number;
  }): Memory[] {
    const conditions: SQL[] = [
      opts.scope === 'project'
        ? (and(eq(memory.scope, 'project'), eq(memory.projectId, opts.projectId ?? '')) as SQL)
        : (and(eq(memory.scope, 'global'), isNull(memory.projectId)) as SQL),
    ];
    if (!opts.includeArchived) conditions.push(sql`${memory.status} != 'archived'`);
    return this.db
      .select()
      .from(memory)
      .where(and(...conditions))
      .orderBy(sql`COALESCE(${memory.lastSeenAt}, ${memory.createdAt}) DESC`)
      .limit(opts.limit)
      .all();
  }

  /** Timeline neighbors within the same session, before/after a pivot. */
  sessionNeighbors(opts: {
    sessionId: string;
    pivotCreatedAt: Date;
    pivotId: string;
    direction: 'before' | 'after';
    limit: number;
  }): Memory[] {
    const cmp =
      opts.direction === 'before'
        ? sql`${memory.createdAt} < ${opts.pivotCreatedAt.getTime()}`
        : sql`${memory.createdAt} > ${opts.pivotCreatedAt.getTime()}`;
    const rows = this.db
      .select()
      .from(memory)
      .where(and(eq(memory.sessionId, opts.sessionId), cmp, sql`${memory.id} != ${opts.pivotId}`))
      .orderBy(opts.direction === 'before' ? desc(memory.createdAt) : memory.createdAt)
      .limit(opts.limit)
      .all();
    return opts.direction === 'before' ? rows.reverse() : rows;
  }

  /** Timeline fallback: in-scope neighbors within a created_at window. */
  windowNeighbors(opts: {
    scope: MemoryScope;
    projectId: string | null;
    pivotId: string;
    loMs: number;
    hiMs: number;
    pivotMs: number;
    direction: 'before' | 'after';
    limit: number;
  }): Memory[] {
    const scopeFilter =
      opts.scope === 'project'
        ? and(eq(memory.scope, 'project'), eq(memory.projectId, opts.projectId ?? ''))
        : and(eq(memory.scope, 'global'), isNull(memory.projectId));
    const windowCmp =
      opts.direction === 'before'
        ? sql`${memory.createdAt} >= ${opts.loMs} AND ${memory.createdAt} < ${opts.pivotMs}`
        : sql`${memory.createdAt} > ${opts.pivotMs} AND ${memory.createdAt} <= ${opts.hiMs}`;
    const rows = this.db
      .select()
      .from(memory)
      .where(and(scopeFilter, windowCmp, sql`${memory.id} != ${opts.pivotId}`))
      .orderBy(opts.direction === 'before' ? desc(memory.createdAt) : memory.createdAt)
      .limit(opts.limit)
      .all();
    return opts.direction === 'before' ? rows.reverse() : rows;
  }

  /** memory.stats: counts grouped by `status` and by `type` within scope. */
  countByStatusAndTypeInScope(
    scope: MemoryScope,
    projectId: string | null,
  ): {
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  } {
    const scopeFilter =
      scope === 'project'
        ? and(eq(memory.scope, 'project'), eq(memory.projectId, projectId ?? ''))
        : and(eq(memory.scope, 'global'), isNull(memory.projectId));
    const statusRows = this.db
      .select({ status: memory.status, n: count() })
      .from(memory)
      .where(scopeFilter)
      .groupBy(memory.status)
      .all();
    const typeRows = this.db
      .select({ type: memory.type, n: count() })
      .from(memory)
      .where(scopeFilter)
      .groupBy(memory.type)
      .all();
    const byStatus: Record<string, number> = {};
    for (const r of statusRows) byStatus[r.status] = r.n;
    const byType: Record<string, number> = {};
    for (const r of typeRows) byType[r.type] = r.n;
    return { byStatus, byType };
  }

  /** Per-project active+total memory counts for the project list tool. */
  countByProject(): { projectId: string; n: number }[] {
    return this.db
      .select({ projectId: memory.projectId, n: count() })
      .from(memory)
      .where(isNotNull(memory.projectId))
      .groupBy(memory.projectId)
      .all()
      .filter((r): r is { projectId: string; n: number } => r.projectId !== null);
  }

  /**
   * Chronological listing (no text query). The hybrid text-query path lives
   * in `services/hybrid-search.ts` and reads the lexical branch via
   * `searchBm25Ids`; this method owns only the no-query listing branch.
   */
  searchMemoryIds(opts: SearchMemoryIdsOpts): string[] {
    const typeClause = opts.type ? sql`AND m.type = ${opts.type}` : sql``;
    const tagClause = opts.tag
      ? sql`AND EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value = ${opts.tag})`
      : sql``;
    const rows = this.db.all<{ id: string }>(
      sql`
        SELECT m.id
        FROM memory m
        WHERE ${scopeWhere(opts.scope, opts.projectId, 'm')}
          AND m.status = ${opts.status}
          ${typeClause}
          ${tagClause}
        ORDER BY m.created_at DESC
        LIMIT ${opts.limit} OFFSET ${opts.offset}
      `,
    );
    return rows.map((r) => r.id);
  }

  /**
   * Lexical (FTS5/BM25) retriever for the hybrid search path: scoped ids
   * ordered by BM25 rank for a PRE-SANITIZED MATCH expression, bounded to a
   * rank window (no OFFSET — RRF fusion paginates in memory). Distinct from
   * the unscoped `adminSearchFts` and the save-time `searchBm25Candidates`.
   */
  searchBm25Ids(opts: SearchBm25IdsOpts): string[] {
    const typeClause = opts.type ? sql`AND m.type = ${opts.type}` : sql``;
    const tagClause = opts.tag
      ? sql`AND EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value = ${opts.tag})`
      : sql``;
    const rows = this.db.all<{ id: string }>(
      sql`
        SELECT m.id
        FROM memory_fts
          JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ${opts.matchExpr}
          AND ${scopeWhere(opts.scope, opts.projectId, 'm')}
          AND m.status = ${opts.status}
          ${typeClause}
          ${tagClause}
        ORDER BY bm25(memory_fts, ${FTS_WEIGHT_CONTENT}, ${FTS_WEIGHT_TAGS}, ${FTS_WEIGHT_TITLE})
        LIMIT ${opts.limit}
      `,
    );
    return rows.map((r) => r.id);
  }

  /** Subset of `ids` whose memory carries `tag` (dense-branch tag post-filter). */
  idsWithTag(ids: readonly string[], tag: string): Set<string> {
    if (ids.length === 0) return new Set();
    const rows = this.db.all<{ id: string }>(sql`
      SELECT m.id AS id
      FROM memory m
      WHERE m.id IN (SELECT value FROM json_each(${JSON.stringify([...ids])}))
        AND EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value = ${tag})
    `);
    return new Set(rows.map((r) => r.id));
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

  countAll(): number {
    const row = this.db.select({ value: count() }).from(memory).get();
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

  markSupersededMany(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.db
      .update(memory)
      .set({ status: 'superseded' as const })
      .where(inArray(memory.id, [...ids]))
      .run();
  }

  /** Archive the given ids that are currently active (decay pass). */
  archiveActive(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.db
      .update(memory)
      .set({ status: 'archived' as const })
      .where(and(inArray(memory.id, [...ids]), eq(memory.status, 'active')))
      .run();
  }

  archiveOne(id: string): void {
    this.db
      .update(memory)
      .set({ status: 'archived' as const })
      .where(eq(memory.id, id))
      .run();
  }

  reactivate(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.db
      .update(memory)
      .set({ status: 'active' as const })
      .where(inArray(memory.id, [...ids]))
      .run();
  }

  reactivateOne(id: string): void {
    this.db
      .update(memory)
      .set({ status: 'active' as const })
      .where(eq(memory.id, id))
      .run();
  }

  /** Subset of `ids` that still exist (purge-safety check before undo). */
  existingIds(ids: readonly string[]): Set<string> {
    if (ids.length === 0) return new Set();
    const rows = this.db
      .select({ id: memory.id })
      .from(memory)
      .where(inArray(memory.id, [...ids]))
      .all();
    return new Set(rows.map((r) => r.id));
  }

  findReplaces(id: string): string[] | undefined {
    return this.db.select({ replaces: memory.replaces }).from(memory).where(eq(memory.id, id)).get()
      ?.replaces;
  }

  findDecayCandidateIds(
    scope: MemoryScope,
    projectId: string | null,
    cutoff: Date,
    confidenceFloor: number,
  ): string[] {
    const scopeFilter =
      scope === 'global'
        ? and(eq(memory.scope, 'global'), isNull(memory.projectId))
        : and(eq(memory.scope, 'project'), eq(memory.projectId, projectId ?? ''));
    return this.db
      .select({ id: memory.id })
      .from(memory)
      .where(
        and(
          eq(memory.status, 'active'),
          sql`${memory.lastSeenAt} < ${cutoff.getTime()}`,
          scopeFilter,
          sql`(SELECT count(*) FROM ${confirmations} WHERE ${confirmations.memoryId} = ${memory.id}) < ${confidenceFloor}`,
        ),
      )
      .all()
      .map((r) => r.id);
  }

  /** Latest confirmation `event_ts` per memory id (the affirmation baseline source). */
  latestConfirmationTsByIds(ids: readonly string[]): Map<string, Date> {
    const out = new Map<string, Date>();
    if (ids.length === 0) return out;
    const rows = this.db
      .select({
        memoryId: confirmations.memoryId,
        latest: sql<number>`MAX(${confirmations.eventTs})`,
      })
      .from(confirmations)
      .where(inArray(confirmations.memoryId, [...ids]))
      .groupBy(confirmations.memoryId)
      .all();
    for (const r of rows) {
      if (r.latest != null) out.set(r.memoryId, new Date(Number(r.latest)));
    }
    return out;
  }

  /**
   * Active in-scope memories past their review shelf life, oldest affirmation
   * baseline first. The per-type TTL ladder is built from `ttlByType` (passed
   * by the service so the constant lives in exactly one place); a type absent
   * from `ttlByType` has no TTL and is excluded. Read-only; no transaction.
   */
  findNeedsReview(opts: {
    scope: MemoryScope;
    projectId: string | null;
    nowMs: number;
    limit: number;
    ttlByType: ReadonlyArray<readonly [MemoryType, number]>;
  }): Memory[] {
    if (opts.ttlByType.length === 0 || opts.limit <= 0) return [];
    const scopeFilter =
      opts.scope === 'global'
        ? and(eq(memory.scope, 'global'), isNull(memory.projectId))
        : and(eq(memory.scope, 'project'), eq(memory.projectId, opts.projectId ?? ''));
    return this.runNeedsReview(scopeFilter, opts.ttlByType, opts.nowMs, opts.limit, 0);
  }

  /**
   * Unscoped sibling of `findNeedsReview` for the operator dashboard. Optional
   * project filter mirrors `adminList`; `undefined` spans all scopes. Paginates
   * with limit/offset so the dashboard `review=needs_review` filter is correct.
   */
  adminFindNeedsReview(opts: {
    project?: AdminListMemoriesOpts['project'];
    nowMs: number;
    limit: number;
    offset: number;
    ttlByType: ReadonlyArray<readonly [MemoryType, number]>;
  }): Memory[] {
    if (opts.ttlByType.length === 0 || opts.limit <= 0) return [];
    let scopeFilter: SQL | undefined;
    if (opts.project?.kind === 'global') {
      scopeFilter = and(eq(memory.scope, 'global'), isNull(memory.projectId));
    } else if (opts.project?.kind === 'project') {
      scopeFilter = and(eq(memory.scope, 'project'), eq(memory.projectId, opts.project.projectId));
    }
    return this.runNeedsReview(scopeFilter, opts.ttlByType, opts.nowMs, opts.limit, opts.offset);
  }

  private needsReviewExprs(ttlByType: ReadonlyArray<readonly [MemoryType, number]>): {
    ttlExpr: SQL;
    baselineExpr: SQL;
  } {
    const ttlCase = sql.join(
      ttlByType.map(([t, ms]) => sql`WHEN ${memory.type} = ${t} THEN ${ms}`),
      sql` `,
    );
    const ttlExpr = sql`CASE ${ttlCase} ELSE NULL END`;
    const baselineExpr = sql`MAX(${memory.createdAt}, COALESCE((SELECT MAX(${confirmations.eventTs}) FROM ${confirmations} WHERE ${confirmations.memoryId} = ${memory.id}), ${memory.createdAt}))`;
    return { ttlExpr, baselineExpr };
  }

  private runNeedsReview(
    scopeFilter: SQL | undefined,
    ttlByType: ReadonlyArray<readonly [MemoryType, number]>,
    nowMs: number,
    limit: number,
    offset: number,
  ): Memory[] {
    const { ttlExpr, baselineExpr } = this.needsReviewExprs(ttlByType);

    return this.db
      .select()
      .from(memory)
      .where(
        and(
          eq(memory.status, 'active'),
          scopeFilter,
          sql`${ttlExpr} IS NOT NULL`,
          sql`${baselineExpr} + ${ttlExpr} <= ${nowMs}`,
        ),
      )
      .orderBy(sql`${baselineExpr} ASC`)
      .limit(limit)
      .offset(offset)
      .all();
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

  adminCount(opts: Omit<AdminListMemoriesOpts, 'limit' | 'offset'>): number {
    const conditions: SQL[] = [eq(memory.status, opts.status)];
    if (opts.type) conditions.push(eq(memory.type, opts.type));
    if (opts.project?.kind === 'global') {
      conditions.push(eq(memory.scope, 'global'), isNull(memory.projectId));
    } else if (opts.project?.kind === 'project') {
      conditions.push(eq(memory.scope, 'project'), eq(memory.projectId, opts.project.projectId));
    }
    const row = this.db
      .select({ value: count() })
      .from(memory)
      .where(and(...conditions))
      .get();
    return row?.value ?? 0;
  }

  adminCountFts(query: string, opts: Omit<AdminListMemoriesOpts, 'limit' | 'offset'>): number {
    // Mirror the status/type/scope filters the dashboard applies client-side to
    // the FTS page (see `clientSideFilter` in dashboard/memories.ts). Without
    // them the TOTAL counts superseded/out-of-scope matches the list drops,
    // diverging from what the user can actually page through.
    const conds: SQL[] = [sql`memory_fts MATCH ${query}`, sql`m.status = ${opts.status}`];
    if (opts.type) conds.push(sql`m.type = ${opts.type}`);
    if (opts.project?.kind === 'global') {
      conds.push(sql`m.scope = 'global' AND m.project_id IS NULL`);
    } else if (opts.project?.kind === 'project') {
      conds.push(sql`m.scope = 'project' AND m.project_id = ${opts.project.projectId}`);
    }
    const row = this.db.get<{ v: number }>(sql`
      SELECT COUNT(*) AS v
      FROM memory m
      JOIN memory_fts f ON f.rowid = m.rowid
      WHERE ${sql.join(conds, sql` AND `)}
    `) as { v: number } | undefined;
    return row?.v ?? 0;
  }

  adminCountNeedsReview(opts: {
    project?: AdminListMemoriesOpts['project'];
    nowMs: number;
    ttlByType: ReadonlyArray<readonly [MemoryType, number]>;
  }): number {
    if (opts.ttlByType.length === 0) return 0;
    let scopeFilter: SQL | undefined;
    if (opts.project?.kind === 'global') {
      scopeFilter = and(eq(memory.scope, 'global'), isNull(memory.projectId));
    } else if (opts.project?.kind === 'project') {
      scopeFilter = and(eq(memory.scope, 'project'), eq(memory.projectId, opts.project.projectId));
    }
    const { ttlExpr, baselineExpr } = this.needsReviewExprs(opts.ttlByType);
    const row = this.db
      .select({ value: count() })
      .from(memory)
      .where(
        and(
          eq(memory.status, 'active'),
          scopeFilter,
          sql`${ttlExpr} IS NOT NULL`,
          sql`${baselineExpr} + ${ttlExpr} <= ${opts.nowMs}`,
        ),
      )
      .get();
    return row?.value ?? 0;
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
