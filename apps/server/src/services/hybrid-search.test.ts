import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { loadEmbedder, type Embedder } from '../embeddings/embedder.js';
import { createTestDb, FakeEmbedder, type TestDb } from '../test/index.js';

import { EmbeddingWorker } from './embedding-worker.js';
import {
  applyDiversityCap,
  applyGapRatioFilter,
  applyRankingBoost,
  computeRankWindowSize,
  fuseRRF,
  fuseRRFWithScores,
  hybridSearch,
  RANK_CONSTANT,
  RANK_WINDOW_CEILING,
  sanitizeFtsQuery,
} from './hybrid-search.js';
import { MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { projectScope, SCOPE_GLOBAL } from './scope.js';

describe('fuseRRF', () => {
  it('ranks an item present in both lists above single-list items', () => {
    // dense: [A, B, C]   fts: [D, A, E]  → A appears in both → highest.
    const fused = fuseRRF([
      ['A', 'B', 'C'],
      ['D', 'A', 'E'],
    ]);
    expect(fused[0]).toBe('A');
    expect(new Set(fused)).toEqual(new Set(['A', 'B', 'C', 'D', 'E']));
  });

  it('preserves single-branch order and handles empty lists', () => {
    expect(fuseRRF([[], []])).toEqual([]);
    expect(fuseRRF([['X', 'Y', 'Z'], []])).toEqual(['X', 'Y', 'Z']);
  });
});

describe('sanitizeFtsQuery', () => {
  it('neutralizes punctuation/accents/operators that would crash or mis-parse FTS5', () => {
    // No throw potential: every token is quoted as a phrase.
    expect(sanitizeFtsQuery('¿cómo toma el café?')).toBe('"¿cómo" OR "toma" OR "el" OR "café?"');
    expect(sanitizeFtsQuery('coffee OR tea')).toBe('"coffee" OR "OR" OR "tea"'); // "OR" is a literal phrase, not the operator
    expect(sanitizeFtsQuery('C++')).toBe('"C++"');
    expect(sanitizeFtsQuery('a "b')).toBe('"a" OR "b"'); // stray quote stripped
  });

  it('returns empty for whitespace / pure punctuation (caller skips lexical branch)', () => {
    expect(sanitizeFtsQuery('   ')).toBe('');
    expect(sanitizeFtsQuery('!!! ??? ...')).toBe('');
  });

  it('caps the number of OR-phrases at maxTerms; the no-cap call is unchanged', () => {
    expect(sanitizeFtsQuery('alpha beta gamma delta epsilon', { maxTerms: 3 })).toBe(
      '"alpha" OR "beta" OR "gamma"',
    );
    expect(sanitizeFtsQuery('alpha beta gamma delta epsilon')).toBe(
      '"alpha" OR "beta" OR "gamma" OR "delta" OR "epsilon"',
    );
  });
});

describe('rank window floor', () => {
  it('floors the window at the crossover implied by RANK_CONSTANT for the default page', () => {
    const window = computeRankWindowSize(8, 0);
    expect(window).toBeGreaterThan(RANK_CONSTANT + 2); // the derived crossover
    expect(window).toBe(64);
  });

  it('leaves large-limit windows unchanged by the floor', () => {
    expect(computeRankWindowSize(400, 0)).toBe(RANK_WINDOW_CEILING);
    expect(computeRankWindowSize(370, 30)).toBe(RANK_WINDOW_CEILING);
  });

  /** Builds dense/lexical ranked lists of exactly `window` length, with `bothCount` ids at the bottom rank of both lists and `single` at rank 1 of the lexical list only. */
  function buildCrossoverLists(
    window: number,
    single: string,
    bothCount: number,
  ): { dense: string[]; lexical: string[]; both: string[] } {
    const both = Array.from({ length: bothCount }, (_, i) => `both-${i}`);
    const denseFillers = Array.from({ length: window - bothCount }, (_, i) => `dense-filler-${i}`);
    const lexFillers = Array.from({ length: window - 1 - bothCount }, (_, i) => `lex-filler-${i}`);
    return {
      dense: [...denseFillers, ...both],
      lexical: [single, ...lexFillers, ...both],
      both,
    };
  }

  // Only rows ranked strictly below the k+2 crossover in BOTH branches are
  // "free passes" a single-branch rank-1 match must survive against — at
  // window=64, k=60 that's ranks 63-64 (2 rows), not an arbitrary count. A
  // 3rd "both-branches" row already sits above the crossover and legitimately
  // outranks a single-signal match, which is correct ranking, not a defect
  // this fix is meant to (or could) prevent — more genuinely-relevant
  // competitors than fit on a page is not something any window floor can fix.
  it('a rank-1 single-branch row outranks bottom-of-window both-branches rows at the floored window', () => {
    const window = computeRankWindowSize(8, 0); // 64
    const single = 'single-branch-rank-1';
    const { dense, lexical, both } = buildCrossoverLists(
      window,
      single,
      window - (RANK_CONSTANT + 2),
    );
    const fused = fuseRRFWithScores([dense, lexical], RANK_CONSTANT);
    const rank = new Map(fused.map((f, i) => [f.id, i]));
    for (const id of both) expect(rank.get(single)!).toBeLessThan(rank.get(id)!);
  });

  it('the same construction inverts below the crossover (proves the invariant is real, not vacuous)', () => {
    const belowCrossoverWindow = RANK_CONSTANT + 1; // 61 < the 62 crossover
    const single = 'single-branch-rank-1';
    const { dense, lexical, both } = buildCrossoverLists(belowCrossoverWindow, single, 1);
    const fused = fuseRRFWithScores([dense, lexical], RANK_CONSTANT);
    const rank = new Map(fused.map((f, i) => [f.id, i]));
    expect(rank.get(both[0]!)!).toBeLessThan(rank.get(single)!);
  });
});

describe('applyRankingBoost', () => {
  const NOW = new Date('2026-01-01T00:00:00.000Z');
  const DAY_MS = 86_400_000;

  function fakeOpts(
    meta: Map<
      string,
      { type: 'user' | 'feedback' | 'project' | 'reference'; lastSeenAt: Date | null }
    >,
    confirmations: Map<string, number>,
  ) {
    return {
      repos: {
        memory: {
          rankingMetadataByIds: () => meta,
          confirmationCountsByIds: () => confirmations,
        },
      },
      now: () => NOW,
      // Minimal fake: applyRankingBoost reads only these two repo methods + `now`.
    } as unknown as Parameters<typeof applyRankingBoost>[1];
  }

  it('a heavily-confirmed, recently-seen memory outranks a stale unconfirmed one with a close raw RRF score', () => {
    const meta = new Map([
      ['fresh', { type: 'user' as const, lastSeenAt: new Date(NOW.getTime() - 1 * DAY_MS) }],
      ['stale', { type: 'user' as const, lastSeenAt: new Date(NOW.getTime() - 120 * DAY_MS) }],
    ]);
    const confirmations = new Map([['fresh', 3]]);
    // Close raw scores — stale is nominally ranked first pre-boost.
    const fused = [
      { id: 'stale', score: 0.02 },
      { id: 'fresh', score: 0.0195 },
    ];
    const result = applyRankingBoost(fused, fakeOpts(meta, confirmations));
    expect(result[0]?.id).toBe('fresh');
  });

  it('never introduces an id absent from the fused pool', () => {
    const meta = new Map([['a', { type: 'user' as const, lastSeenAt: NOW }]]);
    const fused = [{ id: 'a', score: 0.05 }];
    const result = applyRankingBoost(fused, fakeOpts(meta, new Map()));
    expect(result.map((r) => r.id)).toEqual(['a']);
  });

  it('returns an empty array for an empty fused pool without querying metadata', () => {
    const rankingMetadataByIds = vi.fn();
    // Double cast: minimal fake with just the fields applyRankingBoost reads.
    const opts = {
      repos: { memory: { rankingMetadataByIds, confirmationCountsByIds: vi.fn() } },
      now: () => NOW,
    } as unknown as Parameters<typeof applyRankingBoost>[1];
    expect(applyRankingBoost([], opts)).toEqual([]);
    expect(rankingMetadataByIds).not.toHaveBeenCalled();
  });

  it('cannot invert a large, still-reachable raw-score gap even at the boost extremes', () => {
    // 'strong' and 'weak' hit the actual reachable extremes ([0.9, 1.35], not
    // the declared-but-unreachable [0.7, 1.4] clamp — see hybrid-search.ts).
    // The old version of this test used a `strong: 0.1` input ~3x above the
    // maximum two-branch fused score (2/61 ≈ 0.033), so max boost on the
    // weaker id could never have inverted it regardless of the clamp.
    const meta = new Map([
      ['weak', { type: 'user' as const, lastSeenAt: NOW }], // +0.1 type, +0.1 recency
      ['strong', { type: 'project' as const, lastSeenAt: new Date(NOW.getTime() - 200 * DAY_MS) }], // +0 type, -0.1 recency
    ]);
    const confirmations = new Map([['weak', 5]]); // +0.15 → weak boost = 1.35
    // Both scores are within the two-branch RRF ceiling (2/61 ≈ 0.0328).
    const fused = [
      { id: 'strong', score: 0.03 },
      { id: 'weak', score: 0.005 },
    ];
    const result = applyRankingBoost(fused, fakeOpts(meta, confirmations));
    expect(result[0]?.id).toBe('strong'); // 0.03·0.9 = 0.027 still beats 0.005·1.35 = 0.00675
  });
});

describe('applyGapRatioFilter', () => {
  it('truncates once a score falls below the gap ratio relative to its predecessor', () => {
    const ranked = [{ score: 1.0 }, { score: 0.9 }, { score: 0.2 }, { score: 0.15 }];
    expect(applyGapRatioFilter(ranked, 0.5)).toEqual([{ score: 1.0 }, { score: 0.9 }]);
  });

  it('keeps the full list when no gap crosses the threshold', () => {
    const ranked = [{ score: 1.0 }, { score: 0.9 }, { score: 0.85 }];
    expect(applyGapRatioFilter(ranked, 0.5)).toEqual(ranked);
  });

  it('keeps a single-row pool unchanged', () => {
    expect(applyGapRatioFilter([{ score: 1 }], 0.9)).toEqual([{ score: 1 }]);
  });
});

describe('applyDiversityCap', () => {
  it('caps at most `cap` rows per session, backfilling from the skipped remainder in order', () => {
    const ranked = [
      { id: 'a1', sessionId: 's1' },
      { id: 'a2', sessionId: 's1' },
      { id: 'a3', sessionId: 's1' },
      { id: 'a4', sessionId: 's1' },
      { id: 'b1', sessionId: 's2' },
    ];
    const result = applyDiversityCap(ranked, 3);
    expect(result.map((r) => r.id)).toEqual(['a1', 'a2', 'a3', 'b1', 'a4']);
  });

  it('never shrinks the result count even when one session dominates the whole pool', () => {
    const ranked = Array.from({ length: 8 }, (_, i) => ({ id: `x${i}`, sessionId: 'only' }));
    const result = applyDiversityCap(ranked, 3);
    expect(result.length).toBe(8);
  });

  it('does not group null-session rows together', () => {
    const ranked = [
      { id: 'n1', sessionId: null },
      { id: 'n2', sessionId: null },
      { id: 'n3', sessionId: null },
      { id: 'n4', sessionId: null },
    ];
    const result = applyDiversityCap(ranked, 3);
    expect(result.map((r) => r.id)).toEqual(['n1', 'n2', 'n3', 'n4']);
  });
});

describe('hybrid search plumbing (FakeEmbedder)', () => {
  let db: TestDb;
  let repos: Repositories;
  let projectId: string;
  let fake: FakeEmbedder;
  let mem: MemoryService;

  const embedAll = async () => {
    const worker = new EmbeddingWorker({ repos, embedder: fake });
    // Drain until empty (more than one batch is unlikely at these sizes).
    let guard = 0;
    while ((await worker.processBatch()).processed > 0 && guard++ < 20) {
      /* keep draining */
    }
  };

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
    projectId = new ProjectsService(repos).create({ slug: 'app' }).id;
    fake = new FakeEmbedder();
    mem = new MemoryService(repos, db.handle.db, undefined, (t) => fake.embed(t));
  });

  afterEach(() => db.cleanup());

  it('dense branch surfaces an exact semantic match (identical text → identical vector)', async () => {
    mem.save(
      { type: 'user', title: 'Alpha beta gamma', content: 'alpha beta gamma' },
      projectScope(projectId),
    );
    mem.save(
      { type: 'user', title: 'Unrelated text here', content: 'unrelated text here' },
      projectScope(projectId),
    );
    await embedAll();
    const results = await mem.search({ query: 'alpha beta gamma' }, projectScope(projectId));
    expect(results[0]!.content).toBe('alpha beta gamma');
  });

  it('isolates scope, status, and type on the hybrid path', async () => {
    const otherId = new ProjectsService(repos).create({ slug: 'other' }).id;
    mem.save(
      { type: 'user', title: 'Shared token here', content: 'shared token here' },
      projectScope(projectId),
    );
    mem.save(
      { type: 'user', title: 'Shared token here', content: 'shared token here' },
      projectScope(otherId),
    );
    const supersededRow = mem.save(
      { type: 'user', title: 'Shared token superseded', content: 'shared token superseded' },
      projectScope(projectId),
    );
    mem.save(
      { type: 'project', title: 'Shared token typed', content: 'shared token typed' },
      projectScope(projectId),
    );
    await embedAll();
    // Flip one to superseded via the memory table → the vec status trigger mirrors it.
    db.handle.raw
      .prepare("UPDATE memory SET status = 'superseded' WHERE id = ?")
      .run(supersededRow.id);

    const res = await mem.search({ query: 'shared token', type: 'user' }, projectScope(projectId));
    const ids = res.map((m) => m.id);
    expect(res.every((m) => m.projectId === projectId)).toBe(true); // scope
    expect(res.every((m) => m.status === 'active')).toBe(true); // status
    expect(res.every((m) => m.type === 'user')).toBe(true); // type
    expect(ids).not.toContain(supersededRow.id);
  });

  it('excludes a row from search results if memory_vec.status is stale, even though the dense branch returned its id', async () => {
    // Simulates the pre-fix race (#257): construct a memory_vec row whose
    // cached `status` disagrees with the live `memory.status`, bypassing
    // the normal insert/sync paths entirely (a raw UPDATE to memory_vec
    // does not go through the memory_vec_status_sync trigger, which is
    // defined ON `memory`, not on `memory_vec`). This proves the search
    // hydration guard — not the trigger, not insertEmbedding — is what
    // keeps a stale vec row from leaking into results.
    const stale = mem.save(
      { type: 'user', title: 'Stale vector token', content: 'stale vector token' },
      projectScope(projectId),
    );
    await embedAll();
    db.handle.raw.prepare("UPDATE memory SET status = 'superseded' WHERE id = ?").run(stale.id);
    db.handle.raw
      .prepare("UPDATE memory_vec SET status = 'active' WHERE memory_id = ?")
      .run(stale.id);

    const res = await mem.search({ query: 'stale vector token' }, projectScope(projectId));
    expect(res.map((m) => m.id)).not.toContain(stale.id);
  });

  it('finds a memory with no embedding via the lexical branch (coverage gap)', async () => {
    mem.save(
      { type: 'user', title: 'Embedded one widget', content: 'embedded one widget' },
      projectScope(projectId),
    );
    const unembedded = mem.save(
      { type: 'user', title: 'Unembedded widget row', content: 'unembedded widget row' },
      projectScope(projectId),
    );
    // Deliberately do NOT embed — dense is blind to it; FTS must still find it.
    const res = await mem.search({ query: 'unembedded widget' }, projectScope(projectId));
    expect(res.map((m) => m.id)).toContain(unembedded.id);
  });

  it('finds a memory by a term present only in its title (FTS indexes title)', async () => {
    const row = mem.save(
      // 'Kubernetes' appears in the title but NOT in the content body.
      {
        type: 'project',
        title: 'Kubernetes deploy notes',
        content: 'rollout steps for the cluster',
      },
      projectScope(projectId),
    );
    // No embedding → the hit can only come from the lexical branch matching title.
    const res = await mem.search({ query: 'Kubernetes' }, projectScope(projectId));
    expect(res.map((m) => m.id)).toContain(row.id);
  });

  it('a malformed lexical query never throws (fault isolation + sanitizer)', async () => {
    mem.save(
      { type: 'user', title: 'C++ pointers and refs', content: 'C++ pointers and refs' },
      projectScope(projectId),
    );
    await embedAll();
    await expect(
      mem.search({ query: 'C++ "unbalanced AND' }, projectScope(projectId)),
    ).resolves.toBeInstanceOf(Array);
  });

  it('tag filters the dense branch (no wrong-tag rows)', async () => {
    const tagged = mem.save(
      {
        type: 'user',
        title: 'Taggable subject matter',
        content: 'taggable subject matter',
        tags: ['keep'],
      },
      projectScope(projectId),
    );
    mem.save(
      { type: 'user', title: 'Taggable subject matter', content: 'taggable subject matter' },
      projectScope(projectId),
    );
    await embedAll();
    const res = await mem.search(
      { query: 'taggable subject matter', tag: 'keep' },
      projectScope(projectId),
    );
    expect(res.map((m) => m.id)).toEqual([tagged.id]);
  });

  it('include_global blends project + global results on the hybrid (query) path', async () => {
    const projectRow = mem.save(
      { type: 'user', title: 'Widget project note', content: 'widget project note' },
      projectScope(projectId),
    );
    const globalRow = mem.save(
      { type: 'user', title: 'Widget global note', content: 'widget global note' },
      SCOPE_GLOBAL,
    );
    await embedAll();

    const withoutGlobal = await mem.search({ query: 'widget note' }, projectScope(projectId));
    expect(withoutGlobal.map((m) => m.id)).toContain(projectRow.id);
    expect(withoutGlobal.map((m) => m.id)).not.toContain(globalRow.id);

    const withGlobal = await mem.search(
      { query: 'widget note', includeGlobal: true },
      projectScope(projectId),
    );
    const ids = withGlobal.map((m) => m.id);
    expect(ids).toContain(projectRow.id);
    expect(ids).toContain(globalRow.id);
  });

  it('include_global blends project + global results on the no-query listing path', async () => {
    const projectRow = mem.save(
      { type: 'user', title: 'Listing project row', content: 'listing project row' },
      projectScope(projectId),
    );
    const globalRow = mem.save(
      { type: 'user', title: 'Listing global row', content: 'listing global row' },
      SCOPE_GLOBAL,
    );

    const withoutGlobal = await mem.search({}, projectScope(projectId));
    expect(withoutGlobal.map((m) => m.id)).not.toContain(globalRow.id);

    const withGlobal = await mem.search({ includeGlobal: true }, projectScope(projectId));
    const ids = withGlobal.map((m) => m.id);
    expect(ids).toContain(projectRow.id);
    expect(ids).toContain(globalRow.id);
  });

  it('a global-scoped search never returns project rows, even with include_global set', async () => {
    mem.save(
      { type: 'user', title: 'Project only widget', content: 'project only widget' },
      projectScope(projectId),
    );
    const globalRow = mem.save(
      { type: 'user', title: 'Global widget note', content: 'global widget note' },
      SCOPE_GLOBAL,
    );
    await embedAll();

    const res = await mem.search({ query: 'widget', includeGlobal: true }, SCOPE_GLOBAL);
    expect(res.every((m) => m.scope === 'global')).toBe(true);
    expect(res.map((m) => m.id)).toContain(globalRow.id);
  });

  it('the no-query listing path is unaffected by the ranking boost (pure chronological order)', async () => {
    const older = mem.save(
      { type: 'user', title: 'Older row', content: 'older row' },
      projectScope(projectId),
    );
    const newer = mem.save(
      { type: 'project', title: 'Newer row', content: 'newer row' },
      projectScope(projectId),
    );
    // Distinct createdAt so ordering can't tie on the same test-tick millisecond.
    db.handle.raw.prepare('UPDATE memory SET created_at = ? WHERE id = ?').run(1_000, older.id);
    db.handle.raw.prepare('UPDATE memory SET created_at = ? WHERE id = ?').run(2_000, newer.id);
    // `older` gets every boost signal; the no-query path must still ignore the boost.
    mem.confirm(older.id, projectScope(projectId), { source: { agent: 'test' } });
    mem.confirm(older.id, projectScope(projectId), { source: { agent: 'test' } });
    mem.confirm(older.id, projectScope(projectId), { source: { agent: 'test' } });

    const res = await mem.search({}, projectScope(projectId));
    const ids = res.map((m) => m.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
  });

  it('degrades to FTS-only when no embedQuery is wired', async () => {
    const ftsOnly = new MemoryService(repos, db.handle.db); // no embedQuery
    ftsOnly.save(
      { type: 'user', title: 'Lexical only lookup', content: 'lexical only lookup' },
      projectScope(projectId),
    );
    await embedAll();
    const res = await ftsOnly.search({ query: 'lexical only' }, projectScope(projectId));
    expect(res.map((m) => m.content)).toContain('lexical only lookup');
  });

  it('with the gates disabled (the default), hybridSearch never abstains', async () => {
    mem.save(
      { type: 'user', title: 'gate default check', content: 'gate default check' },
      projectScope(projectId),
    );
    await embedAll();
    const result = await hybridSearch({
      repos,
      embedQuery: (t) => fake.embed(t),
      query: 'completely unrelated zzz query',
      scope: 'project',
      projectId,
      status: 'active',
      limit: 8,
      offset: 0,
    });
    expect(result.abstained).toBe(false);
  });

  it('an unrelated query abstains once a floor is enabled (no lexical or dense candidate at all)', async () => {
    // No embedder wired — dense contributes nothing, isolating the lexical
    // branch's own "found literally nothing" signal.
    const ftsOnly = new MemoryService(repos, db.handle.db);
    ftsOnly.save(
      {
        type: 'user',
        title: 'kubernetes autoscaling threshold',
        content: 'kubernetes autoscaling threshold',
      },
      projectScope(projectId),
    );
    const result = await hybridSearch({
      repos,
      query: 'completely unrelated topic never mentioned anywhere',
      scope: 'project',
      projectId,
      status: 'active',
      limit: 8,
      offset: 0,
      abstentionFloor: 0.5,
    });
    expect(result.abstained).toBe(true);
    expect(result.ids).toEqual([]);
  });

  it('a sharp exact-phrase query does not abstain once a floor is enabled', async () => {
    mem.save(
      { type: 'user', title: 'exact phrase match probe', content: 'exact phrase match probe' },
      projectScope(projectId),
    );
    const result = await hybridSearch({
      repos,
      query: 'exact phrase match probe',
      scope: 'project',
      projectId,
      status: 'active',
      limit: 8,
      offset: 0,
      abstentionFloor: 0.5,
    });
    expect(result.abstained).toBe(false);
    expect(result.ids.length).toBeGreaterThan(0);
  });
});

