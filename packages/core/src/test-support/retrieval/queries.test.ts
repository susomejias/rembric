import { projectScope } from '@rembric/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ABSTAIN_REASON, EMPTY_POOL_REASON, hybridSearch } from '@rembric/core';

import { FakeEmbedder } from '../embedder.js';

import { CORPUS, PROJECTS } from './corpus.js';
import { ingestCorpus, type Ingested } from './ingest.js';
import { QUERIES } from './queries.js';
import { resolveGold, resolveScope } from './resolve.js';
import { grepRetriever } from './retrievers/grep.js';
import { hybridRetriever } from './retrievers/hybrid.js';
import type { QueryItem } from './types.js';

/** The gated k values `run-eval.ts` scores; a gold set has to reach each of them. */
const K_VALUES = [5, 8] as const;

const ABSTENTION_QUERIES = QUERIES.filter((q) => q.type === 'abstention');
const ISOLATION_QUERIES = QUERIES.filter((q) => q.type === 'cross-project-isolation');
const WIDENED_QUERIES = QUERIES.filter((q) => q.widened === true);

let corpus: Ingested;

beforeAll(async () => {
  corpus = await ingestCorpus(CORPUS, new FakeEmbedder());
}, 60_000);

afterAll(() => corpus.cleanup());

describe('the abstention query set exercises the gate, not an empty candidate set', () => {
  function lexicalOnly(text: string, query: Pick<QueryItem, 'scope' | 'widened'>) {
    const { projectId } = resolveScope(corpus, query);
    return hybridSearch({
      repos: corpus.repos,
      query: text,
      scope: projectScope(projectId),
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
      const result = await lexicalOnly(q.text, q);
      expect(result.ids.length).toBeGreaterThan(0);
      expect(result.abstained).toBe(false);
    },
  );

  it('the same probe returns nothing for vocabulary absent from the corpus (so the assertion above can fail)', async () => {
    const result = await lexicalOnly('zzqqwx vvbbnm ppllkk', ABSTENTION_QUERIES[0]!);
    expect(result.ids).toEqual([]);
    expect(result.abstained).toBe(true);
    expect(result.abstainReason).toBe(EMPTY_POOL_REASON);
    expect(result.abstainReason).not.toBe(ABSTAIN_REASON);
  });
});

describe('the cross-project-isolation queries keep their control in a second project', () => {
  async function search(text: string, projectId: string): Promise<string[]> {
    const state = await hybridRetriever.init(corpus);
    const { ids } = await hybridRetriever.query(text, state, 8, {
      projectId,
      projectIds: [projectId],
    });
    return ids;
  }

  it('commits at least one cross-project-isolation query', () => {
    expect(ISOLATION_QUERIES.length).toBeGreaterThan(0);
  });

  it.each(ISOLATION_QUERIES.map((q) => [q.id, q] as const))(
    '%s: all its gold sits in the queried project, and no other project appears',
    async (_id, q) => {
      const { projectId } = resolveScope(corpus, q);
      const goldIds = resolveGold(corpus, q.goldStableIds);
      const projectById = new Map(corpus.items.map((m) => [m.id, m.projectId]));
      expect(goldIds.length).toBeGreaterThan(1);
      for (const id of goldIds) expect(projectById.get(id)).toBe(projectId);

      const ids = await search(q.text, projectId);
      expect(ids.filter((id) => goldIds.includes(id)).length).toBeGreaterThan(0);
      for (const id of ids) expect(projectById.get(id)).toBe(projectId);

      const other = PROJECTS.find((p) => p.slug !== q.scope.project)!;
      const otherId = corpus.projectIdBySlug.get(other.slug)!;
      const control = CORPUS.filter(
        (c) => c.id.endsWith('-cross-project') && c.project === other.slug,
      );
      expect(control).toHaveLength(1);
      const controlId = corpus.idByStableId.get(control[0]!.id)!;
      expect(ids).not.toContain(controlId);
      expect(await search(q.text, otherId)).toContain(controlId);
    },
  );
});

describe('the query set can be displaced at every gated k', () => {
  it.each(K_VALUES)('carries a gold-bearing query with at least %i gold ids', (k) => {
    const largest = Math.max(...QUERIES.map((q) => q.goldStableIds.length));
    expect(largest).toBeGreaterThanOrEqual(k);
  });

  it('resolves every one of those gold ids to a distinct ingested memory', () => {
    for (const q of QUERIES.filter((item) => item.goldStableIds.length >= K_VALUES[0])) {
      const ids = resolveGold(corpus, q.goldStableIds);
      expect(new Set(ids).size).toBe(q.goldStableIds.length);
    }
  });
});

describe('the cross-project distractors are strong enough to displace gold', () => {
  async function page(text: string, projectId: string, projectIds: string[]): Promise<string[]> {
    const state = await hybridRetriever.init(corpus);
    const { ids } = await hybridRetriever.query(text, state, 8, { projectId, projectIds });
    return ids;
  }

  it.each([
    ['q-atlas-release-checklist', 'shared-release-step-', true],
    ['q-nimbus-oncall-runbook', 'shared-runbook-step-', false],
  ])('%s: a scope-blind read pulls %s rows into the page', async (queryId, prefix, evictsGold) => {
    const q = QUERIES.find((item) => item.id === queryId)!;
    const distractorIds = CORPUS.filter((c) => c.id.startsWith(prefix)).map(
      (c) => corpus.idByStableId.get(c.id)!,
    );
    expect(distractorIds.length).toBeGreaterThan(0);

    const { projectId } = resolveScope(corpus, q);
    const goldIds = resolveGold(corpus, q.goldStableIds);
    const narrow = await page(q.text, projectId, [projectId]);
    const widened = await page(q.text, projectId, [...corpus.projectIdBySlug.values()]);

    const narrowGold = narrow.filter((id: string) => goldIds.includes(id)).length;
    expect(narrowGold).toBeGreaterThan(0);
    expect(narrow.filter((id: string) => distractorIds.includes(id))).toEqual([]);
    expect(widened.filter((id: string) => distractorIds.includes(id)).length).toBeGreaterThan(0);

    const bestDistractor = widened.findIndex((id: string) => distractorIds.includes(id));
    const worstGold = widened.reduce(
      (last: number, id: string, i: number) => (goldIds.includes(id) ? i : last),
      -1,
    );
    expect(worstGold).toBeGreaterThan(bestDistractor);

    if (evictsGold) {
      expect(narrow).toHaveLength(8);
      expect(widened.filter((id: string) => goldIds.includes(id)).length).toBeLessThan(narrowGold);
    } else {
      expect(narrow.length).toBeLessThan(8);
    }
  });
});

describe('the widened queries are gated by gold in another project', () => {
  it('commits at least one', () => {
    expect(WIDENED_QUERIES.length).toBeGreaterThan(0);
  });

  it('declares widening by the flag and the type together, so neither can drift', () => {
    for (const q of QUERIES) {
      expect(q.widened === true).toBe(q.type === 'cross-project-widened');
    }
  });

  it.each(WIDENED_QUERIES.map((q) => [q.id, q] as const))(
    '%s: every gold id lives outside the queried project',
    (_id, q: QueryItem) => {
      const { projectId } = resolveScope(corpus, q);
      const projectById = new Map(corpus.items.map((m) => [m.id, m.projectId]));
      expect(q.goldStableIds.length).toBeGreaterThan(0);
      for (const id of resolveGold(corpus, q.goldStableIds)) {
        expect(projectById.get(id)).not.toBe(projectId);
      }
    },
  );

  it.each(WIDENED_QUERIES.map((q) => [q.id, q] as const))(
    '%s: the widened read reaches the gold and the narrow read does not',
    async (_id, q: QueryItem) => {
      const scope = resolveScope(corpus, q);
      const goldIds = resolveGold(corpus, q.goldStableIds);
      const state = await hybridRetriever.init(corpus);

      const widened = await hybridRetriever.query(q.text, state, 8, scope);
      for (const id of goldIds) expect(widened.ids).toContain(id);

      const narrow = await hybridRetriever.query(q.text, state, 8, {
        projectId: scope.projectId,
        projectIds: [scope.projectId],
      });
      expect(narrow.ids.length).toBeGreaterThan(0);
      for (const id of goldIds) expect(narrow.ids).not.toContain(id);
    },
  );

  it.each(WIDENED_QUERIES.map((q) => [q.id, q] as const))(
    '%s: the in-memory control widens through the same declared set',
    async (_id, q: QueryItem) => {
      const scope = resolveScope(corpus, q);
      const goldIds = resolveGold(corpus, q.goldStableIds);
      const state = await grepRetriever.init(corpus);

      const widened = await grepRetriever.query(q.text, state, 8, scope);
      for (const id of goldIds) expect(widened.ids).toContain(id);

      const narrow = await grepRetriever.query(q.text, state, 8, {
        projectId: scope.projectId,
        projectIds: [scope.projectId],
      });
      expect(narrow.ids.length).toBeGreaterThan(0);
      for (const id of goldIds) expect(narrow.ids).not.toContain(id);
    },
  );
});
