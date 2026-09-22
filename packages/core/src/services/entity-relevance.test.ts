import { projectScope, type EntitiesRepository } from '@rembric/db';
import { describe, expect, it } from 'vitest';

import { extractEntities } from '@rembric/core';
import { iterateEntityMatches } from '@rembric/core';

describe('iterateEntityMatches', () => {
  it('does not query more entities than probeMax', () => {
    const seedText = Array.from(
      { length: 21 },
      (_, index) => `src/probe/entity-${String(index).padStart(2, '0')}.ts`,
    ).join(' ');
    expect(extractEntities('', seedText)).toHaveLength(21);

    let queries = 0;
    const repos: { entities: Pick<EntitiesRepository, 'findMemoriesByEntity'> } = {
      entities: {
        findMemoriesByEntity: () => {
          queries += 1;
          return [];
        },
      },
    };

    const matches = [
      ...iterateEntityMatches(repos, {
        scope: projectScope('project-id'),
        seedText,
        limit: 2,
        probeMax: 20,
      }),
    ];

    expect(matches).toHaveLength(20);
    expect(queries).toBe(20);
  });
});
