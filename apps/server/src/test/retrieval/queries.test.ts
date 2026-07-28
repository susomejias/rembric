import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { hybridSearch } from '../../services/hybrid-search.js';
import { FakeEmbedder } from '../embedder.js';

import { CORPUS } from './corpus.js';
import { ingestCorpus, type Ingested } from './ingest.js';
import { QUERIES } from './queries.js';
import { resolveScope } from './resolve.js';
import type { QueryScopeFixture } from './types.js';

const ABSTENTION_QUERIES = QUERIES.filter((q) => q.type === 'abstention');

/**
 * An `abstention` query that returns nothing because no candidate matched
 * scores restraint it did not earn — the gate was never consulted. These tests
 * drive the LEXICAL BRANCH ALONE (no `embedQuery`), which is the strong form of
 * the guarantee: with the dense branch wired every query has candidates
 * trivially, so the assertion would prove nothing.
 */
describe('the abstention query set exercises the gate, not an empty candidate set', () => {
  let corpus: Ingested;

  beforeAll(async () => {
    corpus = await ingestCorpus(CORPUS, new FakeEmbedder());
  }, 60_000);

  afterAll(() => corpus.cleanup());

  function lexicalOnly(text: string, fixture: QueryScopeFixture) {
    const scope = resolveScope(corpus, fixture);
    return hybridSearch({
      repos: corpus.repos,
      query: text,
      ...scope,
      status: 'active',
      limit: 8,
      offset: 0,
    });
  }

  it('commits at least eight abstention queries, so the rate resolves to 0.125 steps', () => {
    expect(ABSTENTION_QUERIES.length).toBeGreaterThanOrEqual(8);
  });

  it('gives every abstention query an empty gold set', () => {
    for (const q of ABSTENTION_QUERIES) expect(q.goldStableIds).toEqual([]);
  });

  it.each(ABSTENTION_QUERIES.map((q) => [q.id, q] as const))(
    '%s returns lexical candidates with the gates disabled',
    async (_id, q) => {
      const result = await lexicalOnly(q.text, q.scope);
      expect(result.ids.length).toBeGreaterThan(0);
      expect(result.abstained).toBe(false);
    },
  );

  it('the same probe returns nothing for vocabulary absent from the corpus (so the assertion above can fail)', async () => {
    const result = await lexicalOnly('zzqqwx vvbbnm ppllkk', ABSTENTION_QUERIES[0]!.scope);
    expect(result.ids).toEqual([]);
  });
});
