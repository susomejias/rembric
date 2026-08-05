import { describe, expect, it } from 'vitest';

import { checkAbstentionFlags } from './abstention-flags.js';
import type { RawOutcome } from './types.js';

/**
 * The committed corpus cannot exercise this check — no query yields an empty
 * candidate pool, so no outcome hits either direction (see
 * `openspec/changes/archive/2026-08-03-weight-relevance-levels-by-idf/measurements/sweep-after-amendment.txt:56`,
 * "fused pool per query: min 10, max 26"). A green eval run is therefore not
 * evidence about it, and these constructed outcomes are.
 */
const outcome = (over: Partial<RawOutcome>): RawOutcome => ({
  query: {
    id: 'q1',
    text: 'anything',
    type: 'abstention',
    goldStableIds: [],
    scope: { project: 'atlas' },
  },
  retrieved: [],
  reportedAbstained: undefined,
  latencyMs: 0,
  goldIds: [],
  ...over,
});

describe('checkAbstentionFlags enforces one direction only', () => {
  it('fails an outcome that claims abstention while returning rows, naming the query', () => {
    const failures = checkAbstentionFlags('hybrid', [
      outcome({ reportedAbstained: true, retrieved: ['a', 'b', 'c'] }),
    ]);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain("'q1'");
    expect(failures[0]).toContain('3 result(s)');
  });

  it('permits an empty result set reported as abstained:false — the memory capability mandates it', () => {
    expect(
      checkAbstentionFlags('hybrid', [outcome({ reportedAbstained: false, retrieved: [] })]),
    ).toEqual([]);
  });

  it('permits the two coherent combinations', () => {
    expect(
      checkAbstentionFlags('hybrid', [
        outcome({ reportedAbstained: true, retrieved: [] }),
        outcome({ reportedAbstained: false, retrieved: ['a'] }),
      ]),
    ).toEqual([]);
  });

  it('ignores a retriever with no explicit flag, in both result shapes', () => {
    expect(
      checkAbstentionFlags('grep', [
        outcome({ reportedAbstained: undefined, retrieved: [] }),
        outcome({ reportedAbstained: undefined, retrieved: ['a'] }),
      ]),
    ).toEqual([]);
  });

  it('names every offending outcome, not just the first', () => {
    const failures = checkAbstentionFlags('hybrid', [
      outcome({ reportedAbstained: true, retrieved: ['a'] }),
      outcome({
        query: { ...outcome({}).query, id: 'q2' },
        reportedAbstained: true,
        retrieved: ['b'],
      }),
    ]);
    expect(failures).toHaveLength(2);
    expect(failures.join('\n')).toContain("'q2'");
  });
});
