import { and, count, desc, eq, inArray, isNull, or } from 'drizzle-orm';

import type { Db } from './client.js';
import { memory, type Memory, type MemoryScope, type MemoryStatus } from './schema/memory.js';

/**
 * Reusable query helpers. Service modules build on these to keep their
 * call sites short and intent-revealing. Anything ad-hoc and one-off
 * should stay inline in the service, not pollute this file.
 */

export function findMemoryById(db: Db, id: string): Memory | undefined {
  return db.select().from(memory).where(eq(memory.id, id)).get();
}

export interface FindActiveByScopeOpts {
  scope: MemoryScope;
  projectId?: string | null;
  includeGlobal?: boolean;
  limit?: number;
  offset?: number;
}

export function findActiveByScope(db: Db, opts: FindActiveByScopeOpts): Memory[] {
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

  let query = db
    .select()
    .from(memory)
    .where(and(scopeFilter, eq(memory.status, 'active')))
    .orderBy(desc(memory.createdAt))
    .$dynamic();

  if (opts.limit !== undefined) query = query.limit(opts.limit);
  if (opts.offset !== undefined) query = query.offset(opts.offset);

  return query.all();
}

export function findMemoriesByIds(db: Db, ids: readonly string[]): Memory[] {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(memory)
    .where(inArray(memory.id, [...ids]))
    .all();
}

export function countMemoriesByStatus(db: Db, status: MemoryStatus): number {
  const row = db.select({ value: count() }).from(memory).where(eq(memory.status, status)).get();
  return row?.value ?? 0;
}
