import { AGENT_SESSION_STATUSES, type AgentSessionStatus } from '@rembric/db';

import { pageParam, RETIRED_PROJECT_FILTER, singleParam } from '@/components/dashboard/support';

export type SearchParams = Record<string, string | string[] | undefined>;

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

export function parseSessionStatus(raw: string): AgentSessionStatus | undefined {
  return (AGENT_SESSION_STATUSES as readonly string[]).includes(raw)
    ? (raw as AgentSessionStatus)
    : undefined;
}

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

export function resolveProjectFilter(
  slug: string,
  projectRows: readonly { id: string; slug: string }[],
): { projectId?: string; unknown: boolean } {
  if (slug === '') return { unknown: false };
  const row = projectRows.find((p) => p.slug === slug);
  return row ? { projectId: row.id, unknown: false } : { unknown: true };
}
