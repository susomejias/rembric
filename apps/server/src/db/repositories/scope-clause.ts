import { and, eq, sql, type SQL } from 'drizzle-orm';

import { memory } from '../schema/memory.js';

/**
 * Shared `(scope, project_id)` WHERE fragment for scoped reads over the
 * `memory` table. `alias` qualifies the columns (e.g. `'m'`); pass a
 * controlled literal, never user input. No argument widens a scope past the
 * one it is given (memory spec: strict scope isolation).
 *
 * `scope = 'project'` stays in the predicate although every row now carries
 * that constant: it leads the five scope-bearing indexes, which are dropped
 * and recreated by a separate change (memory/spec.md).
 */
export function scopeWhere(projectId: string, alias?: string): SQL {
  const p = sql.raw(alias ? `${alias}.` : '');
  return sql`${p}scope = 'project' AND ${p}project_id = ${projectId}`;
}

/** Drizzle-builder sibling of `scopeWhere` for builder call sites. */
export function scopeCondition(projectId: string): SQL {
  return and(eq(memory.scope, 'project'), eq(memory.projectId, projectId)) as SQL;
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
 * A row's `memory_vec` partition IS its project. Named rather than inlined
 * because the value has to be supplied at insert time — vec0 forbids a NULL
 * partition key from being filled by a later trigger — so every writer has to
 * know where the key comes from.
 */
export function partitionKeyFor(projectId: string): string {
  return projectId;
}
