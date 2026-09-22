import { and, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { memory } from '../schema/memory.js';
import type { SearchScope } from '../scope.js';

export function projectIdsOf(scope: SearchScope): readonly string[] {
  const ids = scope.kind === 'project' ? [scope.projectId] : scope.projectIds;
  if (ids.length === 0) throw new Error('scope addresses no project');
  return ids;
}

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

export function idJsonSet(ids: readonly string[]): SQL {
  return sql`(SELECT value FROM json_each(${JSON.stringify([...ids])}))`;
}

/** A row's `memory_vec` partition IS its project. */
export function partitionKeyFor(projectId: string): string {
  return projectId;
}

export function partitionKeysFor(scope: SearchScope): readonly string[] {
  return projectIdsOf(scope);
}
