import { and, eq, isNull, sql, type SQL } from 'drizzle-orm';

import { memory, type MemoryScope } from '../schema/memory.js';

/** Partition-key sentinel for the global scope (project_id IS NULL). */
export const GLOBAL_PARTITION_KEY = '__global__';

/**
 * Shared `(scope, project_id)` WHERE fragment for scoped reads over the
 * `memory` table. `alias` qualifies the columns (e.g. `'m'`); pass a
 * controlled literal, never user input. No argument widens a scope past the
 * one it is given (memory spec: strict scope isolation).
 */
export function scopeWhere(scope: MemoryScope, projectId: string | null, alias?: string): SQL {
  const p = sql.raw(alias ? `${alias}.` : '');
  if (scope === 'project') {
    return sql`${p}scope = 'project' AND ${p}project_id = ${projectId}`;
  }
  return sql`${p}scope = 'global' AND ${p}project_id IS NULL`;
}

/** Drizzle-builder sibling of `scopeWhere` for builder call sites. */
export function scopeCondition(scope: MemoryScope, projectId: string | null): SQL {
  return scope === 'project'
    ? (and(eq(memory.scope, 'project'), eq(memory.projectId, projectId ?? '')) as SQL)
    : (and(eq(memory.scope, 'global'), isNull(memory.projectId)) as SQL);
}

/**
 * One JSON bind, not one placeholder per id: SQLite throws above 32 766 binds.
 * Its plan is an indexed join (`SEARCH … USING COVERING INDEX (id=?)` plus
 * `LIST SUBQUERY / SCAN json_each`), never a scan, and it is linear at ~0.68µs/id.
 */
export function idJsonSet(ids: readonly string[]): SQL {
  return sql`(SELECT value FROM json_each(${JSON.stringify([...ids])}))`;
}

/**
 * Scope-derived `memory_vec` partition key: the `project_id` for project
 * scope, the global sentinel otherwise. Set at insert time (vec0 forbids a
 * NULL partition key from being filled by a later trigger).
 */
export function partitionKeyFor(scope: MemoryScope, projectId: string | null): string {
  return scope === 'project' && projectId ? projectId : GLOBAL_PARTITION_KEY;
}
