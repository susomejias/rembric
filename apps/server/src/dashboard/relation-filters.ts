/**
 * The relation kind and status filter vocabulary, derived from the schema so a
 * new `memory_relations.relation` value cannot reach the database without
 * reaching the filter bar.
 */

import type { AdminRelationFilters } from '../db/repositories/index.js';
import {
  RELATION_STATUSES,
  RELATION_VALUES,
  type RelationStatus,
} from '../db/schema/memory-relations.js';

import type { SelOption } from './components.js';

/** The repository owns this domain (`'pending'` is its pseudo-kind for a NULL `relation`). */
export type RelationKindFilter = NonNullable<AdminRelationFilters['kind']>;

const KIND_FILTERS: readonly RelationKindFilter[] = [...RELATION_VALUES, 'pending'];

export function parseRelationKind(raw: string): RelationKindFilter | undefined {
  return (KIND_FILTERS as readonly string[]).includes(raw)
    ? (raw as RelationKindFilter)
    : undefined;
}

export function parseRelationStatus(raw: string): RelationStatus | undefined {
  return (RELATION_STATUSES as readonly string[]).includes(raw)
    ? (raw as RelationStatus)
    : undefined;
}

export function relationKindOptions(selected: string): SelOption[] {
  return [
    { value: '', label: 'all kinds', selected: selected === '' },
    ...KIND_FILTERS.map((k) => ({ value: k, label: k, selected: selected === k })),
  ];
}

export function relationStatusOptions(selected: string): SelOption[] {
  return [
    { value: '', label: 'all statuses', selected: selected === '' },
    ...RELATION_STATUSES.map((s) => ({ value: s, label: s, selected: selected === s })),
  ];
}
