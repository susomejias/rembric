import { singleParam } from '@/components/dashboard/support';

export type SearchParams = Record<string, string | string[] | undefined>;

export interface EntitiesFilters {
  kind: string;
  page: number;
}

export function readEntitiesFilters(searchParams: SearchParams): EntitiesFilters {
  const raw = Number.parseInt(singleParam(searchParams['page']), 10);
  return {
    kind: singleParam(searchParams['kind']),
    page: Number.isNaN(raw) || raw < 1 ? 1 : raw,
  };
}
