/**
 * Shared entity-relevance lookup, consumed by BOTH `memory.context`'s focus
 * pass and `recallHints` — the one place `findMemoriesByEntity` is called
 * with a type/status filter, so the two paths cannot drift back into
 * different assumptions about which rows are eligible (proactive-recall D4).
 */

import type { EntitiesRepository } from '../db/repositories/entities-repository.js';
import type { Memory, MemoryStatus, MemoryType } from '../db/schema/memory.js';

import { extractEntities, type ExtractedEntity } from './entities.js';
import type { SearchScope } from './scope.js';

export interface EntityRelevanceMatch {
  entity: ExtractedEntity;
  memories: Memory[];
}

export interface EntityRelevanceOptions {
  scope: SearchScope;
  seedText: string;
  limit: number;
  /** Omitted admits every type — `memory.context`'s current behavior. */
  types?: readonly MemoryType[];
  /** Omitted admits `superseded` — `findMemoriesByEntity`'s own default. */
  status?: MemoryStatus;
  /** Bounds how many distinct entities are probed; defaults to every extracted one. */
  probeMax?: number;
  /** Checked before each probe; returning false stops iteration (an answer-size cap). */
  shouldContinue?: () => boolean;
  /** Checked before each probe; a `true` entity is skipped without querying the index. */
  skip?: (entity: ExtractedEntity) => boolean;
}

/**
 * Lazily probes the entity index for each entity extracted from `seedText`,
 * one query per probed entity. A generator, not an eagerly-computed array,
 * so a caller's own stop condition (`shouldContinue`) can prevent a query
 * for an entity the caller no longer needs — exactly what the pre-existing
 * `memory.context` loop already relied on before this became shared.
 */
export function* iterateEntityMatches(
  repos: { entities: Pick<EntitiesRepository, 'findMemoriesByEntity'> },
  opts: EntityRelevanceOptions,
): Generator<EntityRelevanceMatch> {
  const entities = extractEntities('', opts.seedText);
  const probeMax = opts.probeMax ?? entities.length;
  let probed = 0;
  for (const entity of entities) {
    if (opts.skip?.(entity)) continue;
    if (probed >= probeMax) return;
    if (opts.shouldContinue && !opts.shouldContinue()) return;
    probed += 1;
    const memories = repos.entities.findMemoriesByEntity({
      scope: opts.scope,
      kind: entity.kind,
      value: entity.value,
      limit: opts.limit,
      types: opts.types,
      status: opts.status,
    });
    yield { entity, memories };
  }
}
