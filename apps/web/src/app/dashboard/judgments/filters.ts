import {
  RELATION_STATUSES,
  RELATION_VALUES,
  type AdminRelationFilters,
  type RelationStatus,
} from '@rembric/db';

import { pageParam, RETIRED_PROJECT_FILTER, singleParam } from '@/components/dashboard/format';

export type SearchParams = Record<string, string | string[] | undefined>;

/** The repository owns this domain (`'pending'` is its pseudo-kind for a NULL `relation`). */
export type RelationKindFilter = NonNullable<AdminRelationFilters['kind']>;

/** The verdict vocabulary plus the repository's `'pending'` pseudo-kind. */
export const RELATION_KIND_FILTERS: readonly RelationKindFilter[] = [...RELATION_VALUES, 'pending'];

/**
 * The judgments list's filter model. Both filters are optional by design: the
 * Hono handler (`apps/server/src/dashboard/judgments.ts`) only applies a filter
 * whose value is in the schema-derived vocabulary, so an unknown or empty value
 * leaves the queue unfiltered rather than filtering it to nothing.
 */
export interface JudgmentsFilters {
  status: string;
  kind: string;
  page: number;
}

export function readJudgmentsFilters(searchParams: SearchParams): JudgmentsFilters {
  return {
    status: singleParam(searchParams['status']),
    kind: singleParam(searchParams['kind']),
    page: pageParam(searchParams['page']),
  };
}

export function parseRelationStatus(raw: string): RelationStatus | undefined {
  return (RELATION_STATUSES as readonly string[]).includes(raw)
    ? (raw as RelationStatus)
    : undefined;
}

export function parseRelationKind(raw: string): RelationKindFilter | undefined {
  return (RELATION_KIND_FILTERS as readonly string[]).includes(raw)
    ? (raw as RelationKindFilter)
    : undefined;
}

/** The repository filter set the row query, the count query and the pager all share. */
export function relationFilters(filters: JudgmentsFilters): AdminRelationFilters {
  const out: AdminRelationFilters = {};
  const status = parseRelationStatus(filters.status);
  if (status) out.status = status;
  const kind = parseRelationKind(filters.kind);
  if (kind) out.kind = kind;
  return out;
}

/** Every param the current URL carries except `page` and the retired project sentinel. */
export function judgmentsQuery(searchParams: SearchParams): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(searchParams)) {
    if (key === 'page') continue;
    const value = singleParam(raw);
    if (key === 'project' && value === RETIRED_PROJECT_FILTER) continue;
    out[key] = value;
  }
  return out;
}
