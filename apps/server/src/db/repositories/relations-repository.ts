import { aliasedTable, and, count, desc, eq, isNull, type SQL } from 'drizzle-orm';

import type { Db } from '../client.js';
import {
  memoryRelations,
  type MemoryRelation,
  type RelationKind,
  type RelationStatus,
} from '../schema/memory-relations.js';
import { memory, type Memory } from '../schema/memory.js';

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
  sourceContent: sourceMemory.content,
  targetContent: targetMemory.content,
};

export class RelationsRepository {
  constructor(private readonly db: Db) {}

  // ── admin* — unscoped dashboard reads ──────────────────────────────

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

  adminGetWithContent(id: string): AdminRelationWithContent | undefined {
    return this.db
      .select(withContentSelection)
      .from(memoryRelations)
      .innerJoin(sourceMemory, eq(sourceMemory.id, memoryRelations.sourceId))
      .innerJoin(targetMemory, eq(targetMemory.id, memoryRelations.targetId))
      .where(eq(memoryRelations.id, id))
      .get();
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
