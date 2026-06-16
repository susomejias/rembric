import { sql, type SQL } from 'drizzle-orm';

import type { MemoryScope } from '../schema/memory.js';

/** Partition-key sentinel for the global scope (project_id IS NULL). */
export const GLOBAL_PARTITION_KEY = '__global__';

/**
 * Shared `(scope, project_id)` WHERE fragment for scoped reads over the
 * `memory` table. `alias` qualifies the columns (e.g. `'m'`) when the query
 * joins other tables; pass a controlled literal, never user input.
 */
export function scopeWhere(scope: MemoryScope, projectId: string | null, alias?: string): SQL {
  const p = sql.raw(alias ? `${alias}.` : '');
  return scope === 'project'
    ? sql`${p}scope = 'project' AND ${p}project_id = ${projectId}`
    : sql`${p}scope = 'global' AND ${p}project_id IS NULL`;
}

/**
 * Scope-derived `memory_vec` partition key: the `project_id` for project
 * scope, the global sentinel otherwise. Set at insert time (vec0 forbids a
 * NULL partition key from being filled by a later trigger).
 */
export function partitionKeyFor(scope: MemoryScope, projectId: string | null): string {
  return scope === 'project' && projectId ? projectId : GLOBAL_PARTITION_KEY;
}
