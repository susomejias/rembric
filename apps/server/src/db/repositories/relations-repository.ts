import {
  aliasedTable,
  and,
  count,
  desc,
  eq,
  inArray,
  isNull,
  lt,
  ne,
  or,
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
import { memory, type Memory, type MemoryScope } from '../schema/memory.js';

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

const sourceMemory = aliasedTable(memory, 'ms');
const targetMemory = aliasedTable(memory, 'mt');

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

  /**
   * Rows touching `memoryId` as source or target, excluding acknowledged
   * false positives (`not_conflict`).
   */
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

  /**
   * Distinct target ids that any of `sourceIds` has already judged
   * `not_conflict`. Save-time candidate detection uses this (keyed on the new
   * memory's `replaces` ancestry) to stop re-surfacing pairs the agent already
   * dismissed. Empty input → [].
   */
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

  findPendingOlderThan(cutoff: Date, limit: number): MemoryRelation[] {
    return this.db
      .select()
      .from(memoryRelations)
      .where(and(eq(memoryRelations.status, 'pending'), lt(memoryRelations.createdAt, cutoff)))
      .orderBy(memoryRelations.createdAt)
      .limit(limit)
      .all();
  }

  countRowsByStatus(): { status: RelationStatus; count: number }[] {
    return this.db
      .select({ status: memoryRelations.status, count: count() })
      .from(memoryRelations)
      .groupBy(memoryRelations.status)
      .all();
  }

  adminListWithContent(
    filters: AdminRelationFilters,
    limit: number,
    offset: number,
  ): AdminRelationWithContent[] {
    const conditions: SQL[] = [];
    if (filters.status) conditions.push(eq(memoryRelations.status, filters.status));
    if (filters.kind === 'pending') {
      conditions.push(isNull(memoryRelations.relation));
    } else if (filters.kind) {
      conditions.push(eq(memoryRelations.relation, filters.kind));
    }

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
    const conditions: SQL[] = [];
    if (filters.status) conditions.push(eq(memoryRelations.status, filters.status));
    if (filters.kind === 'pending') {
      conditions.push(isNull(memoryRelations.relation));
    } else if (filters.kind) {
      conditions.push(eq(memoryRelations.relation, filters.kind));
    }
    const query = this.db
      .select({ value: count() })
      .from(memoryRelations)
      .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
      .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
      .$dynamic();
    const row = conditions.length > 0 ? query.where(and(...conditions)).get() : query.get();
    return row?.value ?? 0;
  }

  /**
   * `listTouching` with joined counterpart titles, for the memory detail
   * hub's Judgments section. Same touching/not_conflict predicate as
   * `listTouching` — no new SQL shape, just the admin content join.
   */
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
      .orderBy(desc(memoryRelations.createdAt))
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

  /**
   * Aged pending relations whose source AND target both lie in `scope`,
   * with joined content — feeds memory.context.pendingJudgments[].
   */
  listPendingOlderThanInScope(opts: {
    scope: MemoryScope;
    projectId: string | null;
    cutoffMs: number;
    limit: number;
  }): AdminRelationWithContent[] {
    const scopeFilter =
      opts.scope === 'project'
        ? and(
            eq(sourceMemory.scope, 'project'),
            eq(sourceMemory.projectId, opts.projectId ?? ''),
            eq(targetMemory.scope, 'project'),
            eq(targetMemory.projectId, opts.projectId ?? ''),
          )
        : and(
            eq(sourceMemory.scope, 'global'),
            isNull(sourceMemory.projectId),
            eq(targetMemory.scope, 'global'),
            isNull(targetMemory.projectId),
          );
    return this.db
      .select(withContentSelection)
      .from(memoryRelations)
      .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
      .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
      .where(
        and(
          eq(memoryRelations.status, 'pending'),
          lt(memoryRelations.createdAt, new Date(opts.cutoffMs)),
          scopeFilter,
        ),
      )
      .orderBy(memoryRelations.createdAt)
      .limit(opts.limit)
      .all();
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

  adminCountByStatus(status: RelationStatus): number {
    const row = this.db
      .select({ value: count() })
      .from(memoryRelations)
      .where(eq(memoryRelations.status, status))
      .get();
    return row?.value ?? 0;
  }
}
