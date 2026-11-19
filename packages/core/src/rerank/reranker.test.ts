import { beforeAll, describe, expect, it } from 'vitest';

import { loadRerankScorer, RERANK_MAX_TOKENS, type RerankScorer } from '@rembric/core';

const RELEVANT =
  'Nimbus scheduler port\n\nThe nimbus job scheduler listens on port 8781 to avoid the health-check sidecar.';
const IRRELEVANT = 'Dashboard fonts\n\nThe dashboard uses Geist fonts on dark zinc surfaces.';

describe('cross-encoder scorer (real model)', () => {
  let score: RerankScorer;

  beforeAll(async () => {
    score = await loadRerankScorer(null);
  }, 120_000);

  it('scores the relevant memory above the irrelevant one, in English and in Spanish', async () => {
    const [enRelevant, enIrrelevant] = await score('what port does the nimbus scheduler use', [
      RELEVANT,
      IRRELEVANT,
    ]);
    const [esRelevant, esIrrelevant] = await score(
      '¿en qué puerto escucha el scheduler de nimbus?',
      [RELEVANT, IRRELEVANT],
    );
    expect(enRelevant!).toBeGreaterThan(enIrrelevant!);
    expect(esRelevant!).toBeGreaterThan(esIrrelevant!);
    for (const s of [enRelevant, enIrrelevant, esRelevant, esIrrelevant]) {
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(1);
    }
  });

  it('returns one score per document across batch boundaries, in input order', async () => {
    const docs = Array.from({ length: 12 }, (_, i) => (i === 7 ? RELEVANT : IRRELEVANT));
    const scores = await score('what port does the nimbus scheduler use', docs);
    expect(scores).toHaveLength(12);
    expect(scores.indexOf(Math.max(...scores))).toBe(7);
  });

  it('reads a document only up to RERANK_MAX_TOKENS', async () => {
    const padding = 'unrelated filler words about the weather and lunch. '.repeat(
      RERANK_MAX_TOKENS,
    );
    const [front, back] = await score('what port does the nimbus scheduler use', [
      `${RELEVANT}\n\n${padding}`,
      `Notes\n\n${padding}${RELEVANT}`,
    ]);
    expect(front!).toBeGreaterThan(back!);
  });
});
