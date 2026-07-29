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
import {
  memory,
  type Memory,
  type MemoryScope,
  type MemoryStatus,
  type MemoryType,
} from '../schema/memory.js';

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

/**
 * `includeGlobal` widens a `project` scope to also match `global` entities
 * without ever admitting another `project_id` — the entity-side sibling of
 * `scopeWhere`'s flag. No-op for `global` scope.
 */
function entityScopeCondition(
  scope: MemoryScope,
  projectId: string | null,
  includeGlobal?: boolean,
) {
  const own = and(
    eq(memoryEntities.scope, scope),
    projectId === null ? isNull(memoryEntities.projectId) : eq(memoryEntities.projectId, projectId),
  );
  if (scope !== 'project' || !includeGlobal) return own;
  return or(own, and(eq(memoryEntities.scope, 'global'), isNull(memoryEntities.projectId)));
}

/** Entities per get-or-create lookup; SQLITE_MAX_EXPR_DEPTH is 1000. */
const LOOKUP_CHUNK = 200;

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
      const idByKey = new Map<string, string>();
      for (let i = 0; i < entities.length; i += LOOKUP_CHUNK) {
        const chunk = entities.slice(i, i + LOOKUP_CHUNK);
        const existing = this.db
          .select({ id: memoryEntities.id, kind: memoryEntities.kind, value: memoryEntities.value })
          .from(memoryEntities)
          .where(
            and(
              entityScopeCondition(scope, projectId),
              or(
                ...chunk.map((e) =>
                  and(eq(memoryEntities.kind, e.kind), eq(memoryEntities.value, e.value)),
                ),
              ),
            ),
          )
          .all();
        for (const r of existing) idByKey.set(`${r.kind}:${r.value}`, r.id);
      }

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
    this.markScanned(memoryId, scannedAt);
  }

  /** Records scan coverage without linking — used to retire a row whose extraction threw. */
  markScanned(memoryId: string, scannedAt: Date): void {
    this.db.insert(memoryEntityScan).values({ memoryId, scannedAt }).onConflictDoNothing().run();
  }

  /**
   * Exact-address retrieval: every memory linked to this (scope, kind,
   * value), chronological, no ranking. `kind` narrows further when the
   * caller knows it; omitted, it matches the value across all kinds (rare
   * in practice since values don't collide across kinds by construction).
   *
   * The `status`/`type`/`tag`/`topicKey` filters are the same predicates the
   * ranked branches apply, so `memory.search`'s documented filters mean the
   * same thing on both paths. An omitted `status` means "any but archived",
   * not "active" — the entity path is specified as complete within scope.
   */
  findMemoriesByEntity(opts: {
    scope: MemoryScope;
    projectId: string | null;
    kind?: EntityKind;
    value: string;
    status?: MemoryStatus;
    type?: MemoryType;
    tag?: string;
    topicKey?: string;
    includeGlobal?: boolean;
    limit: number;
  }): Memory[] {
    const conditions = [
      entityScopeCondition(opts.scope, opts.projectId, opts.includeGlobal),
      eq(memoryEntities.value, opts.value),
    ];
    if (opts.kind) conditions.push(eq(memoryEntities.kind, opts.kind));
    conditions.push(
      opts.status ? eq(memory.status, opts.status) : sql`${memory.status} != 'archived'`,
    );
    if (opts.type) conditions.push(eq(memory.type, opts.type));
    if (opts.tag) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM json_each(${memory.tags}) je WHERE je.value = ${opts.tag})`,
      );
    }
    if (opts.topicKey) conditions.push(eq(memory.topicKey, opts.topicKey));

    return (
      this.db
        .select(getTableColumns(memory))
        .from(memoryEntityLinks)
        .innerJoin(memoryEntities, eq(memoryEntityLinks.entityId, memoryEntities.id))
        .innerJoin(memory, eq(memoryEntityLinks.memoryId, memory.id))
        .where(and(...conditions))
        // `created_at` is millisecond-resolution, so a batch save ties. Without a
        // tiebreaker SQLite is free to return tied rows in any order, and the
        // caller pages this result by slicing — so page 2 could repeat or skip a
        // row page 1 already showed. `id` is a ULID: same-millisecond rows sort
        // by their monotonic suffix, which makes the total order deterministic
        // AND still chronological.
        .orderBy(sql`${memory.createdAt} desc`, sql`${memory.id} desc`)
        .limit(opts.limit)
        .all()
    );
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
      eq(memory.status, 'active'),
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

  /**
   * Resumable backfill: memories never scanned for entities, whatever their
   * status. Archived rows are indexed deliberately — excluding them made
   * `memory.search({entity, status:'archived'})` structurally always empty
   * while the filter advertised otherwise, and made every recipe bump drop
   * archived links permanently, since a row archived before the bump would
   * never be re-scanned. Extraction is pure and synchronous, so the only cost
   * is a longer first drain on a corpus with many archived rows.
   */
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
      .where(isNull(memoryEntityScan.memoryId))
      .orderBy(memory.createdAt)
      .limit(limit)
      .all();
  }

  /**
   * Unscoped — `admin`-prefixed so the data-access confinement grep gate
   * confines it to the dashboard and doctor, never a per-request MCP tool.
   * Must filter exactly as `findMissingScans` does, or the operator watches a
   * backlog that never reaches zero.
   */
  adminBacklogCount(): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(memory)
        .leftJoin(memoryEntityScan, eq(memoryEntityScan.memoryId, memory.id))
        .where(isNull(memoryEntityScan.memoryId))
        .get()?.n ?? 0
    );
  }

  /**
   * In-scope memories still awaiting their first entity scan. Distinguishes
   * "this entity is not in the index" from "the index has not caught up",
   * which an empty entity lookup cannot do on its own. Scoped, so it is safe
   * on an agent-facing read; `includeGlobal` widens exactly as the lookup does.
   */
  countPendingScans(opts: {
    scope: MemoryScope;
    projectId: string | null;
    includeGlobal?: boolean;
  }): number {
    const own = and(
      eq(memory.scope, opts.scope),
      opts.projectId === null ? isNull(memory.projectId) : eq(memory.projectId, opts.projectId),
    );
    const scoped =
      opts.scope === 'project' && opts.includeGlobal
        ? or(own, and(eq(memory.scope, 'global'), isNull(memory.projectId)))
        : own;
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(memory)
        .leftJoin(memoryEntityScan, eq(memoryEntityScan.memoryId, memory.id))
        .where(and(scoped, isNull(memoryEntityScan.memoryId)))
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

  /**
   * Truncate-and-rebuild support: wipe all three derived tables. Callers MUST
   * wrap this in a transaction (`resetEntityIndex` is the one that does) —
   * three statements are three failure points, and the marker is already on
   * disk by the time this runs. The scan table goes FIRST so that the only
   * partial state a failure can leave is "bookkeeping cleared, links intact":
   * the drain then re-scans everything and `linkMemory`'s `onConflictDoNothing`
   * makes the relinking idempotent. The reverse order leaves scan rows without
   * links, which reads as a drained backlog over a permanently empty index.
   */
  truncateAll(): void {
    this.db.delete(memoryEntityScan).run();
    this.db.delete(memoryEntityLinks).run();
    this.db.delete(memoryEntities).run();
  }
}
