import { and, count, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';

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
import { projectScope, type SearchScope } from '../scope.js';

import { idJsonSet, projectIdsOf, scopeCondition, scopeWhere } from './scope-clause.js';

const FTS_WEIGHT_CONTENT = 1.0;
const FTS_WEIGHT_TAGS = 1.0;
const FTS_WEIGHT_TITLE = 2.0;

const ANCESTRY_HARD_LIMIT = 1000;

export interface ReviewTimestamps {
  affirmedAt: Date | null;
  refutedAt: Date | null;
}

export type RankingMetadata = Pick<Memory, 'type' | 'lastSeenAt' | 'sessionId' | 'projectId'>;

export interface SearchMemoryIdsOpts {
  scope: SearchScope;
  /** Omitted means "any but archived", not "active" — the `topic_key` history read (see `MemoryService.search`). */
  status?: MemoryStatus;
  type?: MemoryType;
  tag?: string;
  /** Exact topic_key filter (see openspec/changes/fix-audited-defects). */
  topicKey?: string;
  limit: number;
  offset: number;
}

export interface TextByIdsOpts {
  ids: readonly string[];
  scope: SearchScope;
}

export interface SearchBm25IdsOpts {
  /** Pre-sanitized FTS5 MATCH expression (see services/hybrid-search.ts). */
  matchExpr: string;
  scope: SearchScope;
  /** Omitted means "any but archived", not "active" — the `topic_key` history read (see `MemoryService.search`). */
  status?: MemoryStatus;
  type?: MemoryType;
  tag?: string;
  /** Exact topic_key filter (see openspec/changes/fix-audited-defects). */
  topicKey?: string;
  /** Bounded rank window depth (no OFFSET — fusion paginates in memory). */
  limit: number;
}

export interface AdminListMemoriesOpts {
  status: MemoryStatus;
  type?: MemoryType;
  projectId?: string;
  limit: number;
  offset: number;
}

export class MemoryRepository {
  constructor(private readonly db: Db) {}

  findActiveByTopicKey(opts: { projectId: string; topicKey: string }): Memory | undefined {
    return this.db
      .select()
      .from(memory)
      .where(
        sql`${scopeWhere(projectScope(opts.projectId))} AND topic_key = ${opts.topicKey} AND status = 'active'`,
      )
      .limit(1)
      .get();
  }

  searchBm25Candidates(opts: {
    matchExpr: string;
    excludeId: string;
    projectId: string;
    excludeIds: string[];
    limit: number;
  }): { id: string; rank: number; title: string; content: string; topicKey: string | null }[] {
    return this.db.all<{
      id: string;
      rank: number;
      title: string;
      content: string;
      topicKey: string | null;
    }>(
      sql`
        SELECT m.id AS id, memory_fts.rank AS rank, m.title AS title, m.content AS content,
               m.topic_key AS topicKey
        FROM memory_fts
          JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ${opts.matchExpr}
          AND m.id != ${opts.excludeId}
          AND ${scopeWhere(projectScope(opts.projectId), 'm')}
          AND m.status = 'active'
          AND m.id NOT IN (SELECT value FROM json_each(${JSON.stringify(opts.excludeIds)}))
        ORDER BY rank
        LIMIT ${opts.limit}
      `,
    );
  }

  /** Recent in-scope memories (memory.context), newest by last-seen/created. */
  recentForContext(opts: { projectId: string; includeArchived: boolean; limit: number }): Memory[] {
    const conditions: SQL[] = [scopeCondition(projectScope(opts.projectId))];
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
    projectId: string;
    sessionId: string;
    pivotCreatedAt: Date;
    pivotId: string;
    direction: 'before' | 'after';
    limit: number;
  }): Memory[] {
    const scopeFilter = scopeCondition(projectScope(opts.projectId));
    const cmp =
      opts.direction === 'before'
        ? sql`${memory.createdAt} < ${opts.pivotCreatedAt.getTime()}`
        : sql`${memory.createdAt} > ${opts.pivotCreatedAt.getTime()}`;
    const rows = this.db
      .select()
      .from(memory)
      .where(
        and(
          scopeFilter,
          eq(memory.sessionId, opts.sessionId),
          cmp,
          sql`${memory.id} != ${opts.pivotId}`,
        ),
      )
      .orderBy(opts.direction === 'before' ? desc(memory.createdAt) : memory.createdAt)
      .limit(opts.limit)
      .all();
    return opts.direction === 'before' ? rows.reverse() : rows;
  }

  /** Timeline fallback: in-scope neighbors within a created_at window. */
  windowNeighbors(opts: {
    projectId: string;
    pivotId: string;
    loMs: number;
    hiMs: number;
    pivotMs: number;
    direction: 'before' | 'after';
    limit: number;
  }): Memory[] {
    const scopeFilter = scopeCondition(projectScope(opts.projectId));
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
  countByStatusAndTypeInScope(projectId: string): {
    byStatus: Record<string, number>;
    byType: Record<string, number>;
  } {
    const scopeFilter = scopeCondition(projectScope(projectId));
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

  /** project.list: memories in one scope whose `status` is `active`; other statuses do not count. */
  countActiveInScope(projectId: string): number {
    const row = this.db
      .select({ value: count() })
      .from(memory)
      .where(and(scopeCondition(projectScope(projectId)), eq(memory.status, 'active')))
      .get();
    return row?.value ?? 0;
  }

  searchMemoryIds(opts: SearchMemoryIdsOpts): string[] {
    const typeClause = opts.type ? sql`AND m.type = ${opts.type}` : sql``;
    const tagClause = opts.tag
      ? sql`AND EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value = ${opts.tag})`
      : sql``;
    const topicKeyClause = opts.topicKey ? sql`AND m.topic_key = ${opts.topicKey}` : sql``;
    const statusClause = opts.status
      ? sql`AND m.status = ${opts.status}`
      : sql`AND m.status != 'archived'`;
    const rows = this.db.all<{ id: string }>(
      sql`
        SELECT m.id
        FROM memory m
        WHERE ${scopeWhere(opts.scope, 'm')}
          ${statusClause}
          ${typeClause}
          ${tagClause}
          ${topicKeyClause}
        ORDER BY m.created_at DESC
        LIMIT ${opts.limit} OFFSET ${opts.offset}
      `,
    );
    return rows.map((r) => r.id);
  }

  searchBm25Ids(opts: SearchBm25IdsOpts): { id: string; rank: number }[] {
    const typeClause = opts.type ? sql`AND m.type = ${opts.type}` : sql``;
    const tagClause = opts.tag
      ? sql`AND EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value = ${opts.tag})`
      : sql``;
    const topicKeyClause = opts.topicKey ? sql`AND m.topic_key = ${opts.topicKey}` : sql``;
    const statusClause = opts.status
      ? sql`AND m.status = ${opts.status}`
      : sql`AND m.status != 'archived'`;
    const rank = sql`bm25(memory_fts, ${FTS_WEIGHT_CONTENT}, ${FTS_WEIGHT_TAGS}, ${FTS_WEIGHT_TITLE})`;
    const matched = sql`
        FROM memory_fts
          JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ${opts.matchExpr}
          AND ${scopeWhere(opts.scope, 'm')}
          ${statusClause}
          ${typeClause}
          ${tagClause}
          ${topicKeyClause}`;
    if (projectIdsOf(opts.scope).length === 1) {
      return this.db.all<{ id: string; rank: number }>(
        sql`
        SELECT m.id AS id, ${rank} AS rank${matched}
        ORDER BY rank
        LIMIT ${opts.limit}
      `,
      );
    }
    return this.db.all<{ id: string; rank: number }>(
      sql`
        SELECT id, rank FROM (
          SELECT id, rank,
                 ROW_NUMBER() OVER (PARTITION BY project_id ORDER BY rank) AS project_rank
          FROM (
            SELECT m.id AS id, m.project_id AS project_id, ${rank} AS rank${matched}
          )
        )
        WHERE project_rank <= ${opts.limit}
        ORDER BY rank
      `,
    );
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

  /** An out-of-scope id is absent from the result rather than reported. */
  textByIds(opts: TextByIdsOpts): Pick<Memory, 'id' | 'title' | 'content'>[] {
    if (opts.ids.length === 0) return [];
    return this.db.all<Pick<Memory, 'id' | 'title' | 'content'>>(sql`
      SELECT m.id AS id, m.title AS title, m.content AS content
      FROM json_each(${JSON.stringify([...opts.ids])}) je
        CROSS JOIN memory m ON m.id = je.value
      WHERE ${scopeWhere(opts.scope, 'm')}
    `);
  }

  /** Subset of `ids` whose memory carries `topicKey` (dense-branch topic_key post-filter). */
  idsWithTopicKey(ids: readonly string[], topicKey: string): Set<string> {
    if (ids.length === 0) return new Set();
    const rows = this.db.all<{ id: string }>(sql`
      SELECT m.id AS id
      FROM memory m
      WHERE m.id IN (SELECT value FROM json_each(${JSON.stringify([...ids])}))
        AND m.topic_key = ${topicKey}
    `);
    return new Set(rows.map((r) => r.id));
  }

  listNearbyTopicKeys(opts: {
    projectId: string;
    prefix: string;
    excludeExact: string;
    limit: number;
  }): { topicKey: string; title: string }[] {
    const likePattern = `${opts.prefix.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    return this.db.all<{ topicKey: string; title: string }>(sql`
      SELECT m.topic_key AS topicKey, m.title AS title
      FROM memory m
      WHERE ${scopeWhere(projectScope(opts.projectId), 'm')}
        AND m.status = 'active'
        AND m.topic_key IS NOT NULL
        AND m.topic_key != ${opts.excludeExact}
        AND m.topic_key LIKE ${likePattern} ESCAPE '\\'
      ORDER BY m.topic_key
      LIMIT ${opts.limit}
    `);
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
      .where(sql`${memory.id} IN ${idJsonSet(ids)}`)
      .all();
  }

  findScopeTupleById(id: string):
    | {
        scope: MemoryScope;
        projectId: string | null;
        replaces: string[];
        status: MemoryStatus;
      }
    | undefined {
    return this.db
      .select({
        scope: memory.scope,
        projectId: memory.projectId,
        replaces: memory.replaces,
        status: memory.status,
      })
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
          FROM memory_replaces mr
          JOIN memory m ON m.id = mr.successor_id
          WHERE mr.predecessor_id = ${id}
          ORDER BY m.created_at DESC
          LIMIT 1
        `,
      )
      .at(0)?.id;
  }

  /** All-scope memory counts grouped by status (dashboard stats, one query). */
  countRowsByStatus(): { status: MemoryStatus; count: number }[] {
    return this.db
      .select({ status: memory.status, count: count() })
      .from(memory)
      .groupBy(memory.status)
      .all();
  }

  /** Affirmation count only — a refutation is evidence against trust, not for it. */
  countConfirmations(memoryId: string): number {
    const row = this.db
      .select({ value: count() })
      .from(confirmations)
      .where(and(eq(confirmations.memoryId, memoryId), eq(confirmations.verdict, 'affirm')))
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
      .where(sql`${memory.id} IN ${idJsonSet(ids)}`)
      .run();
  }

  /** Archive the given ids that are currently active (decay pass). */
  archiveActive(ids: readonly string[]): void {
    if (ids.length === 0) return;
    this.db
      .update(memory)
      .set({ status: 'archived' as const })
      .where(and(sql`${memory.id} IN ${idJsonSet(ids)}`, eq(memory.status, 'active')))
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
      .where(sql`${memory.id} IN ${idJsonSet(ids)}`)
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
      .where(sql`${memory.id} IN ${idJsonSet(ids)}`)
      .all();
    return new Set(rows.map((r) => r.id));
  }

  findReplaces(id: string): string[] | undefined {
    return this.db.select({ replaces: memory.replaces }).from(memory).where(eq(memory.id, id)).get()
      ?.replaces;
  }

  unsafeAncestorIds(opts: { startIds: readonly string[]; limit: number }): string[] {
    if (opts.startIds.length === 0 || opts.limit <= 0) return [];
    const limit = Math.min(Math.trunc(opts.limit), ANCESTRY_HARD_LIMIT);
    const rows = this.db.all<{ id: string }>(sql`
      WITH RECURSIVE anc(id) AS (
        SELECT value FROM json_each(${JSON.stringify([...opts.startIds])})
        UNION
        SELECT je.value
          FROM anc
          JOIN ${memory} m ON m.id = anc.id
          JOIN json_each(m.replaces) je
      )
      SELECT id FROM anc LIMIT ${limit}
    `);
    return rows.map((r) => r.id);
  }

  unsafeProjectionByIds(
    ids: readonly string[],
  ): Pick<Memory, 'id' | 'title' | 'status' | 'createdAt'>[] {
    if (ids.length === 0) return [];
    return this.db
      .select({
        id: memory.id,
        title: memory.title,
        status: memory.status,
        createdAt: memory.createdAt,
      })
      .from(memory)
      .where(sql`${memory.id} IN ${idJsonSet(ids)}`)
      .all();
  }

  findDecayCandidateIds(opts: {
    projectId: string;
    nowMs: number;
    thresholdByType: ReadonlyArray<readonly [MemoryType, number]>;
    defaultThresholdMs: number;
    confidenceFloor: number;
  }): string[] {
    const scopeFilter = scopeCondition(projectScope(opts.projectId));
    const thresholdExpr =
      opts.thresholdByType.length > 0
        ? sql`CASE ${sql.join(
            opts.thresholdByType.map(([t, ms]) => sql`WHEN ${memory.type} = ${t} THEN ${ms}`),
            sql` `,
          )} ELSE ${opts.defaultThresholdMs} END`
        : sql`${opts.defaultThresholdMs}`;
    const recencyRule = and(
      sql`${memory.lastSeenAt} < (${opts.nowMs} - ${thresholdExpr})`,
      sql`(SELECT count(*) FROM ${confirmations} WHERE ${confirmations.memoryId} = ${memory.id} AND ${confirmations.verdict} = 'affirm') < ${opts.confidenceFloor}`,
    );

    return this.db
      .select({ id: memory.id })
      .from(memory)
      .where(and(eq(memory.status, 'active'), scopeFilter, recencyRule))
      .all()
      .map((r) => r.id);
  }

  reviewTimestampsByIds(ids: readonly string[]): Map<string, ReviewTimestamps> {
    const out = new Map<string, ReviewTimestamps>();
    if (ids.length === 0) return out;
    const rows = this.db
      .select({
        memoryId: confirmations.memoryId,
        verdict: confirmations.verdict,
        latest: sql<number>`MAX(${confirmations.eventTs})`,
      })
      .from(confirmations)
      .where(inArray(confirmations.memoryId, [...ids]))
      .groupBy(confirmations.memoryId, confirmations.verdict)
      .all();
    for (const r of rows) {
      if (r.latest == null) continue;
      const entry = out.get(r.memoryId) ?? { affirmedAt: null, refutedAt: null };
      // Matched positively: the SQL baseline counts only 'affirm'.
      if (r.verdict === 'affirm') entry.affirmedAt = new Date(Number(r.latest));
      else if (r.verdict === 'refute') entry.refutedAt = new Date(Number(r.latest));
      else continue;
      out.set(r.memoryId, entry);
    }
    return out;
  }

  /** Affirmation count per memory id (search ranking boost input) — refutations never boost. */
  confirmationCountsByIds(ids: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    const rows = this.db
      .select({ memoryId: confirmations.memoryId, n: count() })
      .from(confirmations)
      .where(and(inArray(confirmations.memoryId, [...ids]), eq(confirmations.verdict, 'affirm')))
      .groupBy(confirmations.memoryId)
      .all();
    for (const r of rows) out.set(r.memoryId, r.n);
    return out;
  }

  /** Lightweight projection per id: the ranking boost's inputs plus the row's project, which orders exact ties. */
  rankingMetadataByIds(ids: readonly string[]): Map<string, RankingMetadata> {
    const out = new Map<string, RankingMetadata>();
    if (ids.length === 0) return out;
    const rows = this.db
      .select({
        id: memory.id,
        type: memory.type,
        lastSeenAt: memory.lastSeenAt,
        sessionId: memory.sessionId,
        projectId: memory.projectId,
      })
      .from(memory)
      .where(inArray(memory.id, [...ids]))
      .all();
    for (const r of rows)
      out.set(r.id, {
        type: r.type,
        lastSeenAt: r.lastSeenAt,
        sessionId: r.sessionId,
        projectId: r.projectId,
      });
    return out;
  }

  findNeedsReview(opts: {
    projectId: string;
    nowMs: number;
    limit: number;
    ttlByType: ReadonlyArray<readonly [MemoryType, number]>;
    refutedPriorityMs: number;
  }): Memory[] {
    if (opts.ttlByType.length === 0 || opts.limit <= 0) return [];
    return this.runNeedsReview(
      scopeCondition(projectScope(opts.projectId)),
      opts.ttlByType,
      opts.nowMs,
      opts.limit,
      0,
      opts.refutedPriorityMs,
    );
  }

  /** Scoped needs-review total; `adminCountNeedsReview` is the unscoped twin. */
  countNeedsReview(opts: {
    projectId: string;
    nowMs: number;
    ttlByType: ReadonlyArray<readonly [MemoryType, number]>;
  }): number {
    if (opts.ttlByType.length === 0) return 0;
    return this.runCountNeedsReview(
      scopeCondition(projectScope(opts.projectId)),
      opts.ttlByType,
      opts.nowMs,
    );
  }

  private runCountNeedsReview(
    scopeFilter: SQL | undefined,
    ttlByType: ReadonlyArray<readonly [MemoryType, number]>,
    nowMs: number,
  ): number {
    const row = this.db
      .select({ value: count() })
      .from(memory)
      .where(
        and(eq(memory.status, 'active'), scopeFilter, this.needsReviewPredicate(ttlByType, nowMs)),
      )
      .get();
    return row?.value ?? 0;
  }

  adminFindNeedsReview(opts: {
    projectId?: string;
    nowMs: number;
    limit: number;
    offset: number;
    ttlByType: ReadonlyArray<readonly [MemoryType, number]>;
    refutedPriorityMs: number;
  }): Memory[] {
    if (opts.ttlByType.length === 0 || opts.limit <= 0) return [];
    const scopeFilter = opts.projectId ? scopeCondition(projectScope(opts.projectId)) : undefined;
    return this.runNeedsReview(
      scopeFilter,
      opts.ttlByType,
      opts.nowMs,
      opts.limit,
      opts.offset,
      opts.refutedPriorityMs,
    );
  }

  private refutedSinceExpr(baselineExpr: SQL, sinceMs?: number): SQL {
    const recency = sinceMs === undefined ? sql`` : sql` AND ${confirmations.eventTs} > ${sinceMs}`;
    return sql`EXISTS (SELECT 1 FROM ${confirmations} WHERE ${confirmations.memoryId} = ${memory.id} AND ${confirmations.verdict} = 'refute' AND ${confirmations.eventTs} > (${baselineExpr})${recency})`;
  }

  private needsReviewExprs(ttlByType: ReadonlyArray<readonly [MemoryType, number]>): {
    ttlExpr: SQL;
    baselineExpr: SQL;
    refutedExpr: SQL;
  } {
    const ttlCase = sql.join(
      ttlByType.map(([t, ms]) => sql`WHEN ${memory.type} = ${t} THEN ${ms}`),
      sql` `,
    );
    const ttlExpr = sql`CASE ${ttlCase} ELSE NULL END`;
    const baselineExpr = sql`MAX(${memory.createdAt}, COALESCE((SELECT MAX(${confirmations.eventTs}) FROM ${confirmations} WHERE ${confirmations.memoryId} = ${memory.id} AND ${confirmations.verdict} = 'affirm'), ${memory.createdAt}))`;
    return { ttlExpr, baselineExpr, refutedExpr: this.refutedSinceExpr(baselineExpr) };
  }

  /** Composed so the three needs-review call sites cannot drift apart. */
  private needsReviewPredicate(
    ttlByType: ReadonlyArray<readonly [MemoryType, number]>,
    nowMs: number,
  ): SQL {
    const { ttlExpr, baselineExpr, refutedExpr } = this.needsReviewExprs(ttlByType);
    return sql`((${ttlExpr} IS NOT NULL AND ${baselineExpr} + ${ttlExpr} <= ${nowMs}) OR ${refutedExpr})`;
  }

  private runNeedsReview(
    scopeFilter: SQL | undefined,
    ttlByType: ReadonlyArray<readonly [MemoryType, number]>,
    nowMs: number,
    limit: number,
    offset: number,
    refutedPriorityMs: number,
  ): Memory[] {
    const { baselineExpr } = this.needsReviewExprs(ttlByType);
    const recentlyRefutedExpr = this.refutedSinceExpr(baselineExpr, nowMs - refutedPriorityMs);

    return this.db
      .select()
      .from(memory)
      .where(
        and(eq(memory.status, 'active'), scopeFilter, this.needsReviewPredicate(ttlByType, nowMs)),
      )
      .orderBy(sql`${recentlyRefutedExpr} DESC`, sql`${baselineExpr} ASC`)
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
      .where(sql`${memory.id} IN ${idJsonSet(ids)}`)
      .run();
  }

  insertConfirmation(values: NewConfirmation): void {
    this.db.insert(confirmations).values(values).run();
  }

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

  purgeByIds(ids: readonly string[]): void {
    if (ids.length === 0) return;
    const idSet = idJsonSet(ids);
    this.db.run(sql`DELETE FROM memory_vec WHERE memory_id IN ${idSet}`);
    // No ON DELETE CASCADE on these, so they must precede the memory DELETE.
    this.db.run(sql`DELETE FROM memory_entity_links WHERE memory_id IN ${idSet}`);
    this.db.run(sql`DELETE FROM memory_entity_scan WHERE memory_id IN ${idSet}`);
    this.db.run(sql`DELETE FROM memory WHERE id IN ${idSet}`);
  }

  /** Shared by `adminSearchFts` + `adminCountFts` so the list and its total filter the same set. */
  private adminFtsConds(
    query: string,
    opts: Pick<AdminListMemoriesOpts, 'status' | 'type' | 'projectId'>,
  ): SQL[] {
    const conds: SQL[] = [sql`memory_fts MATCH ${query}`, sql`m.status = ${opts.status}`];
    if (opts.type) conds.push(sql`m.type = ${opts.type}`);
    if (opts.projectId) conds.push(scopeWhere(projectScope(opts.projectId), 'm'));
    return conds;
  }

  adminSearchFts(query: string, opts: AdminListMemoriesOpts): Memory[] {
    const conds = this.adminFtsConds(query, opts);
    const ids = this.db
      .all<{ id: string }>(
        sql`
          SELECT m.id
          FROM memory m
          JOIN memory_fts f ON f.rowid = m.rowid
          WHERE ${sql.join(conds, sql` AND `)}
          ORDER BY rank, m.created_at DESC
          LIMIT ${opts.limit} OFFSET ${opts.offset}
        `,
      )
      .map((r) => r.id);
    return this.unsafeGetByIds(ids);
  }

  adminList(opts: AdminListMemoriesOpts): Memory[] {
    const conditions: SQL[] = [eq(memory.status, opts.status)];
    if (opts.type) conditions.push(eq(memory.type, opts.type));
    if (opts.projectId) conditions.push(scopeCondition(projectScope(opts.projectId)));
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
    if (opts.projectId) conditions.push(scopeCondition(projectScope(opts.projectId)));
    const row = this.db
      .select({ value: count() })
      .from(memory)
      .where(and(...conditions))
      .get();
    return row?.value ?? 0;
  }

  adminCountFts(query: string, opts: Omit<AdminListMemoriesOpts, 'limit' | 'offset'>): number {
    const conds = this.adminFtsConds(query, opts);
    const row = this.db.get<{ v: number }>(sql`
      SELECT COUNT(*) AS v
      FROM memory m
      JOIN memory_fts f ON f.rowid = m.rowid
      WHERE ${sql.join(conds, sql` AND `)}
    `) as { v: number } | undefined;
    return row?.v ?? 0;
  }

  adminCountNeedsReview(opts: {
    projectId?: string;
    nowMs: number;
    ttlByType: ReadonlyArray<readonly [MemoryType, number]>;
  }): number {
    if (opts.ttlByType.length === 0) return 0;
    const scopeFilter = opts.projectId ? scopeCondition(projectScope(opts.projectId)) : undefined;
    return this.runCountNeedsReview(scopeFilter, opts.ttlByType, opts.nowMs);
  }

  adminCountNeedsReviewByProject(opts: {
    nowMs: number;
    ttlByType: ReadonlyArray<readonly [MemoryType, number]>;
  }): Array<{ projectId: string | null; count: number }> {
    if (opts.ttlByType.length === 0) return [];
    return this.db
      .select({ projectId: memory.projectId, count: count() })
      .from(memory)
      .where(
        and(eq(memory.status, 'active'), this.needsReviewPredicate(opts.ttlByType, opts.nowMs)),
      )
      .groupBy(memory.projectId)
      .all();
  }

  adminGetByIds(ids: readonly string[]): Memory[] {
    return this.unsafeGetByIds(ids);
  }

  adminCountConfirmations(memoryId: string): number {
    return this.countConfirmations(memoryId);
  }

  /** Memory count per session, for the caller's page. Empty input → `{}`. */
  adminCountBySession(sessionIds: readonly string[]): Record<string, number> {
    if (sessionIds.length === 0) return {};
    const rows = this.db
      .select({ sessionId: memory.sessionId, n: count() })
      .from(memory)
      // `IN (<non-null set>)` already excludes a NULL session_id.
      .where(inArray(memory.sessionId, idJsonSet(sessionIds)))
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

  /** Per-session daily write counts since `since`; empty input → `[]`, missing days absent. */
  adminMemoryWritesBySessionPerDay(
    sessionIds: readonly string[],
    since: Date,
  ): { sessionId: string; day: number; n: number }[] {
    if (sessionIds.length === 0) return [];
    const day = sql<number>`(created_at / 86400000)`;
    const rows = this.db
      .select({ sessionId: memory.sessionId, day, n: count() })
      .from(memory)
      // `IN (<non-null set>)` already excludes a NULL session_id.
      .where(and(inArray(memory.sessionId, idJsonSet(sessionIds)), gte(memory.createdAt, since)))
      .groupBy(memory.sessionId, day)
      .orderBy(memory.sessionId, day)
      .all();
    return rows.flatMap((r) =>
      r.sessionId ? [{ sessionId: r.sessionId, day: r.day, n: r.n }] : [],
    );
  }
}

const PURGE_PREDICATE = sql`m.status = 'archived'
         AND m.id NOT IN (
             SELECT predecessor_id FROM memory_replaces)
         AND m.id NOT IN (
             SELECT created_id FROM consolidation_ops WHERE created_id IS NOT NULL)
         AND m.id NOT IN (
             SELECT je2.value FROM consolidation_ops co, json_each(co.affected_ids) je2
              WHERE co.op_type != 'agent_memory_archive')
         AND m.id NOT IN (
             SELECT source_id FROM memory_relations
              UNION ALL SELECT target_id FROM memory_relations)
         AND m.id NOT IN (
             SELECT memory_id FROM confirmations)`;
