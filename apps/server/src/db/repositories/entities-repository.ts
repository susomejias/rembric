import { and, eq, getTableColumns, isNull, or, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { Db } from '../client.js';
import {
  type EntityKind,
  type NewMemoryEntity,
  memoryEntities,
  memoryEntityLinks,
  memoryEntityScan,
} from '../schema/entities.js';
import { memory, type Memory, type MemoryScope } from '../schema/memory.js';

export interface EntityRef {
  kind: EntityKind;
  value: string;
}

export interface PendingEntityScan {
  id: string;
  scope: MemoryScope;
  projectId: string | null;
  title: string;
  content: string;
}

export interface MemoryEntityView {
  kind: EntityKind;
  value: string;
}

function entityScopeCondition(scope: MemoryScope, projectId: string | null) {
  return and(
    eq(memoryEntities.scope, scope),
    projectId === null ? isNull(memoryEntities.projectId) : eq(memoryEntities.projectId, projectId),
  );
}

export class EntitiesRepository {
  constructor(private readonly db: Db) {}

  /**
   * Get-or-create each entity by its (scope, project, kind, value) identity,
   * link them all to `memoryId`, and record the scan. Idempotent — safe to
   * call twice for the same memory. `ulid()` generation lives here rather
   * than in the caller because get-or-create is fundamentally a single
   * repository-internal transaction: the caller never needs to know which
   * ids were reused versus newly minted. One SELECT (existing entities) plus
   * one batched INSERT (new entities) plus one batched INSERT (links) —
   * O(1) round trips regardless of how many entities a memory has, matching
   * `findEntitiesForMemories`'s "no N+1" bar.
   */
  linkMemory(
    memoryId: string,
    scope: MemoryScope,
    projectId: string | null,
    entities: EntityRef[],
    scannedAt: Date,
  ): void {
    if (entities.length > 0) {
      const existing = this.db
        .select({ id: memoryEntities.id, kind: memoryEntities.kind, value: memoryEntities.value })
        .from(memoryEntities)
        .where(
          and(
            entityScopeCondition(scope, projectId),
            or(
              ...entities.map((e) =>
                and(eq(memoryEntities.kind, e.kind), eq(memoryEntities.value, e.value)),
              ),
            ),
          ),
        )
        .all();
      const idByKey = new Map(existing.map((r) => [`${r.kind}:${r.value}`, r.id]));

      const toInsert: NewMemoryEntity[] = [];
      const entityIds: string[] = [];
      for (const e of entities) {
        const key = `${e.kind}:${e.value}`;
        let id = idByKey.get(key);
        if (!id) {
          id = ulid();
          idByKey.set(key, id);
          toInsert.push({
            id,
            scope,
            projectId,
            kind: e.kind,
            value: e.value,
            createdAt: scannedAt,
          });
        }
        entityIds.push(id);
      }
      if (toInsert.length > 0) this.db.insert(memoryEntities).values(toInsert).run();
      this.db
        .insert(memoryEntityLinks)
        .values(entityIds.map((entityId) => ({ entityId, memoryId })))
        .onConflictDoNothing()
        .run();
    }
    this.db.insert(memoryEntityScan).values({ memoryId, scannedAt }).onConflictDoNothing().run();
  }

  /**
   * Exact-address retrieval: every memory linked to this (scope, kind,
   * value), chronological, no ranking. `kind` narrows further when the
   * caller knows it; omitted, it matches the value across all kinds (rare
   * in practice since values don't collide across kinds by construction).
   */
  findMemoriesByEntity(opts: {
    scope: MemoryScope;
    projectId: string | null;
    kind?: EntityKind;
    value: string;
    includeArchived: boolean;
    limit: number;
  }): Memory[] {
    const conditions = [
      entityScopeCondition(opts.scope, opts.projectId),
      eq(memoryEntities.value, opts.value),
    ];
    if (opts.kind) conditions.push(eq(memoryEntities.kind, opts.kind));
    if (!opts.includeArchived) conditions.push(sql`${memory.status} != 'archived'`);

    return this.db
      .select(getTableColumns(memory))
      .from(memoryEntityLinks)
      .innerJoin(memoryEntities, eq(memoryEntityLinks.entityId, memoryEntities.id))
      .innerJoin(memory, eq(memoryEntityLinks.memoryId, memory.id))
      .where(and(...conditions))
      .orderBy(sql`${memory.createdAt} desc`)
      .limit(opts.limit)
      .all();
  }

  /** The `entities[]` projection for a single memory's read/search result. */
  findEntitiesForMemory(memoryId: string): MemoryEntityView[] {
    return this.db
      .select({ kind: memoryEntities.kind, value: memoryEntities.value })
      .from(memoryEntityLinks)
      .innerJoin(memoryEntities, eq(memoryEntityLinks.entityId, memoryEntities.id))
      .where(eq(memoryEntityLinks.memoryId, memoryId))
      .all();
  }

  /** Batched form of `findEntitiesForMemory` — one JOIN, no N+1, for a search result page. */
  findEntitiesForMemories(memoryIds: string[]): Map<string, MemoryEntityView[]> {
    const out = new Map<string, MemoryEntityView[]>();
    if (memoryIds.length === 0) return out;
    const rows = this.db
      .select({
        memoryId: memoryEntityLinks.memoryId,
        kind: memoryEntities.kind,
        value: memoryEntities.value,
      })
      .from(memoryEntityLinks)
      .innerJoin(memoryEntities, eq(memoryEntityLinks.entityId, memoryEntities.id))
      .where(sql`${memoryEntityLinks.memoryId} IN ${memoryIds}`)
      .all();
    for (const r of rows) {
      const list = out.get(r.memoryId) ?? [];
      list.push({ kind: r.kind, value: r.value });
      out.set(r.memoryId, list);
    }
    return out;
  }

  /**
   * The scope's total active-memory count — the denominator the save-time
   * candidate channel's rarity gate needs (a proportion, not an absolute
   * count; see `save-time-candidates.ts`). Split out from the per-entity
   * link count below so a save with several extracted entities computes
   * this once, not once per entity — it depends only on `(scope, projectId)`.
   * `excludeMemoryId` lets a caller exclude the memory it just saved even if
   * linking has already run, rather than relying solely on call order.
   */
  scopeActiveMemoryCount(opts: {
    scope: MemoryScope;
    projectId: string | null;
    excludeMemoryId?: string;
  }): number {
    const conditions = [
      eq(memory.scope, opts.scope),
      opts.projectId === null ? isNull(memory.projectId) : eq(memory.projectId, opts.projectId),
      sql`${memory.status} != 'archived'`,
    ];
    if (opts.excludeMemoryId) conditions.push(sql`${memory.id} != ${opts.excludeMemoryId}`);
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(memory)
        .where(and(...conditions))
        .get()?.n ?? 0
    );
  }

  /** Current active-memory link count for one entity — the numerator of the rarity gate. */
  entityLinkCount(opts: {
    scope: MemoryScope;
    projectId: string | null;
    kind: EntityKind;
    value: string;
    excludeMemoryId?: string;
  }): number {
    const conditions = [
      entityScopeCondition(opts.scope, opts.projectId),
      eq(memoryEntities.kind, opts.kind),
      eq(memoryEntities.value, opts.value),
      sql`${memory.status} != 'archived'`,
    ];
    if (opts.excludeMemoryId) conditions.push(sql`${memory.id} != ${opts.excludeMemoryId}`);
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(memoryEntityLinks)
        .innerJoin(memoryEntities, eq(memoryEntityLinks.entityId, memoryEntities.id))
        .innerJoin(memory, eq(memoryEntityLinks.memoryId, memory.id))
        .where(and(...conditions))
        .get()?.n ?? 0
    );
  }

  /**
   * Other active memories sharing this entity — the candidate source for
   * the entity-overlap save-time channel. Excludes `excludeMemoryId`
   * (the memory just saved) and anything in `excludeIds`.
   */
  findOtherMemoriesForEntity(opts: {
    scope: MemoryScope;
    projectId: string | null;
    kind: EntityKind;
    value: string;
    excludeMemoryId: string;
    excludeIds: string[];
    limit: number;
  }): Memory[] {
    const conditions = [
      entityScopeCondition(opts.scope, opts.projectId),
      eq(memoryEntities.kind, opts.kind),
      eq(memoryEntities.value, opts.value),
      sql`${memory.status} != 'archived'`,
      sql`${memory.id} != ${opts.excludeMemoryId}`,
    ];
    if (opts.excludeIds.length > 0) {
      conditions.push(sql`${memory.id} NOT IN ${opts.excludeIds}`);
    }
    return this.db
      .select(getTableColumns(memory))
      .from(memoryEntityLinks)
      .innerJoin(memoryEntities, eq(memoryEntityLinks.entityId, memoryEntities.id))
      .innerJoin(memory, eq(memoryEntityLinks.memoryId, memory.id))
      .where(and(...conditions))
      .orderBy(sql`${memory.createdAt} desc`)
      .limit(opts.limit)
      .all();
  }

  /** Resumable backfill: non-archived memories never scanned for entities. */
  findMissingScans(limit: number): PendingEntityScan[] {
    return this.db
      .select({
        id: memory.id,
        scope: memory.scope,
        projectId: memory.projectId,
        title: memory.title,
        content: memory.content,
      })
      .from(memory)
      .leftJoin(memoryEntityScan, eq(memoryEntityScan.memoryId, memory.id))
      .where(and(sql`${memory.status} != 'archived'`, isNull(memoryEntityScan.memoryId)))
      .orderBy(memory.createdAt)
      .limit(limit)
      .all();
  }

  /**
   * Unscoped — `admin`-prefixed so the data-access confinement grep gate
   * confines it to the dashboard and doctor, never a per-request MCP tool.
   */
  adminBacklogCount(): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(memory)
        .leftJoin(memoryEntityScan, eq(memoryEntityScan.memoryId, memory.id))
        .where(and(sql`${memory.status} != 'archived'`, isNull(memoryEntityScan.memoryId)))
        .get()?.n ?? 0
    );
  }

  adminCountsByKind(): { kind: EntityKind; count: number }[] {
    return this.db
      .select({ kind: memoryEntities.kind, count: sql<number>`count(*)` })
      .from(memoryEntities)
      .groupBy(memoryEntities.kind)
      .all();
  }

  adminTopEntities(
    limit: number,
  ): { id: string; kind: EntityKind; value: string; linkCount: number }[] {
    return this.db
      .select({
        id: memoryEntities.id,
        kind: memoryEntities.kind,
        value: memoryEntities.value,
        linkCount: sql<number>`count(${memoryEntityLinks.memoryId})`,
      })
      .from(memoryEntities)
      .leftJoin(memoryEntityLinks, eq(memoryEntityLinks.entityId, memoryEntities.id))
      .groupBy(memoryEntities.id)
      .orderBy(sql`count(${memoryEntityLinks.memoryId}) desc`)
      .limit(limit)
      .all();
  }

  /**
   * The dashboard entities view's row source. `singleReferenceOnly` is the
   * thinly-documented-area proxy: an entity mentioned by exactly one memory
   * is the closest signal to "which files have accumulated no real
   * knowledge yet" the server can compute without filesystem access.
   */
  adminListEntities(
    filters: { kind?: EntityKind; singleReferenceOnly?: boolean },
    limit: number,
    offset: number,
  ): {
    id: string;
    kind: EntityKind;
    value: string;
    projectId: string | null;
    linkCount: number;
  }[] {
    const conditions = filters.kind ? [eq(memoryEntities.kind, filters.kind)] : [];
    return this.db
      .select({
        id: memoryEntities.id,
        kind: memoryEntities.kind,
        value: memoryEntities.value,
        projectId: memoryEntities.projectId,
        linkCount: sql<number>`count(${memoryEntityLinks.memoryId})`,
      })
      .from(memoryEntities)
      .leftJoin(memoryEntityLinks, eq(memoryEntityLinks.entityId, memoryEntities.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(memoryEntities.id)
      .having(
        filters.singleReferenceOnly ? sql`count(${memoryEntityLinks.memoryId}) = 1` : undefined,
      )
      .orderBy(sql`count(${memoryEntityLinks.memoryId}) desc`, memoryEntities.value)
      .limit(limit)
      .offset(offset)
      .all();
  }

  adminCountEntities(filters: { kind?: EntityKind; singleReferenceOnly?: boolean }): number {
    const conditions = filters.kind ? [eq(memoryEntities.kind, filters.kind)] : [];
    const grouped = this.db
      .select({ id: memoryEntities.id })
      .from(memoryEntities)
      .leftJoin(memoryEntityLinks, eq(memoryEntityLinks.entityId, memoryEntities.id))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .groupBy(memoryEntities.id)
      .having(
        filters.singleReferenceOnly ? sql`count(${memoryEntityLinks.memoryId}) = 1` : undefined,
      )
      .as('grouped');
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(grouped)
        .get()?.n ?? 0
    );
  }

  /** Truncate-and-rebuild support: wipe all three derived tables. */
  truncateAll(): void {
    this.db.delete(memoryEntityLinks).run();
    this.db.delete(memoryEntityScan).run();
    this.db.delete(memoryEntities).run();
  }
}