describe('hybrid search cross-lingual recall (real embedder)', () => {
  let embedder: Embedder;
  let db: TestDb;
  let repos: Repositories;
  let mem: MemoryService;

  beforeAll(async () => {
    embedder = await loadEmbedder();
  }, 60_000);

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
    mem = new MemoryService(repos, db.handle.db, undefined, (t) => embedder.embed(t));
  });

  afterEach(() => db.cleanup());
  afterAll(() => {
    /* embedder has no teardown */
  });

  it('a Spanish query surfaces an English-stored memory (the motivating bug)', async () => {
    mem.save(
      {
        type: 'user',
        title: 'User prefers black coffee, no sugar',
        content: 'user prefers black coffee, no sugar',
      },
      SCOPE_GLOBAL,
    );
    mem.save(
      {
        type: 'user',
        title: 'Deploys on Fridays after standup',
        content: 'deploys on Fridays after standup',
      },
      SCOPE_GLOBAL,
    );
    const worker = new EmbeddingWorker({ repos, embedder });
    await worker.processBatch();

    // No lexical overlap + punctuation/accents that would crash a naive FTS query.
    const res = await mem.search({ query: '¿cómo toma el café?' }, SCOPE_GLOBAL);
    expect(res.some((m) => m.content.includes('black coffee'))).toBe(true);
  }, 30_000);
});

