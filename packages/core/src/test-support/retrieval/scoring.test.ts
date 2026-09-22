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
    widened: false,
    returnedRows: 8,
    foreignRows: 0,
    tokensReturned: 100,
    latencyMs: 1,
    ...over,
  };
}

const CEILINGS = new Map([
  ['gold-a', ceilingFor(1, 8)],
  ['gold-b', ceilingFor(1, 8)],
  ['gold-c', ceilingFor(1, 8)],
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
        retrievedProjectIds: [],
        scopeProjectId: 'p1',
        widened: false,
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
        retrievedProjectIds: ['p1'],
        scopeProjectId: 'p1',
        widened: false,
        goldIds: ['g1'],
        latencyMs: 0,
        tokensReturned: 10,
      }).abstained,
    ).toBe(false);
  });
});

describe('foreignScopeRate', () => {
  function outcome(over: Partial<Parameters<typeof scoreQuery>[0]> = {}) {
    return scoreQuery({
      queryId: 'q',
      type: 'extraction',
      k: 8,
      retrieved: ['a', 'b', 'c', 'd'],
      retrievedProjectIds: ['p1', 'p1', 'p1', 'p1'],
      scopeProjectId: 'p1',
      widened: false,
      goldIds: ['a'],
      latencyMs: 0,
      tokensReturned: 10,
      ...over,
    });
  }

  it('counts a row from another project and reports the denominator beside it', () => {
    const m = outcome({ retrievedProjectIds: ['p1', 'p2', 'p1', 'p1'] });
    expect(m.foreignRows).toBe(1);
    expect(m.returnedRows).toBe(4);
  });

  it('is a row-weighted fraction over the non-widened queries only', () => {
    const agg = aggregate(
      [
        metric({ queryId: 'gold-a', returnedRows: 8, foreignRows: 2 }),
        metric({ queryId: 'gold-b', returnedRows: 8, foreignRows: 0 }),
        // Widened: its foreign rows are the point, and they must not enter either side.
        metric({ queryId: 'gold-c', widened: true, returnedRows: 8, foreignRows: 8 }),
      ],
      CEILINGS,
      8,
    );
    expect(agg.nForeignScopeRows).toBe(16);
    expect(agg.foreignScopeRate).toBe(0.125);
  });

  it('reads exactly zero when every returned row is in scope, over a non-zero denominator', () => {
    const agg = aggregate(
      [metric({ queryId: 'gold-a', returnedRows: 8, foreignRows: 0 })],
      CEILINGS,
      8,
    );
    expect(agg.foreignScopeRate).toBe(0);
    expect(agg.nForeignScopeRows).toBe(8);
  });

  it('is null rather than zero when no non-widened query returned a row', () => {
    const agg = aggregate(
      [metric({ queryId: 'gold-c', widened: true, returnedRows: 8, foreignRows: 8 })],
      CEILINGS,
      8,
    );
    expect(agg.foreignScopeRate).toBeNull();
    expect(agg.nForeignScopeRows).toBe(0);
  });

  it('takes widening from the query declaration, not from the rows that came back', () => {
    // Same rows, opposite declarations: inferring widening from the presence of
    // foreign rows would make both of these read 0 and gate nothing.
    const declared = aggregate(
      [metric({ queryId: 'gold-a', widened: true, returnedRows: 4, foreignRows: 4 })],
      CEILINGS,
      8,
    );
    const undeclared = aggregate(
      [metric({ queryId: 'gold-a', widened: false, returnedRows: 4, foreignRows: 4 })],
      CEILINGS,
      8,
    );
    expect(declared.foreignScopeRate).toBeNull();
    expect(undeclared.foreignScopeRate).toBe(1);
  });
});
