import { singleParam } from '@/components/dashboard/support';

export type SearchParams = Record<string, string | string[] | undefined>;

export interface EntitiesFilters {
  kind: string;
}

export function readEntitiesFilters(searchParams: SearchParams): EntitiesFilters {
  return { kind: singleParam(searchParams['kind']) };
}
