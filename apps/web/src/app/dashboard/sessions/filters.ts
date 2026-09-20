import { AGENT_SESSION_STATUSES, type AgentSessionStatus } from '@rembric/db';

import { pageParam, RETIRED_PROJECT_FILTER, singleParam } from '@/components/dashboard/format';

export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The sessions list's filter model. Reading is deliberately the same shape the
 * Hono handler used (`apps/server/src/dashboard/sessions.ts`): the retired
 * `__global__` project sentinel normalises to "no filter", `include_deleted` is
 * the literal `1`, and every other filter is empty-string "unset".
 */
export interface SessionsFilters {
  project: string;
  agent: string;
  status: string;
  includeDeleted: boolean;
  page: number;
}

export function readSessionsFilters(searchParams: SearchParams): SessionsFilters {
  const project = singleParam(searchParams['project']);
  return {
    project: project === RETIRED_PROJECT_FILTER ? '' : project,
    agent: singleParam(searchParams['agent']),
    status: singleParam(searchParams['status']),
    includeDeleted: singleParam(searchParams['include_deleted']) === '1',
    page: pageParam(searchParams['page']),
  };
}

/**
 * A status the query string names only counts as a filter when it is a real
 * session status; anything else leaves the list unfiltered rather than
 * filtering to nothing — the Hono handler's rule.
 */
export function parseSessionStatus(raw: string): AgentSessionStatus | undefined {
  return (AGENT_SESSION_STATUSES as readonly string[]).includes(raw)
    ? (raw as AgentSessionStatus)
    : undefined;
}

/**
 * Every param the current URL carries, except `page` and the retired project
 * sentinel — the set the pager and the filter form round-trip, `include_deleted`
 * included so the deleted table stays visible across pages.
 */
export function sessionsQuery(searchParams: SearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(searchParams)) {
    if (key === 'page') continue;
    const value = singleParam(raw);
    if (key === 'project' && value === RETIRED_PROJECT_FILTER) continue;
    out[key] = value;
  }
  return out;
}

/**
 * A project slug that names no live project filters to NOTHING rather than
 * silently dropping the filter: it is a stale or hand-edited URL, and the
 * operator should see the emptiness. The list views each own their filter model
 * (`memories/filters.ts` keeps the same rule privately) — this is the sessions
 * view's copy, not a second rule.
 */
export function resolveProjectFilter(
  slug: string,
  projectRows: readonly { id: string; slug: string }[],
): { projectId?: string; unknown: boolean } {
  if (slug === '') return { unknown: false };
  const row = projectRows.find((p) => p.slug === slug);
  return row ? { projectId: row.id, unknown: false } : { unknown: true };
}
