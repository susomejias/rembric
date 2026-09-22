import type { Prompt } from '@rembric/db';

import { pageParam, RETIRED_PROJECT_FILTER, singleParam } from '@/components/dashboard/support';

export type SearchParams = Record<string, string | string[] | undefined>;

export interface PromptsFilters {
  project: string;
  session: string;
  agent: string;
  q: string;
  includeDeleted: boolean;
  page: number;
}

export function readPromptsFilters(searchParams: SearchParams): PromptsFilters {
  const project = singleParam(searchParams['project']);
  return {
    project: project === RETIRED_PROJECT_FILTER ? '' : project,
    session: singleParam(searchParams['session']),
    agent: singleParam(searchParams['agent']),
    q: singleParam(searchParams['q']),
    includeDeleted: singleParam(searchParams['include_deleted']) === '1',
    page: pageParam(searchParams['page']),
  };
}

export function promptsQuery(searchParams: SearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(searchParams)) {
    if (key === 'page') continue;
    const value = singleParam(raw);
    if (key === 'project' && value === RETIRED_PROJECT_FILTER) continue;
    out[key] = value;
  }
  return out;
}

export function matchesFilters(
  p: Prompt,
  opts: {
    includeDeleted: boolean;
    projectId: string | undefined;
    agent: string;
    session: string;
  },
): boolean {
  if (!opts.includeDeleted && p.deletedAt != null) return false;
  if (opts.projectId !== undefined && p.projectId !== opts.projectId) return false;
  if (opts.agent && p.agent !== opts.agent) return false;
  if (opts.session && (!p.sessionId || !p.sessionId.startsWith(opts.session))) return false;
  return true;
}

export function resolveProjectFilter(
  slug: string,
  projectRows: readonly { id: string; slug: string }[],
): { projectId?: string; unknown: boolean } {
  if (slug === '') return { unknown: false };
  const row = projectRows.find((p) => p.slug === slug);
  return row ? { projectId: row.id, unknown: false } : { unknown: true };
}
