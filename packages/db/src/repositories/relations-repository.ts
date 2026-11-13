import {
  aliasedTable,
  and,
  count,
  desc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lt,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Db } from '../client.js';
import {
  memoryRelations,
  type MarkedByKind,
  type MemoryRelation,
  type NewMemoryRelation,
  type RelationKind,
  type RelationStatus,
} from '../schema/memory-relations.js';
import { memory, type Memory } from '../schema/memory.js';

export interface JudgedVerdict {
  relation: RelationKind;
  reason: string | null;
  evidence: unknown;
  confidence: number | null;
  markedByKind: MarkedByKind;
  markedByActor: string;
  judgedAt: Date;
}

export interface AdminRelationFilters {
  status?: RelationStatus;
  /** `'pending'` selects rows whose `relation` is still NULL. */
  kind?: RelationKind | 'pending';
  /** Corpus-wide keyword over both endpoints' title and content. */
  q?: string;
}

/** `%q%` with `%` and `_` escaped for a `LIKE … ESCAPE '\'` predicate. */
function likePattern(q: string): string {
  return `%${q.replace(/[%_]/g, (c) => `\\${c}`)}%`;
}

export type AdminRelationWithContent = Pick<
  MemoryRelation,
  | 'id'
  | 'judgmentId'
  | 'sourceId'
  | 'targetId'
  | 'relation'
  | 'status'
  | 'reason'
  | 'evidence'
  | 'confidence'
  | 'markedByKind'
  | 'markedByActor'
  | 'judgedAt'
  | 'createdAt'
> & {
  sourceTitle: Memory['title'];
  targetTitle: Memory['title'];
  sourceContent: Memory['content'];
  targetContent: Memory['content'];
};

export interface PendingOrderKey {
  createdAt: Date;
  judgmentId: string;
}

export type ExaminablePending = Pick<
  MemoryRelation,
  'judgmentId' | 'sourceId' | 'targetId' | 'createdAt'
>;

/** The indexed range then scans about `limit × all pending / probe rows` rows. */
const SMALL_RANGE_PROBE_MIN_ROWS = 16;

const sourceMemory = aliasedTable(memory, 'ms');
const targetMemory = aliasedTable(memory, 'mt');

/** Source AND target both lie in the project (aliased-join filter). */
function endpointsInScope(projectId: string): SQL {
  return and(
    eq(sourceMemory.scope, 'project'),
    eq(sourceMemory.projectId, projectId),
    eq(targetMemory.scope, 'project'),
    eq(targetMemory.projectId, projectId),
  ) as SQL;
}

/** Requires both aliases to be joined already. */
const endpointsActive = and(
  eq(sourceMemory.status, 'active'),
  eq(targetMemory.status, 'active'),
) as SQL;

const withContentSelection = {
  id: memoryRelations.id,
  judgmentId: memoryRelations.judgmentId,
  sourceId: memoryRelations.sourceId,
  targetId: memoryRelations.targetId,
  relation: memoryRelations.relation,
  status: memoryRelations.status,
  reason: memoryRelations.reason,
  evidence: memoryRelations.evidence,
  confidence: memoryRelations.confidence,
  markedByKind: memoryRelations.markedByKind,
  markedByActor: memoryRelations.markedByActor,
  judgedAt: memoryRelations.judgedAt,
  createdAt: memoryRelations.createdAt,
  sourceTitle: sourceMemory.title,
  targetTitle: targetMemory.title,
  sourceContent: sourceMemory.content,
  targetContent: targetMemory.content,
};

export class RelationsRepository {
  constructor(private readonly db: Db) {}

  insert(values: NewMemoryRelation): MemoryRelation | undefined {
    return this.db.insert(memoryRelations).values(values).returning().get();
  }

  findByJudgmentId(judgmentId: string): MemoryRelation | undefined {
    return this.db
      .select()
      .from(memoryRelations)
      .where(eq(memoryRelations.judgmentId, judgmentId))
      .get();
  }

  /** Relation row by `judgmentId` whose source AND target both lie in the scope. */
  findByJudgmentIdInScope(
    judgmentId: string,
    scope: { projectId: string },
  ): MemoryRelation | undefined {
    const scopeFilter = endpointsInScope(scope.projectId);
    return this.db
      .select(getTableColumns(memoryRelations))
      .from(memoryRelations)
      .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
      .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
      .where(and(eq(memoryRelations.judgmentId, judgmentId), scopeFilter))
      .get();
  }