describe('confirm the exclusion holds (add-entity-index Decision 1 / task 8.1)', () => {
  let db: TestDb;
  let repos: Repositories;
  let mem: MemoryService;

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
    mem = new MemoryService(repos, db.handle.db);
  });

  afterEach(() => db.cleanup());

  it('a plain text query returns identical ordered ids whether or not the memories are entity-linked', async () => {
    const rows = [];
    for (let i = 0; i < 20; i++) {
      rows.push(
        mem.save(
          {
            type: 'feedback',
            title: `Rollout note ${i}`,
            content: `rollout note ${i} covers timezone rotation and on-call handoff for cycle ${i}`,
          },
          SCOPE_GLOBAL,
        ),
      );
    }

    const before = await mem.search({ query: 'rollout timezone rotation' }, SCOPE_GLOBAL);

    // Link every row to entities — the entity index now exists, fully
    // populated — but no fusion stream reads it, so a plain text query
    // must be untouched by its presence.
    for (const r of rows) {
      repos.entities.linkMemory(
        r.id,
        'global',
        null,
        [{ kind: 'ticket', value: 'PROJ-1' }],
        new Date(),
      );
    }

    const after = await mem.search({ query: 'rollout timezone rotation' }, SCOPE_GLOBAL);
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
  });
});
