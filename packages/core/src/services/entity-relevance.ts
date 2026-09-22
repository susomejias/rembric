import {
  type EntitiesRepository,
  type Memory,
  type MemoryStatus,
  type MemoryType,
  type SearchScope,
} from '@rembric/db';

import { extractEntities, type ExtractedEntity } from './entities.js';

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
