import { describe, expect, it } from 'vitest';

import {
  aggregate,
  aggregateByType,
  ceilingFor,
  scoreQuery,
  type QueryMetrics,
} from './scoring.js';

function metric(over: Partial<QueryMetrics> & { queryId: string }): QueryMetrics {
  return {
    type: 'extraction',
    k: 8,
    precisionAtK: 0.125,
    recallAtK: 1,
    reciprocalRank: 1,
    abstained: false,
    tokensReturned: 100,
    latencyMs: 1,
    ...over,
  };
}

const CEILINGS = new Map([
  ['gold-a', ceilingFor(1, 8)],
  ['gold-b', ceilingFor(1, 8)],
]);

describe('the two abstention error axes', () => {
  it('scores a gold-bearing query that returned nothing as over-abstention, not just lost recall', () => {
    const agg = aggregate(
      [
        metric({ queryId: 'gold-a' }),
        metric({
          queryId: 'gold-b',
          precisionAtK: 0,
          recallAtK: 0,
          reciprocalRank: 0,
          abstained: true,
        }),
      ],
      CEILINGS,
      8,
    );
    expect(agg.overAbstentionRate).toBe(0.5);
    // Reported separately from recall, which also moved.
    expect(agg.recallAtK).toBe(0.5);
  });

  it('counts the two axes over disjoint query sets', () => {
    const agg = aggregate(
      [
        // Gold-bearing and returned nothing -> over-abstention only.
        metric({
          queryId: 'gold-a',
          precisionAtK: 0,
          recallAtK: 0,
          reciprocalRank: 0,
          abstained: true,
        }),
        // Empty gold and returned something -> false positive only.
        metric({ queryId: 'abs-a', precisionAtK: null, recallAtK: null, reciprocalRank: null }),
      ],
      CEILINGS,
      8,
    );
    expect(agg.overAbstentionRate).toBe(1);
    expect(agg.abstentionFalsePositiveRate).toBe(1);
  });

  it('is zero, not null, when every gold-bearing query returned something', () => {
    const agg = aggregate([metric({ queryId: 'gold-a' })], CEILINGS, 8);
    expect(agg.overAbstentionRate).toBe(0);
    // No empty-gold query at all -> the other axis has nothing to measure.
    expect(agg.abstentionFalsePositiveRate).toBeNull();
  });

  it('is null when there is no gold-bearing query to measure', () => {
    const agg = aggregate(
      [metric({ queryId: 'abs-a', precisionAtK: null, recallAtK: null, reciprocalRank: null })],
      CEILINGS,
      8,
    );
    expect(agg.overAbstentionRate).toBeNull();
  });

  it('appears in the per-question-type breakdown', () => {
    const byType = aggregateByType(
      [
        metric({
          queryId: 'gold-a',
          type: 'temporal',
          abstained: true,
          precisionAtK: 0,
          recallAtK: 0,
          reciprocalRank: 0,
        }),
        metric({ queryId: 'gold-b', type: 'extraction' }),
      ],
      CEILINGS,
      8,
    );
    expect(byType['temporal']!.overAbstentionRate).toBe(1);
    expect(byType['extraction']!.overAbstentionRate).toBe(0);
  });

  it('reads abstention off emptiness, which is what every retriever can report', () => {
    expect(
      scoreQuery({
        queryId: 'gold-a',
        type: 'extraction',
        k: 8,
        retrieved: [],
        goldIds: ['g1'],
        latencyMs: 0,
        tokensReturned: 0,
      }).abstained,
    ).toBe(true);
    expect(
      scoreQuery({
        queryId: 'gold-a',
        type: 'extraction',
        k: 8,
        retrieved: ['g1'],
        goldIds: ['g1'],
        latencyMs: 0,
        tokensReturned: 10,
      }).abstained,
    ).toBe(false);
  });
});
