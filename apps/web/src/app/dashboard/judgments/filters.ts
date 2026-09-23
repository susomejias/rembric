import {
  RELATION_STATUSES,
  RELATION_VALUES,
  type AdminRelationFilters,
  type RelationStatus,
} from '@rembric/db';

import { pageParam, singleParam } from '@/components/dashboard/support';

export type SearchParams = Record<string, string | string[] | undefined>;

export type RelationKindFilter = NonNullable<AdminRelationFilters['kind']>;

export const RELATION_KIND_FILTERS: readonly RelationKindFilter[] = [...RELATION_VALUES, 'pending'];

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

export function relationFilters(filters: JudgmentsFilters): AdminRelationFilters {
  const out: AdminRelationFilters = {};
  const status = parseRelationStatus(filters.status);
  if (status) out.status = status;
  const kind = parseRelationKind(filters.kind);
  if (kind) out.kind = kind;
  return out;
}
