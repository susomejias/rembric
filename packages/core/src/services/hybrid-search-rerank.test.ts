import { createRepositories, partitionKeyFor, projectScope, type Repositories } from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  EMBEDDING_DIMS,
  hybridSearch,
  rerankCandidates,
  RERANK_DENSE_SLOTS,
  MemoryService,
  ProjectsService,
  RERANK_WINDOW,
  type RerankFn,
} from '@rembric/core';

import { createTestDb, type TestDb } from '../test-support/index.js';

describe('the reranked path of hybrid search', () => {
  let db: TestDb;
  let repos: Repositories;
  let projectId: string;
  let mem: MemoryService;

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
    projectId = new ProjectsService(repos).create({ slug: 'app' }).id;
    mem = new MemoryService(repos, db.handle.db);
  });

  afterEach(() => db.cleanup());

  const seed = (count: number, extra = '') =>
    Array.from({ length: count }, (_, i) =>
      mem.save(
        {
          type: 'project',
          title: `Scheduler note ${i}`,
          content: `scheduler port note ${i} ${extra}`,
        },
        projectScope(projectId),
      ),
    );

  const search = (over: Partial<Parameters<typeof hybridSearch>[0]>) =>
    hybridSearch({
      repos,
      query: 'scheduler port',
      scope: projectScope(projectId),
      status: 'active',
      limit: 8,
      offset: 0,
      commonTermRatio: null,
      ...over,
    });

  const reverseScores: RerankFn = (_query, documents) =>
    Promise.resolve(documents.map((_d, i) => (i + 1) / (documents.length + 1)));

  it('scores RERANK_WINDOW rows, the head of the only branch that answered, and orders the page by score', async () => {
    seed(RERANK_WINDOW + 4);
    const unreranked = await search({ relativeLevelRatio: null });
    const rerank = vi.fn(reverseScores);
    const result = await search({ rerank, limit: 5 });

    expect(rerank).toHaveBeenCalledTimes(1);
    const [query, documents] = rerank.mock.calls[0]!;
    expect(query).toBe('scheduler port');
    expect(documents).toHaveLength(RERANK_WINDOW);
    const window = repos.memory.textByIds({
      ids: unreranked.ids.slice(0, 8),
      scope: projectScope(projectId),
    });
    const first = window.find((r) => r.id === unreranked.ids[0])!;
    expect(documents[0]).toBe(`${first.title}\n\n${first.content}`);

    expect(result.abstained).toBe(false);
    expect(result.ids).toHaveLength(5);
    expect(result.ids[0]).not.toBe(unreranked.ids[0]);
  });

  it('never returns a row outside the fused pool, whatever the scorer says', async () => {
    seed(3);
    mem.save(
      { type: 'project', title: 'Unrelated', content: 'nothing in common at all' },
      projectScope(projectId),
    );
    const result = await search({ rerank: (_q, docs) => Promise.resolve(docs.map(() => 1)) });
    const titles = repos.memory
      .textByIds({ ids: result.ids, scope: projectScope(projectId) })
      .map((r) => r.title);
    expect(titles).not.toContain('Unrelated');
  });

  it('does not let the relative filter thin the window, and reports no shortening', async () => {
    mem.save(
      {
        type: 'project',
        title: 'Scheduler port',
        content: 'the scheduler port is 8781 scheduler port',
      },
      projectScope(projectId),
    );
    mem.save(
      { type: 'project', title: 'Weak', content: 'a port somewhere' },
      projectScope(projectId),
    );
    const gated = await search({ relativeLevelRatio: 0.99 });
    expect(gated.ids).toHaveLength(1);
    expect(gated.gateShortened).toBe(true);

    const rerank = vi.fn(reverseScores);
    const reranked = await search({ relativeLevelRatio: 0.99, rerank });
    expect(rerank.mock.calls[0]![1]).toHaveLength(2);
    expect(reranked.ids).toHaveLength(2);
    expect(reranked.gateShortened).toBeUndefined();
  });

  it('abstains exactly as the unreranked path does, without calling the scorer', async () => {
    const rerank = vi.fn(reverseScores);
    const empty = await search({ rerank });
    expect(empty.abstained).toBe(true);

    seed(3);
    const floored = await search({ rerank, abstentionFloor: 1.01 });
    expect(floored.abstained).toBe(true);
    expect(floored.abstainReason).toBe((await search({ abstentionFloor: 1.01 })).abstainReason);
    expect(rerank).not.toHaveBeenCalled();
  });

  it('serves a paged or oversized call unreranked', async () => {
    seed(RERANK_WINDOW + 4);
    const rerank = vi.fn(reverseScores);
    expect((await search({ rerank, offset: 2 })).ids).toEqual((await search({ offset: 2 })).ids);
    const big = RERANK_WINDOW + 1;
    expect((await search({ rerank, limit: big })).ids).toEqual((await search({ limit: big })).ids);
    expect(rerank).not.toHaveBeenCalled();
  });

  it('falls back to exactly the unreranked response when the scorer returns null', async () => {
    seed(RERANK_WINDOW + 4);
    const fellBack = await search({ rerank: () => Promise.resolve(null) });
    expect(fellBack).toEqual(await search({}));
  });

  it('falls back to the unreranked response when the scorer rejects', async () => {
    seed(RERANK_WINDOW + 4);
    const rejected = await search({ rerank: () => Promise.reject(new Error('scorer down')) });
    expect(rejected).toEqual(await search({}));
  });

  it("lets the dense branch's best rows into the window when lexical-only rows crowd the fused head", async () => {
    const axis = (i: number) => {
      const v = new Float32Array(EMBEDDING_DIMS);
      v[i] = 1;
      return v;
    };
    const embed = (id: string, vector: Float32Array) =>
      repos.vectors.insertEmbedding(
        id,
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        partitionKeyFor(projectId),
      );
    const crowd = seed(12);
    for (const m of crowd) embed(m.id, axis(1));
    const target = mem.save(
      { type: 'project', title: 'Puerto del planificador', content: 'escucha en el 8781' },
      projectScope(projectId),
    );
    embed(target.id, axis(0));
    const lexicalOnly = mem.save(
      { type: 'project', title: 'Scheduler port', content: 'scheduler port scheduler port' },
      projectScope(projectId),
    );
    const embedQuery = () => Promise.resolve(axis(0));

    const fused = await search({ embedQuery, relativeLevelRatio: null, limit: 20 });
    expect(fused.ids.indexOf(target.id)).toBeGreaterThanOrEqual(RERANK_WINDOW);

    const rerank = vi.fn<RerankFn>((_q, docs) =>
      Promise.resolve(docs.map((d) => (d.startsWith('Puerto del planificador') ? 0.9 : 0.1))),
    );
    const result = await search({ embedQuery, rerank });
    const window = rerank.mock.calls[0]![1];
    expect(window).toHaveLength(RERANK_WINDOW);
    expect(window).toContain(`${lexicalOnly.title}\n\n${lexicalOnly.content}`);
    expect(result.ids[0]).toBe(target.id);
  });

  it('reaches a dense row ranked below an even split of the window', async () => {
    const towards = (c: number) => {
      const v = new Float32Array(EMBEDDING_DIMS);
      v[0] = c;
      v[2] = Math.sqrt(1 - c * c);
      return v;
    };
    const far = new Float32Array(EMBEDDING_DIMS);
    far[1] = 1;
    const embed = (id: string, vector: Float32Array) =>
      repos.vectors.insertEmbedding(
        id,
        Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
        partitionKeyFor(projectId),
      );
    for (const m of seed(12)) embed(m.id, far);
    for (let i = 0; i < 6; i++) {
      const near = mem.save(
        { type: 'project', title: `Nota cercana ${i}`, content: `otra cosa ${i}` },
        projectScope(projectId),
      );
      embed(near.id, towards(0.99 - i * 0.01));
    }
    const target = mem.save(
      { type: 'project', title: 'Puerto del planificador', content: 'escucha en el 8781' },
      projectScope(projectId),
    );
    embed(target.id, towards(0.92));
    const embedQuery = () => Promise.resolve(towards(1));

    const rerank = vi.fn<RerankFn>((_q, docs) =>
      Promise.resolve(docs.map((d) => (d.startsWith('Puerto del planificador') ? 0.9 : 0.1))),
    );
    const result = await search({ embedQuery, rerank });
    expect(rerank.mock.calls[0]![1]).toHaveLength(RERANK_WINDOW);
    expect(result.ids[0]).toBe(target.id);
  });

  it('keeps the recency and confirmation boost on top of the scores', async () => {
    const [plain, confirmed] = seed(2);
    for (let i = 0; i < 3; i++) mem.confirm(confirmed!.id, projectScope(projectId));
    const slightlyLower: RerankFn = (_q, docs) =>
      Promise.resolve(docs.map((d) => (d.startsWith(`${confirmed!.title}\n`) ? 0.45 : 0.5)));
    const result = await search({ rerank: slightlyLower });
    expect(result.ids.indexOf(confirmed!.id)).toBeLessThan(result.ids.indexOf(plain!.id));
  });
});

