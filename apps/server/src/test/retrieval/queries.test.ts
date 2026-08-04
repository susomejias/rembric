import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ABSTAIN_REASON, EMPTY_POOL_REASON, hybridSearch } from '../../services/hybrid-search.js';
import { FakeEmbedder } from '../embedder.js';

import { CORPUS, PROJECTS } from './corpus.js';
import { ingestCorpus, type Ingested } from './ingest.js';
import { QUERIES } from './queries.js';
import { resolveGold, resolveScope } from './resolve.js';
import type { QueryScopeFixture } from './types.js';

const ABSTENTION_QUERIES = QUERIES.filter((q) => q.type === 'abstention');
const ISOLATION_QUERIES = QUERIES.filter((q) => q.type === 'cross-project-isolation');

let corpus: Ingested;

beforeAll(async () => {
  corpus = await ingestCorpus(CORPUS, new FakeEmbedder());
}, 60_000);

afterAll(() => corpus.cleanup());

/**
 * An `abstention` query that returns nothing because no candidate matched
 * scores restraint it did not earn — the gate was never consulted. These tests
 * drive the LEXICAL BRANCH ALONE (no `embedQuery`), which is the strong form of
 * the guarantee: with the dense branch wired every query has candidates
 * trivially, so the assertion would prove nothing.
 */
describe('the abstention query set exercises the gate, not an empty candidate set', () => {
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
    expect(result.abstained).toBe(true);
    // The empty pool's reason, not the floor's: the floor ships disabled and
    // never ran here.
    expect(result.abstainReason).toBe(EMPTY_POOL_REASON);
    expect(result.abstainReason).not.toBe(ABSTAIN_REASON);
  });
});

/**
 * The retired `cross-scope` type scored a retriever on returning a global
 * memory alongside a project one. What survives is the isolation half: the
 * convention and its instance live in one project, and a second project holds
 * a vocabulary-sharing row that must stay out.
 */
describe('the cross-project-isolation queries keep their control in a second project', () => {
  function search(text: string, projectId: string) {
    return corpus.memory.searchWithAbstention(
      { query: text, limit: 8 },
      { kind: 'project', projectId },
    );
  }

  it('commits at least one cross-project-isolation query', () => {
    expect(ISOLATION_QUERIES.length).toBeGreaterThan(0);
  });

  it.each(ISOLATION_QUERIES.map((q) => [q.id, q] as const))(
    '%s: all its gold sits in the queried project, and no other project appears',
    async (_id, q) => {
      const { projectId } = resolveScope(corpus, q.scope);
      const goldIds = resolveGold(corpus, q.goldStableIds);
      const projectById = new Map(corpus.items.map((m) => [m.id, m.projectId]));
      expect(goldIds.length).toBeGreaterThan(1);
      for (const id of goldIds) expect(projectById.get(id)).toBe(projectId);

      const { memories } = await search(q.text, projectId!);
      expect(memories.filter((m) => goldIds.includes(m.id)).length).toBeGreaterThan(0);
      for (const m of memories) expect(m.projectId).toBe(projectId);

      // Non-vacuity: this query DOES retrieve the second project's control row
      // when asked there, so its absence above is the closed scope rather than
      // an irrelevant row nothing would have returned anyway.
      const other = PROJECTS.find((p) => p.slug !== q.scope.project)!;
      const otherId = corpus.projectIdBySlug.get(other.slug)!;
      const control = CORPUS.filter(
        (c) => c.id.endsWith('-cross-project') && c.project === other.slug,
      );
      expect(control).toHaveLength(1);
      const controlId = corpus.idByStableId.get(control[0]!.id)!;
      expect(memories.map((m) => m.id)).not.toContain(controlId);
      const elsewhere = await search(q.text, otherId);
      expect(elsewhere.memories.map((m) => m.id)).toContain(controlId);
    },
  );
});
