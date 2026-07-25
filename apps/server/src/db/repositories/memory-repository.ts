import { and, count, desc, eq, gte, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';

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

import { scopeCondition, scopeWhere } from './scope-clause.js';

// BM25 column weights for the interactive search lexical branch, in
// `memory_fts` declaration order (content, tags, title). A title hit is a
// strong relevance signal, so title is weighted above content. Save-time
// candidate detection deliberately keeps default (unweighted) ranking —
// admission is by rank position within the pool (see
// save-time-candidates.ts), so reweighting here would silently change
// which rows fall inside that pool.
const FTS_WEIGHT_CONTENT = 1.0;
const FTS_WEIGHT_TAGS = 1.0;
const FTS_WEIGHT_TITLE = 2.0;

export interface SearchMemoryIdsOpts {
  scope: MemoryScope;
  projectId: string | null;
  status: MemoryStatus;
  type?: MemoryType;
  tag?: string;
  /** Exact topic_key filter (see openspec/changes/fix-audited-defects). */
  topicKey?: string;
  limit: number;
  offset: number;
  /** Widen a `project` scope to also match `global` rows; no-op for `global` scope. */
  includeGlobal?: boolean;
}

export interface SearchBm25IdsOpts {
  /** Pre-sanitized FTS5 MATCH expression (see services/hybrid-search.ts). */
  matchExpr: string;
  scope: MemoryScope;
  projectId: string | null;
  status: MemoryStatus;
  type?: MemoryType;
  tag?: string;
  /** Exact topic_key filter (see openspec/changes/fix-audited-defects). */
  topicKey?: string;
  /** Bounded rank window depth (no OFFSET — fusion paginates in memory). */
  limit: number;
  /** Widen a `project` scope to also match `global` rows; no-op for `global` scope. */
  includeGlobal?: boolean;
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
   * admission here is by rank position within the pool (see
   * save-time-candidates.ts), so reweighting would silently change which
   * rows are admitted. (The MATCH does now span the `title` column too, so a
   * saved row's content tokens can match an existing row's title — a small,
   * intentional recall widening; the rank ordering itself is unchanged.)
   */
  searchBm25Candidates(opts: {
    matchExpr: string;
    excludeId: string;
    scope: MemoryScope;
    projectId: string | null;
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
    const conditions: SQL[] = [scopeCondition(opts.scope, opts.projectId)];
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
    scope: MemoryScope;
    projectId: string | null;
    sessionId: string;
    pivotCreatedAt: Date;
    pivotId: string;
    direction: 'before' | 'after';
    limit: number;
  }): Memory[] {
    const scopeFilter = scopeCondition(opts.scope, opts.projectId);
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
    scope: MemoryScope;
    projectId: string | null;
    pivotId: string;
    loMs: number;
    hiMs: number;
    pivotMs: number;
    direction: 'before' | 'after';
    limit: number;
  }): Memory[] {
    const scopeFilter = scopeCondition(opts.scope, opts.projectId);
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
    const scopeFilter = scopeCondition(scope, projectId);
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
    const topicKeyClause = opts.topicKey ? sql`AND m.topic_key = ${opts.topicKey}` : sql``;
    const rows = this.db.all<{ id: string }>(
      sql`
        SELECT m.id
        FROM memory m
        WHERE ${scopeWhere(opts.scope, opts.projectId, 'm', opts.includeGlobal)}
          AND m.status = ${opts.status}
          ${typeClause}
          ${tagClause}
          ${topicKeyClause}
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
  searchBm25Ids(opts: SearchBm25IdsOpts): { id: string; rank: number }[] {
    const typeClause = opts.type ? sql`AND m.type = ${opts.type}` : sql``;
    const tagClause = opts.tag
      ? sql`AND EXISTS (SELECT 1 FROM json_each(m.tags) je WHERE je.value = ${opts.tag})`
      : sql``;
    const topicKeyClause = opts.topicKey ? sql`AND m.topic_key = ${opts.topicKey}` : sql``;
    return this.db.all<{ id: string; rank: number }>(
      sql`
        SELECT m.id AS id, bm25(memory_fts, ${FTS_WEIGHT_CONTENT}, ${FTS_WEIGHT_TAGS}, ${FTS_WEIGHT_TITLE}) AS rank
        FROM memory_fts
          JOIN memory m ON m.rowid = memory_fts.rowid
        WHERE memory_fts MATCH ${opts.matchExpr}
          AND ${scopeWhere(opts.scope, opts.projectId, 'm', opts.includeGlobal)}
          AND m.status = ${opts.status}
          ${typeClause}
          ${tagClause}
          ${topicKeyClause}
        ORDER BY rank
        LIMIT ${opts.limit}
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

  /**
   * Active in-scope topic_keys sharing a prefix with `prefix`, for
   * `memory.suggest_topic_key`'s `nearby` hint. Excludes an exact match
   * (surfaced separately as `occupied`). Bounded, alphabetical.
   */
  listNearbyTopicKeys(opts: {
    scope: MemoryScope;
    projectId: string | null;
    prefix: string;
    excludeExact: string;
    limit: number;
  }): { topicKey: string; title: string }[] {
    const likePattern = `${opts.prefix.replace(/[%_]/g, (c) => `\\${c}`)}%`;
    return this.db.all<{ topicKey: string; title: string }>(sql`
      SELECT m.topic_key AS topicKey, m.title AS title
      FROM memory m
      WHERE ${scopeWhere(opts.scope, opts.projectId, 'm')}
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
    nowMs: number,
    thresholdByType: ReadonlyArray<readonly [MemoryType, number]>,
    defaultThresholdMs: number,
    confidenceFloor: number,
  ): string[] {
    const scopeFilter = scopeCondition(scope, projectId);
    // Per-type inactivity window: a row decays once last_seen_at predates
    // (now - threshold(type)). Mirrors the CASE ladder in `runNeedsReview`.
    const thresholdExpr =
      thresholdByType.length > 0
        ? sql`CASE ${sql.join(
            thresholdByType.map(([t, ms]) => sql`WHEN ${memory.type} = ${t} THEN ${ms}`),
            sql` `,
          )} ELSE ${defaultThresholdMs} END`
        : sql`${defaultThresholdMs}`;
    return this.db
      .select({ id: memory.id })
      .from(memory)
      .where(
        and(
          eq(memory.status, 'active'),
          sql`${memory.lastSeenAt} < (${nowMs} - ${thresholdExpr})`,
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

  /** Confirmation count per memory id (search ranking boost input). */
  confirmationCountsByIds(ids: readonly string[]): Map<string, number> {
    const out = new Map<string, number>();
    if (ids.length === 0) return out;
    const rows = this.db
      .select({ memoryId: confirmations.memoryId, n: count() })
      .from(confirmations)
      .where(inArray(confirmations.memoryId, [...ids]))
      .groupBy(confirmations.memoryId)
      .all();
    for (const r of rows) out.set(r.memoryId, r.n);
    return out;
  }

  /** Lightweight `(type, last_seen_at)` projection per id (search ranking boost input). */
  rankingMetadataByIds(
    ids: readonly string[],
  ): Map<string, { type: MemoryType; lastSeenAt: Date | null; sessionId: string | null }> {
    const out = new Map<
      string,
      { type: MemoryType; lastSeenAt: Date | null; sessionId: string | null }
    >();
    if (ids.length === 0) return out;
    const rows = this.db
      .select({
        id: memory.id,
        type: memory.type,
        lastSeenAt: memory.lastSeenAt,
        sessionId: memory.sessionId,
      })
      .from(memory)
      .where(inArray(memory.id, [...ids]))
      .all();
    for (const r of rows)
      out.set(r.id, { type: r.type, lastSeenAt: r.lastSeenAt, sessionId: r.sessionId });
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
    return this.runNeedsReview(
      scopeCondition(opts.scope, opts.projectId),
      opts.ttlByType,
      opts.nowMs,
      opts.limit,
      0,
    );
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
      scopeFilter = scopeCondition('global', null);
    } else if (opts.project?.kind === 'project') {
      scopeFilter = scopeCondition('project', opts.project.projectId);
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

  /** Shared by `adminSearchFts` + `adminCountFts` so the list and its total filter the same set. */
  private adminFtsConds(
    query: string,
    opts: Pick<AdminListMemoriesOpts, 'status' | 'type' | 'project'>,
  ): SQL[] {
    const conds: SQL[] = [sql`memory_fts MATCH ${query}`, sql`m.status = ${opts.status}`];
    if (opts.type) conds.push(sql`m.type = ${opts.type}`);
    if (opts.project?.kind === 'global') {
      conds.push(scopeWhere('global', null, 'm'));
    } else if (opts.project?.kind === 'project') {
      conds.push(scopeWhere('project', opts.project.projectId, 'm'));
    }
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
    project?: AdminListMemoriesOpts['project'];
    nowMs: number;
    ttlByType: ReadonlyArray<readonly [MemoryType, number]>;
  }): number {
    if (opts.ttlByType.length === 0) return 0;
    let scopeFilter: SQL | undefined;
    if (opts.project?.kind === 'global') {
      scopeFilter = scopeCondition('global', null);
    } else if (opts.project?.kind === 'project') {
      scopeFilter = scopeCondition('project', opts.project.projectId);
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
 *     (EXCEPT an `agent_memory_archive` op: that op IS the archive that
 *     retired this memory, so it must not pin its own subject against a
 *     later operator purge) or `created_id`
 *   - no memory_relations row references this id as source or target
 *   - no confirmations row references this id as `memory_id`
 */
// NOT IN (rather than correlated NOT EXISTS) so each reference set materializes
// once instead of re-scanning per archived row — same result set, ~1200× faster
// at 50k rows. NOT IN is NULL-sensitive: a single NULL in any subquery would make
// the whole predicate NULL (excluding every row). Every column below is NOT NULL
// EXCEPT consolidation_ops.created_id, so its `WHERE created_id IS NOT NULL`
// filter is load-bearing — do not remove it.
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