  /** Reset a judged/orphaned row back to pending (consolidation undo). */
  resetToPending(id: string): void {
    this.db
      .update(memoryRelations)
      .set({
        status: 'pending' as const,
        relation: null,
        reason: null,
        confidence: null,
        judgedAt: null,
        markedByKind: null,
        markedByActor: null,
      })
      .where(eq(memoryRelations.id, id))
      .run();
  }

  findBySourceAndTarget(sourceId: string, targetId: string): MemoryRelation | undefined {
    return this.db
      .select()
      .from(memoryRelations)
      .where(and(eq(memoryRelations.sourceId, sourceId), eq(memoryRelations.targetId, targetId)))
      .get();
  }

  markJudged(
    id: string,
    verdict: JudgedVerdict,
    opts: { requirePending: boolean },
  ): MemoryRelation | undefined {
    return this.db
      .update(memoryRelations)
      .set({ ...verdict, status: 'judged' as const })
      .where(
        opts.requirePending
          ? and(eq(memoryRelations.id, id), eq(memoryRelations.status, 'pending'))
          : eq(memoryRelations.id, id),
      )
      .returning()
      .get();
  }

  markJudgedFromOrphaned(id: string, verdict: JudgedVerdict): MemoryRelation | undefined {
    return this.db
      .update(memoryRelations)
      .set({ ...verdict, status: 'judged' as const })
      .where(and(eq(memoryRelations.id, id), eq(memoryRelations.status, 'orphaned')))
      .returning()
      .get();
  }

  markOrphanedPending(
    judgmentId: string,
    set: { reason?: string; markedByKind: MarkedByKind; judgedAt: Date },
  ): MemoryRelation | undefined {
    return this.db
      .update(memoryRelations)
      .set({ ...set, status: 'orphaned' as const })
      .where(and(eq(memoryRelations.judgmentId, judgmentId), eq(memoryRelations.status, 'pending')))
      .returning()
      .get();
  }

  listTouching(memoryId: string): MemoryRelation[] {
    return this.db
      .select()
      .from(memoryRelations)
      .where(
        and(
          or(eq(memoryRelations.sourceId, memoryId), eq(memoryRelations.targetId, memoryId)),
          or(isNull(memoryRelations.relation), ne(memoryRelations.relation, 'not_conflict')),
        ),
      )
      .all();
  }

  /** Bulk variant of `listTouching`, additionally hiding orphaned rows. */
  listTouchingAny(memoryIds: readonly string[]): MemoryRelation[] {
    if (memoryIds.length === 0) return [];
    const ids = [...memoryIds];
    return this.db
      .select()
      .from(memoryRelations)
      .where(
        and(
          or(inArray(memoryRelations.sourceId, ids), inArray(memoryRelations.targetId, ids)),
          or(isNull(memoryRelations.relation), ne(memoryRelations.relation, 'not_conflict')),
          ne(memoryRelations.status, 'orphaned'),
        ),
      )
      .all();
  }

  listPendingTouchingAny(
    memoryIds: readonly string[],
  ): Pick<MemoryRelation, 'judgmentId' | 'sourceId' | 'targetId'>[] {
    if (memoryIds.length === 0) return [];
    const ids = [...memoryIds];
    return this.db
      .select({
        judgmentId: memoryRelations.judgmentId,
        sourceId: memoryRelations.sourceId,
        targetId: memoryRelations.targetId,
      })
      .from(memoryRelations)
      .where(
        and(
          eq(memoryRelations.status, 'pending'),
          or(inArray(memoryRelations.sourceId, ids), inArray(memoryRelations.targetId, ids)),
        ),
      )
      .orderBy(memoryRelations.createdAt, memoryRelations.judgmentId)
      .all();
  }

  listNotConflictTargetsForSources(sourceIds: readonly string[]): string[] {
    if (sourceIds.length === 0) return [];
    return this.db
      .selectDistinct({ targetId: memoryRelations.targetId })
      .from(memoryRelations)
      .where(
        and(
          eq(memoryRelations.status, 'judged'),
          eq(memoryRelations.relation, 'not_conflict'),
          inArray(memoryRelations.sourceId, [...sourceIds]),
        ),
      )
      .all()
      .map((r) => r.targetId);
  }

  listPendingInProject(
    projectId: string,
    limit?: number,
  ): Pick<MemoryRelation, 'judgmentId' | 'sourceId' | 'targetId'>[] {
    const query = this.db
      .select({
        judgmentId: memoryRelations.judgmentId,
        sourceId: memoryRelations.sourceId,
        targetId: memoryRelations.targetId,
      })
      .from(memoryRelations)
      .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
      .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
      .where(and(eq(memoryRelations.status, 'pending'), endpointsInScope(projectId)))
      .orderBy(memoryRelations.createdAt, memoryRelations.judgmentId)
      .$dynamic();
    return limit === undefined ? query.all() : query.limit(limit).all();
  }

