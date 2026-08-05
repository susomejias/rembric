import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';

import type { SearchScope } from '../../services/scope.js';
import { memory } from '../schema/memory.js';

/**
 * The projects a scope addresses. Refuses an empty set rather than emitting
 * `IN ()`, which SQLite answers with an empty result rather than an error — a
 * widening that resolved to nothing would silently return no rows.
 */
function projectIdsOf(scope: SearchScope): readonly string[] {
  const ids = scope.kind === 'project' ? [scope.projectId] : scope.projectIds;
  if (ids.length === 0) throw new Error('scope addresses no project');
  return ids;
}

/**
 * Shared `(scope, project_id)` WHERE fragment for scoped reads over the
 * `memory` table. `alias` qualifies the columns (e.g. `'m'`); pass a
 * controlled literal, never user input. No argument widens a scope past the
 * set it is given (memory spec: strict scope isolation).
 *
 * One shape for one project and for many: `IN` over a one-element bound list
 * keeps every index the equality form kept, and is within noise of it on every
 * scoped read (vec-partition-scale.md §5, and this change's phase-4 re-run over
 * the reads §5 did not cover). The list is bound, not `idJsonSet`: as a
 * subquery the planner drops `memory_topic_key_active_idx`, which costs
 * `listNearbyTopicKeys` 0.012 ms → 16 ms at 50 000 rows.
 *
 * `scope = 'project'` stays in the predicate although every row now carries
 * that constant: it leads the five scope-bearing indexes, which are dropped
 * and recreated by a separate change (memory/spec.md).
 */
export function scopeWhere(scope: SearchScope, alias?: string): SQL {
  const p = sql.raw(alias ? `${alias}.` : '');
  const ids = sql.join(
    projectIdsOf(scope).map((id) => sql`${id}`),
    sql`, `,
  );
  return sql`${p}scope = 'project' AND ${p}project_id IN (${ids})`;
}

/** Drizzle-builder sibling of `scopeWhere` for builder call sites. */
export function scopeCondition(scope: SearchScope): SQL {
  return and(
    eq(memory.scope, 'project'),
    inArray(memory.projectId, [...projectIdsOf(scope)]),
  ) as SQL;
}

/**
 * One JSON bind, not one placeholder per id: SQLite throws above 32 766 binds.
 * Its plan is an indexed join (`SEARCH … USING COVERING INDEX (id=?)` plus
 * `LIST SUBQUERY / SCAN json_each`), never a scan, and it is linear at ~0.68µs/id.
 */
export function idJsonSet(ids: readonly string[]): SQL {
  return sql`(SELECT value FROM json_each(${JSON.stringify([...ids])}))`;
}

/** A row's `memory_vec` partition IS its project. */
export function partitionKeyFor(projectId: string): string {
  return projectId;
}

/**
 * Read sibling of `partitionKeyFor`: the partitions a search may address. A
 * second function rather than a widening of that one, which is on the write
 * path and maps one row to one key (design D17).
 */
export function partitionKeysFor(scope: SearchScope): readonly string[] {
  return projectIdsOf(scope);
}
