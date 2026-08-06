import { and, count, desc, eq, gte, inArray, sql, type SQL } from 'drizzle-orm';

import { projectScope, type SearchScope } from '../../services/scope.js';
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

import { idJsonSet, projectIdsOf, scopeCondition, scopeWhere } from './scope-clause.js';

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

/**
 * Ceiling on any single ancestry read, far above both call sites' bounds
 * (`PREDECESSOR_CAP + 2` and `DISMISSAL_ANCESTRY_CAP`). It exists so the one thing
 * keeping the traversal flat cannot be removed by a caller passing a large number.
 */
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

  /**
   * Lexical (FTS5/BM25) retriever for the hybrid search path: scoped ids
   * ordered by BM25 rank for a PRE-SANITIZED MATCH expression, bounded to a
   * rank window (no OFFSET — RRF fusion paginates in memory). Distinct from
   * the unscoped `adminSearchFts` and the save-time `searchBm25Candidates`.
   *
   * `limit` is the window EACH named project draws, not a total over the union:
   * a single bound would let a foreign project displace home rows, so adding an
   * authorized project would subtract from what the home project contributes
   * (memory/spec.md, "the pool grows with the set rather than being rationed
   * across it"). The rows stay in one global BM25 order across the whole set.
   */
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
    // One project partitions into itself, so the window would only buy it a
    // full materialisation of the match set where `ORDER BY … LIMIT` fills a
    // bounded sorter. Emitting the narrow statement unchanged keeps that read's
    // opcode stream identical, not merely its query plan.
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
    // `CROSS JOIN` is the join-order hint, not a semantic change: SQLite has no
    // cardinality estimate for `json_each` and otherwise drives from
    // `memory_scope_seen_idx`, bloom-filtering its way through every row in the
    // scope — the corpus-sized scan this hot-path read exists to avoid. Pinning
    // the id list as the outer loop makes it one PK seek per id.
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

  /**
   * Active in-scope topic_keys sharing a prefix with `prefix`, for
   * `memory.suggest_topic_key`'s `nearby` hint. Excludes an exact match
   * (surfaced separately as `occupied`). Bounded, alphabetical.
   */
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

  /**
   * Minimal scope tuple for same-scope assertions; no content leaks. Reports
   * the row's STORED `scope` and nullable `project_id`, not a `Scope`: a row
   * left behind by an older image can still carry the retired pair, and the
   * same-scope guard has to see it rather than read it as a project row.
   */
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

  /**
   * Bounded `replaces` ancestry of `startIds`, breadth-first, ids only, in one
   * statement. Replaces two hand-rolled walks that each issued one PK probe per
   * hop on the single synchronous connection every other caller queues behind.
   *
   * Walks `memory.replaces` via `json_each`, NOT the `memory_replaces` edge
   * table. Verified rather than assumed, because the edge table is the intuitive
   * choice and is the wrong one here: its primary key is
   * `(predecessor_id, successor_id)` and it is `WITHOUT ROWID`, so `sqlite_master`
   * holds no index object for it at all. The ancestor direction keys on
   * `successor_id`, so SQLite builds a transient index per query — linear in the
   * whole edge table. This form seeks the `memory` PK autoindex and is flat in
   * both chain length and corpus size. `memory_replaces` keeps the forward hop
   * (`findSuccessorId`), which is what it was built for.
   *
   * `UNION`, not `UNION ALL`: dedup is on the id, so a shared grandparent in a
   * diamond is visited once. The `LIMIT` stays inside SQL — bounding in JS after
   * the fact restores the O(chain) cost the bound exists to avoid.
   *
   * `unsafe*` because it is deliberately unscoped, and the prefix is the whole
   * warning: nothing here filters by scope. It is safe only because `replaces`
   * links never cross a scope, so an ancestor of an in-scope row is in scope by
   * construction. The callers scope the START row, not the results.
   */
  unsafeAncestorIds(opts: { startIds: readonly string[]; limit: number }): string[] {
    if (opts.startIds.length === 0 || opts.limit <= 0) return [];
    // Clamped, because the bound is the ONLY thing keeping this flat: measured on a
    // 5000-deep chain, `limit: 10` is 0.042 ms/call and an unbounded limit is
    // 6.08 ms/call returning every row. Both call sites pass small constants, but an
    // `unsafe*` method is callable from any service and must not depend on that.
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

  /**
   * The four fields `memory.get` publishes for a predecessor. Through the builder
   * rather than raw SQL so `createdAt` stays drizzle-mapped instead of
   * hand-hydrated from an integer.
   *
   * No `ORDER BY`: the caller re-orders to the traversal's order, which is the
   * contract, and a SQL sort here would silently become a second one.
   */
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
    // Per-type inactivity window: a row decays once last_seen_at predates
    // (now - threshold(type)). Mirrors the CASE ladder in `runNeedsReview`.
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

  /**
   * Latest `event_ts` per memory id for BOTH verdicts in one pass — callers
   * always need the pair (`deriveReviewState` takes both), so splitting this
   * would double the query count on every review-state read.
   */
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

  /**
   * Active in-scope memories past their review shelf life, recently-refuted
   * first and then oldest affirmation baseline first. The per-type TTL ladder
   * is built from `ttlByType` and the refutation lead from `refutedPriorityMs`
   * (both passed by the service so the constants live in exactly one place); a
   * type absent from `ttlByType` has no TTL and is excluded. Read-only.
   */
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

  /**
   * Unscoped sibling of `findNeedsReview` for the operator dashboard. Optional
   * project filter mirrors `adminList`; `undefined` spans all scopes. Paginates
   * with limit/offset so the dashboard `review=needs_review` filter is correct.
   */
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

  /**
   * A refutation newer than the affirmation baseline (and, when `sinceMs` is
   * given, newer than that cutoff too). Mirrors `deriveReviewState`: such a
   * refutation forces needs_review regardless of TTL, so a `reference` still
   * surfaces.
   */
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
    // Refuted rows lead: refutation deliberately does not advance the baseline,
    // so ordering by it alone sorts a freshly-refuted memory LAST and a capped
    // page (memory.context takes 3) never shows the agent back the memory it
    // just called wrong. The lead is time-bounded — an unattended refutation
    // would otherwise hold the head of the queue forever and starve every
    // TTL-expired row.
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