describe('rerankCandidates', () => {
  it('takes the dense slots first, then the lexical rows, until the window is full', () => {
    expect(rerankCandidates(['a', 'b', 'c', 'd'], ['x', 'y', 'z'], 5, 3)).toEqual([
      'a',
      'b',
      'c',
      'x',
      'y',
    ]);
  });

  it('keeps a row once, in the dense slot it reached first', () => {
    expect(rerankCandidates(['a', 'b'], ['a', 'x', 'y'], 4, 2)).toEqual(['a', 'b', 'x', 'y']);
  });

  it('fills from whichever list still has rows once the other runs out', () => {
    expect(rerankCandidates(['a'], ['x', 'y', 'z'], 4, 3)).toEqual(['a', 'x', 'y', 'z']);
    expect(rerankCandidates(['a', 'b', 'c', 'd'], ['x'], 4, 2)).toEqual(['a', 'b', 'x', 'c']);
    expect(rerankCandidates([], ['x', 'y'], 4, 3)).toEqual(['x', 'y']);
  });

  it('leaves the lexical list room in the shipped window', () => {
    expect(RERANK_DENSE_SLOTS).toBeLessThan(RERANK_WINDOW);
  });
});

describe('MemoryService reranks only when the caller asks and a scorer is wired', () => {
  let db: TestDb;
  let repos: Repositories;
  let projectId: string;

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
    projectId = new ProjectsService(repos).create({ slug: 'app' }).id;
  });

  afterEach(() => db.cleanup());

  it('passes the scorer through on request, and not otherwise', async () => {
    const rerank = vi.fn<RerankFn>((_q, docs) => Promise.resolve(docs.map(() => 0.5)));
    const mem = new MemoryService(repos, db.handle.db, undefined, undefined, rerank);
    mem.save(
      { type: 'project', title: 'Port', content: 'scheduler port' },
      projectScope(projectId),
    );

    await mem.searchWithAbstention({ query: 'scheduler port' }, projectScope(projectId));
    await mem.search({ query: 'scheduler port' }, projectScope(projectId));
    expect(rerank).not.toHaveBeenCalled();

    await mem.searchWithAbstention(
      { query: 'scheduler port' },
      projectScope(projectId),
      undefined,
      {
        rerank: true,
      },
    );
    expect(rerank).toHaveBeenCalledTimes(1);
  });

  it('serves the unreranked response when asked to rerank without a scorer', async () => {
    const mem = new MemoryService(repos, db.handle.db);
    mem.save(
      { type: 'project', title: 'Port', content: 'scheduler port' },
      projectScope(projectId),
    );
    const plain = await mem.searchWithAbstention(
      { query: 'scheduler port' },
      projectScope(projectId),
    );
    const asked = await mem.searchWithAbstention(
      { query: 'scheduler port' },
      projectScope(projectId),
      undefined,
      { rerank: true },
    );
    expect(asked).toEqual(plain);
  });
});
