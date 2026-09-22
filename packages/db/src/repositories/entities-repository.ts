import { and, eq, getTableColumns, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { ulid } from 'ulid';

import type { Db } from '../client.js';
import {
  type EntityKind,
  type NewMemoryEntity,
  memoryEntities,
  memoryEntityLinks,
  memoryEntityScan,
} from '../schema/entities.js';
import { memory, type Memory, type MemoryStatus, type MemoryType } from '../schema/memory.js';
import { projectScope, type SearchScope } from '../scope.js';

import { scopeCondition } from './scope-clause.js';

export interface EntityRef {
  kind: EntityKind;
  value: string;
}

export interface PendingEntityScan {
  id: string;
  projectId: string;
  title: string;
  content: string;
}

export interface MemoryEntityView {
  kind: EntityKind;
  value: string;
}

function entityScopeCondition(scope: SearchScope) {
  const projectIds = scope.kind === 'project' ? [scope.projectId] : scope.projectIds;
  if (projectIds.length === 0) throw new Error('scope addresses no project');
  return and(
    eq(memoryEntities.scope, 'project'),
    inArray(memoryEntities.projectId, [...projectIds]),
  );
}

/** Entities per get-or-create lookup; SQLITE_MAX_EXPR_DEPTH is 1000. */
const LOOKUP_CHUNK = 200;

export class EntitiesRepository {
  constructor(private readonly db: Db) {}

  linkMemory(memoryId: string, projectId: string, entities: EntityRef[], scannedAt: Date): void {
    if (entities.length > 0) {
      const idByKey = new Map<string, string>();
      for (let i = 0; i < entities.length; i += LOOKUP_CHUNK) {
        const chunk = entities.slice(i, i + LOOKUP_CHUNK);
        // Row value, not an OR chain: the OR form's plan is stats-dependent.
        const existing = this.db.all<{ id: string; kind: EntityKind; value: string }>(sql`
          SELECT id, kind, value
          FROM ${memoryEntities}
          WHERE ${entityScopeCondition(projectScope(projectId))}
            AND (kind, value) IN (VALUES ${sql.join(
              chunk.map((e) => sql`(${e.kind}, ${e.value})`),
              sql`, `,
            )})
        `);
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
            scope: 'project',
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

  findMemoriesByEntity(opts: {
    scope: SearchScope;
    kind?: EntityKind;
    value: string;
    status?: MemoryStatus;
    type?: MemoryType;
    types?: readonly MemoryType[];
    tag?: string;
    topicKey?: string;
    limit: number;
  }): Memory[] {
    const conditions = [entityScopeCondition(opts.scope), eq(memoryEntities.value, opts.value)];
    if (opts.kind) conditions.push(eq(memoryEntities.kind, opts.kind));
    conditions.push(
      opts.status ? eq(memory.status, opts.status) : sql`${memory.status} != 'archived'`,
    );
    if (opts.type) conditions.push(eq(memory.type, opts.type));
    if (opts.types) conditions.push(inArray(memory.type, [...opts.types]));
    if (opts.tag) {
      conditions.push(
        sql`EXISTS (SELECT 1 FROM json_each(${memory.tags}) je WHERE je.value = ${opts.tag})`,
      );
    }
    if (opts.topicKey) conditions.push(eq(memory.topicKey, opts.topicKey));

    return this.db
      .select(getTableColumns(memory))
      .from(memoryEntityLinks)
      .innerJoin(memoryEntities, eq(memoryEntityLinks.entityId, memoryEntities.id))
      .innerJoin(memory, eq(memoryEntityLinks.memoryId, memory.id))
      .where(and(...conditions))
      .orderBy(sql`${memory.createdAt} desc`, sql`${memory.id} desc`)
      .limit(opts.limit)
      .all();
  }

  findEntitiesForMemory(memoryId: string): MemoryEntityView[] {
    return this.db
      .select({ kind: memoryEntities.kind, value: memoryEntities.value })
      .from(memoryEntityLinks)
      .innerJoin(memoryEntities, eq(memoryEntityLinks.entityId, memoryEntities.id))
      .where(eq(memoryEntityLinks.memoryId, memoryId))
      .orderBy(memoryEntities.kind, memoryEntities.value)
      .all();
  }

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
      .orderBy(memoryEntities.kind, memoryEntities.value)
      .all();
    for (const r of rows) {
      const list = out.get(r.memoryId) ?? [];
      list.push({ kind: r.kind, value: r.value });
      out.set(r.memoryId, list);
    }
    return out;
  }

  scopeActiveMemoryCount(opts: { projectId: string; excludeMemoryId?: string }): number {
    const conditions = [scopeCondition(projectScope(opts.projectId)), eq(memory.status, 'active')];
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
    projectId: string;
    kind: EntityKind;
    value: string;
    excludeMemoryId?: string;
  }): number {
    const conditions = [
      entityScopeCondition(projectScope(opts.projectId)),
      eq(memoryEntities.kind, opts.kind),
      eq(memoryEntities.value, opts.value),
      eq(memory.status, 'active'),
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

  findOtherMemoriesForEntity(opts: {
    projectId: string;
    kind: EntityKind;
    value: string;
    excludeMemoryId: string;
    excludeIds: string[];
    limit: number;
  }): Memory[] {
    const conditions = [
      entityScopeCondition(projectScope(opts.projectId)),
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

  findMissingScans(limit: number): PendingEntityScan[] {
    return this.db
      .select({
        id: memory.id,
        projectId: sql<string>`${memory.projectId}`,
        title: memory.title,
        content: memory.content,
      })
      .from(memory)
      .leftJoin(memoryEntityScan, eq(memoryEntityScan.memoryId, memory.id))
      .where(and(isNull(memoryEntityScan.memoryId), isNotNull(memory.projectId)))
      .orderBy(memory.createdAt)
      .limit(limit)
      .all();
  }

  adminBacklogCount(): number {
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(memory)
        .leftJoin(memoryEntityScan, eq(memoryEntityScan.memoryId, memory.id))
        .where(and(isNull(memoryEntityScan.memoryId), isNotNull(memory.projectId)))
        .get()?.n ?? 0
    );
  }

  countPendingScans(opts: { scope: SearchScope }): number {
    const scoped = scopeCondition(opts.scope);
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
    const kindFilter = filters.kind ? eq(memoryEntities.kind, filters.kind) : undefined;
    // No HAVING: the join and GROUP BY cannot change the count.
    if (!filters.singleReferenceOnly) {
      const row = this.db
        .select({ n: sql<number>`count(*)` })
        .from(memoryEntities)
        .where(kindFilter)
        .get();
      return row?.n ?? 0;
    }

    const grouped = this.db
      .select({ id: memoryEntities.id })
      .from(memoryEntities)
      .leftJoin(memoryEntityLinks, eq(memoryEntityLinks.entityId, memoryEntities.id))
      .where(kindFilter)
      .groupBy(memoryEntities.id)
      .having(sql`count(${memoryEntityLinks.memoryId}) = 1`)
      .as('grouped');
    return (
      this.db
        .select({ n: sql<number>`count(*)` })
        .from(grouped)
        .get()?.n ?? 0
    );
  }

  truncateAll(): void {
    this.db.delete(memoryEntityScan).run();
    this.db.delete(memoryEntityLinks).run();
    this.db.delete(memoryEntities).run();
  }
}