  findPendingOlderThanInScope(opts: {
    projectId: string;
    cutoffMs: number;
    limit: number;
    excludeJudgmentIds?: readonly string[];
  }): Pick<MemoryRelation, 'judgmentId' | 'sourceId' | 'targetId'>[] {
    const excluded = opts.excludeJudgmentIds ?? [];
    return this.db
      .select({
        judgmentId: memoryRelations.judgmentId,
        sourceId: memoryRelations.sourceId,
        targetId: memoryRelations.targetId,
      })
      .from(memoryRelations)
      .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
      .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
      .where(
        and(
          eq(memoryRelations.status, 'pending'),
          lt(memoryRelations.createdAt, new Date(opts.cutoffMs)),
          endpointsInScope(opts.projectId),
          excluded.length > 0 ? notInArray(memoryRelations.judgmentId, [...excluded]) : undefined,
        ),
      )
      .orderBy(memoryRelations.createdAt)
      .limit(opts.limit)
      .all();
  }

  /**
   * `(created_at, judgment_id)` order; `until` is inclusive. A probe driven by the project's own
   * memories returns a project's whole range when it holds fewer than the probe's rows; otherwise
   * the range rides `memory_relations_status_created_idx`, which would scan every project's
   * pending rows for a project with few of its own.
   */
  listExaminablePendingInScope(opts: {
    projectId: string;
    after?: PendingOrderKey;
    until?: PendingOrderKey;
    excludeJudgmentIds: readonly string[];
    limit: number;
  }): ExaminablePending[] {
    const order = sql`(${memoryRelations.createdAt}, ${memoryRelations.judgmentId})`;
    const key = (k: PendingOrderKey): SQL => sql`(${k.createdAt.getTime()}, ${k.judgmentId})`;
    const filter = and(
      eq(memoryRelations.status, 'pending'),
      opts.after ? sql`${order} > ${key(opts.after)}` : undefined,
      opts.until ? sql`${order} <= ${key(opts.until)}` : undefined,
      opts.excludeJudgmentIds.length > 0
        ? sql`${memoryRelations.judgmentId} NOT IN (SELECT value FROM json_each(${JSON.stringify(opts.excludeJudgmentIds)}))`
        : undefined,
      endpointsInScope(opts.projectId),
    );
    const probeRows = Math.max(opts.limit, SMALL_RANGE_PROBE_MIN_ROWS);
    const probe = this.db.all<Omit<ExaminablePending, 'createdAt'> & { createdAt: number }>(sql`
      SELECT memory_relations.judgment_id AS judgmentId, memory_relations.source_id AS sourceId,
             memory_relations.target_id AS targetId, memory_relations.created_at AS createdAt
      FROM memory ms
        CROSS JOIN memory_relations ON memory_relations.source_id = ms.id
        JOIN memory mt ON mt.id = memory_relations.target_id
      WHERE ${filter}
      LIMIT ${probeRows}
    `);
    if (probe.length < probeRows) {
      return probe
        .map((r) => ({ ...r, createdAt: new Date(r.createdAt) }))
        .sort(
          (a, b) =>
            a.createdAt.getTime() - b.createdAt.getTime() ||
            (a.judgmentId < b.judgmentId ? -1 : a.judgmentId > b.judgmentId ? 1 : 0),
        )
        .slice(0, opts.limit);
    }
    return this.db
      .select({
        judgmentId: memoryRelations.judgmentId,
        sourceId: memoryRelations.sourceId,
        targetId: memoryRelations.targetId,
        createdAt: memoryRelations.createdAt,
      })
      .from(memoryRelations)
      .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
      .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
      .where(filter)
      .orderBy(memoryRelations.createdAt, memoryRelations.judgmentId)
      .limit(opts.limit)
      .all();
  }

  countRowsByStatus(): { status: RelationStatus; count: number }[] {
    return this.db
      .select({ status: memoryRelations.status, count: count() })
      .from(memoryRelations)
      .groupBy(memoryRelations.status)
      .all();
  }

