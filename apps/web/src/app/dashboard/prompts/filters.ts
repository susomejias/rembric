import type { Prompt } from '@rembric/db';

import { pageParam, RETIRED_PROJECT_FILTER, singleParam } from '@/components/dashboard/support';

export type SearchParams = Record<string, string | string[] | undefined>;

/**
 * The prompts list's filter model: the legacy `__global__` project sentinel
 * normalises to "no filter", `include_deleted` is the literal `1`, and every
 * other filter is empty-string "unset".
 */
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

/** Every param the current URL carries except `page` and the `__global__` sentinel. */
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

/**
 * The FTS branch searches the whole corpus post-pagination, so the URL's other
 * filters have to be applied to its rows in memory — the repository can only
 * take them on the non-search path.
 */
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

/**
 * A project slug that names no live project filters to NOTHING rather than
 * silently dropping the filter: it is a stale or hand-edited URL, and the
 * operator should see the emptiness. The list views each own their filter model
 * (`memories/filters.ts` keeps the same rule privately) — this is the prompts
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