  private adminFilterConditions(filters: AdminRelationFilters): SQL[] {
    const conditions: SQL[] = [];
    if (filters.status) conditions.push(eq(memoryRelations.status, filters.status));
    if (filters.kind === 'pending') {
      conditions.push(isNull(memoryRelations.relation));
    } else if (filters.kind) {
      conditions.push(eq(memoryRelations.relation, filters.kind));
    }
    if (filters.q) {
      const pattern = likePattern(filters.q);
      conditions.push(
        or(
          sql`${sourceMemory.title} LIKE ${pattern} ESCAPE '\\'`,
          sql`${sourceMemory.content} LIKE ${pattern} ESCAPE '\\'`,
          sql`${targetMemory.title} LIKE ${pattern} ESCAPE '\\'`,
          sql`${targetMemory.content} LIKE ${pattern} ESCAPE '\\'`,
        ) as SQL,
      );
    }
    return conditions;
  }

  adminListWithContent(
    filters: AdminRelationFilters,
    limit: number,
    offset: number,
  ): AdminRelationWithContent[] {
    const conditions = this.adminFilterConditions(filters);
    const query = this.db
      .select(withContentSelection)
      .from(memoryRelations)
      .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
      .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
      .orderBy(desc(memoryRelations.createdAt))
      .limit(limit)
      .offset(offset)
      .$dynamic();
    return conditions.length > 0 ? query.where(and(...conditions)).all() : query.all();
  }

  adminCountWithFilters(filters: AdminRelationFilters): number {
    const conditions = this.adminFilterConditions(filters);
    if (filters.q) {
      const row = this.db
        .select({ value: count() })
        .from(memoryRelations)
        .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
        .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
        .where(and(...conditions))
        .get();
      return row?.value ?? 0;
    }
    // No joins: both endpoints are NOT NULL FKs onto a PK, so neither can change a count.
    const query = this.db.select({ value: count() }).from(memoryRelations).$dynamic();
    const row = conditions.length > 0 ? query.where(and(...conditions)).get() : query.get();
    return row?.value ?? 0;
  }

  adminListTouching(memoryId: string): AdminRelationWithContent[] {
    return this.db
      .select(withContentSelection)
      .from(memoryRelations)
      .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
      .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
      .where(
        and(
          or(eq(memoryRelations.sourceId, memoryId), eq(memoryRelations.targetId, memoryId)),
          or(isNull(memoryRelations.relation), ne(memoryRelations.relation, 'not_conflict')),
        ),
      )
      .all();
  }

  adminGetWithContent(id: string): AdminRelationWithContent | undefined {
    return this.db
      .select(withContentSelection)
      .from(memoryRelations)
      .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
      .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
      .where(eq(memoryRelations.id, id))
      .get();
  }

  listPendingInScope(opts: {
    projectId: string;
    cutoffMs: number | null;
    limit: number;
  }): AdminRelationWithContent[] {
    return this.db
      .select(withContentSelection)
      .from(memoryRelations)
      .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
      .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
      .where(
        and(
          eq(memoryRelations.status, 'pending'),
          opts.cutoffMs === null
            ? undefined
            : lt(memoryRelations.createdAt, new Date(opts.cutoffMs)),
          endpointsInScope(opts.projectId),
          endpointsActive,
        ),
      )
      .orderBy(memoryRelations.createdAt)
      .limit(opts.limit)
      .all();
  }

  /** Scoped total pending-judgment count. */
  countPendingInScope(opts: { projectId: string }): number {
    const row = this.db
      .select({ value: count() })
      .from(memoryRelations)
      .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
      .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
      .where(
        and(
          eq(memoryRelations.status, 'pending'),
          endpointsInScope(opts.projectId),
          endpointsActive,
        ),
      )
      .get();
    return row?.value ?? 0;
  }

  adminRecentJudged(limit: number): AdminRelationWithContent[] {
    return this.db
      .select(withContentSelection)
      .from(memoryRelations)
      .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
      .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
      .where(eq(memoryRelations.status, 'judged'))
      .orderBy(desc(memoryRelations.judgedAt))
      .limit(limit)
      .all();
  }

  adminPendingAdjudicableByProject(): Array<{ projectId: string | null; count: number }> {
    return this.db
      .select({ projectId: sourceMemory.projectId, count: count() })
      .from(memoryRelations)
      .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
      .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
      .where(and(eq(memoryRelations.status, 'pending'), endpointsActive))
      .groupBy(sourceMemory.projectId)
      .all();
  }

  adminCountByStatus(status: RelationStatus): number {
    const row = this.db
      .select({ value: count() })
      .from(memoryRelations)
      .where(eq(memoryRelations.status, status))
      .get();
    return row?.value ?? 0;
  }
}
