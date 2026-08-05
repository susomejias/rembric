import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { loadEmbedder, type Embedder } from '../embeddings/embedder.js';
import { createTestDb, defaultProjectScope, FakeEmbedder, type TestDb } from '../test/index.js';

import { EmbeddingWorker } from './embedding-worker.js';
import {
  ABSTAIN_REASON,
  applyDiversityCap,
  applyRankingBoost,
  applyRelativeLevelFilter,
  computeRankWindowSize,
  EMPTY_POOL_REASON,
  fuseRRF,
  fuseRRFWithScores,
  poolLeader,
  relevanceComponents,
  hybridSearch,
  RANK_CONSTANT,
  RANK_WINDOW_CEILING,
  sanitizeFtsQuery,
  termWeightsFor,
  tokenSet,
  type GateLeader,
  type TermWeightLookup,
} from './hybrid-search.js';
import { MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { projectScope } from './scope.js';

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

/**
 * The evidence that no threshold in RRF space can gate relevance. Pure
 * arithmetic over `RANK_CONSTANT`, so it holds as long as that constant does.
 */
/** The consecutive-pair rule both replaced quantities used, kept as the thing being disproved. */
function consecutiveFilter<T>(ranked: T[], ratio: number, of: (r: T) => number): T[] {
  for (let i = 0; i < ranked.length - 1; i++) {
    const current = of(ranked[i]!);
    if (current <= 0 || of(ranked[i + 1]!) / current < ratio) return ranked.slice(0, i + 1);
  }
  return ranked;
}

describe('RRF scores cannot carry a relevance threshold', () => {
  const rrf = (rank: number) => 1 / (RANK_CONSTANT + rank);

  it('pins the consecutive ratios inside a branch-membership class between 0.9839 and 0.9962', () => {
    expect(rrf(2) / rrf(1)).toBeCloseTo(0.9839, 4);
    expect(rrf(201) / rrf(200)).toBeCloseTo(0.9962, 4);
  });

  it('a both-branches row scores exactly twice a single-branch row at the same rank', () => {
    for (const rank of [1, 8, 60, 200]) {
      expect(rrf(rank) / (2 * rrf(rank))).toBe(0.5);
    }
  });

  it('leaves only two bands, so no ratio can express relevance', () => {
    // The class-boundary ratio is `(60+m)/(2·(61+m))` for m both-branches rows:
    // 0.4919 at m=1, rising to 0.5. Within a class it is 0.9839 upwards. Every
    // ratio therefore lands in one of three regimes and none of them is a
    // statement about match quality.
    const boundary = (m: number) => (RANK_CONSTANT + m) / (2 * (RANK_CONSTANT + m + 1));
    expect(boundary(1)).toBeCloseTo(0.4919, 4);
    expect(boundary(200)).toBeLessThan(0.5);
    expect(rrf(2) / rrf(1)).toBeGreaterThan(boundary(200));
  });

  it('is a three-valued knob: below the boundary band nothing fires, the middle selects branch membership', () => {
    // Two ids found by both branches, five found by one — the only structure
    // an RRF-space ratio can see.
    const both = ['b0', 'b1'];
    const single = ['s0', 's1', 's2', 's3', 's4'];
    const fused = fuseRRFWithScores([both, [...both, ...single]], RANK_CONSTANT);
    expect(fused).toHaveLength(7);

    expect(consecutiveFilter(fused, 0.49, (r) => r.score)).toHaveLength(7);
    expect(consecutiveFilter(fused, 0.7, (r) => r.score).map((r) => r.id)).toEqual(both);
    expect(consecutiveFilter(fused, 0.99, (r) => r.score)).toHaveLength(1);
  });
});

describe('applyRelativeLevelFilter', () => {
  const decaying = [0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3].map((level) => ({ level }));

  it('cuts a gradually decaying tail the consecutive form passed in full', () => {
    const kept = applyRelativeLevelFilter(decaying, 0.9, 0.5);
    expect(kept.map((r) => r.level)).toEqual([0.9, 0.8, 0.7, 0.6, 0.5]);
    expect(kept).toHaveLength(5);
    // Every consecutive step here is >= 0.75, so the old rule kept all seven
    // and returned a row at 33% of the leader.
    expect(consecutiveFilter(decaying, 0.5, (r) => r.level)).toHaveLength(7);
  });

  it('is order-independent over a non-monotone sequence, where truncation is not', () => {
    const nonMonotone = [{ level: 0.9 }, { level: 0.2 }, { level: 0.85 }, { level: 0.8 }];
    expect(applyRelativeLevelFilter(nonMonotone, 0.9, 0.5).map((r) => r.level)).toEqual([
      0.9, 0.85, 0.8,
    ]);
    expect(consecutiveFilter(nonMonotone, 0.5, (r) => r.level)).toHaveLength(1);
  });

  it('is idempotent — refiltering its own output changes nothing', () => {
    const once = applyRelativeLevelFilter(decaying, 0.9, 0.5);
    expect(applyRelativeLevelFilter(once, 0.9, 0.5)).toEqual(once);
  });

  it('keeps the leader itself at any ratio in [0,1]', () => {
    for (const ratio of [0, 0.5, 0.99, 1]) {
      expect(applyRelativeLevelFilter(decaying, 0.9, ratio)[0]).toEqual({ level: 0.9 });
    }
  });
});

/** Every term equal — the degenerate case the weighted fraction must reduce to. */
const EQUAL_WEIGHTS: TermWeightLookup = () => 1;

describe('relevanceComponents', () => {
  const query = tokenSet('alpha beta gamma delta epsilon zeta eta theta');
  const level = (...args: Parameters<typeof relevanceComponents>) =>
    relevanceComponents(...args).level;

  it('scores exactly 1.0 for a row containing every query token', () => {
    expect(
      level(
        query,
        { title: 'alpha beta gamma delta', content: 'epsilon zeta eta theta' },
        undefined,
        EQUAL_WEIGHTS,
      ),
    ).toBe(1);
  });

  it('scores one shared token of eight at exactly 0.125', () => {
    expect(
      level(query, { title: 'unrelated', content: 'alpha only here' }, undefined, EQUAL_WEIGHTS),
    ).toBe(0.125);
  });

  it('scores 0 with no shared token and no dense cosine', () => {
    expect(
      level(query, { title: 'nothing', content: 'in common at all' }, undefined, EQUAL_WEIGHTS),
    ).toBe(0);
  });

  it('takes the dense cosine when it exceeds coverage, and coverage when it does not', () => {
    const row = { title: 'unrelated', content: 'alpha only here' }; // coverage 0.125
    expect(level(query, row, 0.82, EQUAL_WEIGHTS)).toBe(0.82);
    expect(level(query, row, 0.05, EQUAL_WEIGHTS)).toBe(0.125);
  });

  it('is bounded above by 1 even for a row far longer than the query', () => {
    const padded = {
      title: 'alpha beta gamma delta',
      content: `epsilon zeta eta theta ${'x '.repeat(5000)}`,
    };
    expect(level(query, padded, undefined, EQUAL_WEIGHTS)).toBe(1);
  });
});

describe('poolLeader', () => {
  const leveled = [
    { id: 'a', level: 0.2 },
    { id: 'b', level: 0.9 },
    { id: 'c', level: 0.4 },
  ];
  const scored = new Map([
    ['a', { coverage: 0.2, cosine: 0.0 }],
    ['b', { coverage: 0.1, cosine: 0.9 }],
    ['c', { coverage: 0.4, cosine: 0.3 }],
  ]);

  it('is the pool maximum, which is not the first row when fusion ordered a weak row first', () => {
    expect(poolLeader(leveled, scored).level).toBe(0.9);
  });

  it('is order-independent', () => {
    expect(poolLeader([...leveled].reverse(), scored)).toEqual(poolLeader(leveled, scored));
  });

  // The previous shape reported per-component maxima over DIFFERENT rows while
  // the spec instructs a reader to take them as one row's pair: here the
  // highest coverage in the pool is c's 0.4, which must NOT be reported.
  it("reports the leader row's own two components, not each component's pool maximum", () => {
    expect(poolLeader(leveled, scored)).toEqual({ level: 0.9, coverage: 0.1, cosine: 0.9 });
  });

  it('resolves a tie to the earliest row in fused order', () => {
    const tied = [
      { id: 'a', level: 0.5 },
      { id: 'b', level: 0.5 },
    ];
    const comps = new Map([
      ['a', { coverage: 0.5, cosine: 0.1 }],
      ['b', { coverage: 0.2, cosine: 0.5 }],
    ]);
    expect(poolLeader(tied, comps).coverage).toBe(0.5);
  });

  it('is 0 for an empty pool', () => {
    expect(poolLeader([], scored)).toEqual({ level: 0, coverage: 0, cosine: 0 });
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

  it('no argument admits another scope on the hybrid (query) path', async () => {
    const projectRow = mem.save(
      { type: 'user', title: 'Widget project note', content: 'widget project note' },
      projectScope(projectId),
    );
    const otherRow = mem.save(
      { type: 'user', title: 'Widget other note', content: 'widget other note' },
      defaultProjectScope(db.handle),
    );
    await embedAll();

    const scoped = await mem.search({ query: 'widget note' }, projectScope(projectId));
    expect(scoped.map((m) => m.id)).toContain(projectRow.id);
    expect(scoped.map((m) => m.id)).not.toContain(otherRow.id);

    // The control: the excluded row is retrievable in its own scope, so the
    // exclusion above is the scope predicate rather than a failed index.
    const own = await mem.search({ query: 'widget note' }, defaultProjectScope(db.handle));
    expect(own.map((m) => m.id)).toContain(otherRow.id);
  });

  it('no argument admits another scope on the no-query listing path', async () => {
    const projectRow = mem.save(
      { type: 'user', title: 'Listing project row', content: 'listing project row' },
      projectScope(projectId),
    );
    const otherRow = mem.save(
      { type: 'user', title: 'Listing other row', content: 'listing other row' },
      defaultProjectScope(db.handle),
    );

    const scoped = await mem.search({}, projectScope(projectId));
    expect(scoped.map((m) => m.id)).toContain(projectRow.id);
    expect(scoped.map((m) => m.id)).not.toContain(otherRow.id);

    const own = await mem.search({}, defaultProjectScope(db.handle));
    expect(own.map((m) => m.id)).toContain(otherRow.id);
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

  it('with the gates disabled (the default), a NON-EMPTY fused pool never abstains', async () => {
    mem.save(
      { type: 'user', title: 'gate default check', content: 'gate default check' },
      projectScope(projectId),
    );
    await embedAll();
    const result = await hybridSearch({
      repos,
      embedQuery: (t) => fake.embed(t),
      query: 'completely unrelated zzz query',
      scope: projectScope(projectId),
      status: 'active',
      limit: 8,
      offset: 0,
    });
    // The dense branch has no distance floor, so the unrelated query still pools
    // the row — which is what makes this an assertion about the gates and not
    // about an empty pool (that case abstains, below).
    expect(result.ids.length).toBeGreaterThan(0);
    expect(result.abstained).toBe(false);
    expect(result.abstainReason).toBeUndefined();
  });

  it('abstains with the empty-pool reason when both branches return nothing, gates untouched', async () => {
    const ftsOnly = new MemoryService(repos, db.handle.db);
    ftsOnly.save(
      { type: 'user', title: 'nothing in common', content: 'nothing in common' },
      projectScope(projectId),
    );
    const result = await hybridSearch({
      repos,
      query: 'zzzqqq wwwvvv',
      scope: projectScope(projectId),
      status: 'active',
      limit: 8,
      offset: 0,
    });
    expect(result.abstained).toBe(true);
    expect(result.ids).toEqual([]);
    expect(result.abstainReason).toBe(EMPTY_POOL_REASON);
    expect(result.gateShortened).toBeUndefined();
  });

  it('abstains on an empty pool without reading term statistics or pool text', async () => {
    const ftsOnly = new MemoryService(repos, db.handle.db);
    ftsOnly.save(
      { type: 'user', title: 'nothing in common', content: 'nothing in common' },
      projectScope(projectId),
    );
    const textByIds = vi.spyOn(repos.memory, 'textByIds');
    const documentCount = vi.spyOn(repos.termStatistics, 'adminDocumentCount');
    const result = await hybridSearch({
      repos,
      query: 'zzzqqq wwwvvv',
      scope: projectScope(projectId),
      status: 'active',
      limit: 8,
      offset: 0,
    });
    expect(result.abstained).toBe(true);
    // "While BOTH gates are disabled the branch SHALL perform no gate-related
    // work at all" (memory/spec.md) — the verdict is a length check on an array
    // already in hand.
    expect(textByIds).not.toHaveBeenCalled();
    expect(documentCount).not.toHaveBeenCalled();
    textByIds.mockRestore();
    documentCount.mockRestore();
  });

  it('still feeds the calibration sweep on an empty pool, with the live term statistics', async () => {
    const ftsOnly = new MemoryService(repos, db.handle.db);
    ftsOnly.save(
      { type: 'user', title: 'nothing in common', content: 'nothing in common' },
      projectScope(projectId),
    );
    let leader: GateLeader | undefined;
    const result = await hybridSearch({
      repos,
      query: 'zzzqqq wwwvvv',
      scope: projectScope(projectId),
      status: 'active',
      limit: 8,
      offset: 0,
      onGateWindow: (l) => {
        leader = l;
      },
    });
    expect(result.abstained).toBe(true);
    expect(leader?.poolSize).toBe(0);
    expect(leader?.level).toBe(0);
    // The df list is why the sink is called at all here: it shows which query
    // terms the index does not hold, which is why the pool is empty.
    expect(leader?.documentCount).toBeGreaterThan(0);
    expect([...(leader?.documentFrequencies.keys() ?? [])]).toContain('zzzqqq');
  });

  it('abstains with the empty-pool reason on a type filter that excludes every row', async () => {
    mem.save(
      { type: 'user', title: 'filter probe row', content: 'filter probe row content' },
      projectScope(projectId),
    );
    await embedAll();
    const shared = {
      repos,
      embedQuery: (t: string) => fake.embed(t),
      query: 'filter probe',
      scope: projectScope(projectId),
      status: 'active' as const,
      limit: 8,
      offset: 0,
    };
    // Control: the same query without the filter pools the row, so the
    // abstention below is the filter's doing and not a broken probe.
    const unfiltered = await hybridSearch(shared);
    expect(unfiltered.ids.length).toBeGreaterThan(0);
    expect(unfiltered.abstained).toBe(false);

    const filtered = await hybridSearch({ ...shared, type: 'procedural' });
    expect(filtered.ids).toEqual([]);
    expect(filtered.abstained).toBe(true);
    expect(filtered.abstainReason).toBe(EMPTY_POOL_REASON);
  });

  it('abstains with the empty-pool reason in an empty scope', async () => {
    const emptyProject = new ProjectsService(repos).create({ slug: 'empty' }).id;
    const result = await hybridSearch({
      repos,
      embedQuery: (t) => fake.embed(t),
      query: 'anything at all',
      scope: projectScope(emptyProject),
      status: 'active',
      limit: 8,
      offset: 0,
    });
    expect(result.ids).toEqual([]);
    expect(result.abstained).toBe(true);
    expect(result.abstainReason).toBe(EMPTY_POOL_REASON);
  });
});

/**
 * The gate decision itself, with a non-empty candidate set on BOTH sides of
 * every assertion. No embedder is wired, so `level` is the lexical component
 * alone; it is IDF-weighted against the live index, so each threshold below is
 * placed relative to a level READ from that index rather than to a memorised
 * constant that only held while coverage was unweighted.
 */
const relevanceLevel = (...args: Parameters<typeof relevanceComponents>) =>
  relevanceComponents(...args).level;

describe('the relevance gates discriminate (no embedder — level is the lexical component)', () => {
  const QUERY = 'kubernetes autoscaling threshold for the nimbus scheduler'; // 7 distinct tokens
  const WEAK = { title: 'The nimbus scheduler', content: 'the nimbus scheduler runs jobs' }; // 3/7
  const STRONG = {
    title: 'Kubernetes autoscaling threshold',
    content: 'the threshold for the nimbus scheduler under kubernetes autoscaling',
  }; // 7/7

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

  const search = (over: Partial<Parameters<typeof hybridSearch>[0]>) =>
    hybridSearch({
      repos,
      query: QUERY,
      scope: projectScope(projectId),
      status: 'active',
      limit: 8,
      offset: 0,
      ...over,
    });

  /** The level the search itself would compute: same terms and weights, read from the live index. */
  const liveLevel = (row: { title: string; content: string }, query = QUERY): number => {
    const frequencies = repos.termStatistics.adminQueryTermFrequencies(query);
    return relevanceLevel(
      new Set(frequencies.keys()),
      row,
      undefined,
      termWeightsFor(repos.termStatistics.adminDocumentCount(), frequencies),
    );
  };

  it('pins the two levels the thresholds below are placed around', () => {
    const q = tokenSet(QUERY);
    // Degenerate case: with every term equally weighted the level is the plain
    // token fraction, which is what the thresholds below used to be placed around.
    expect(relevanceLevel(q, WEAK, undefined, EQUAL_WEIGHTS)).toBeCloseTo(3 / 7, 10);
    expect(relevanceLevel(q, STRONG, undefined, EQUAL_WEIGHTS)).toBe(1);

    // Against the live (here empty) index every term is `df = 0`, so the two
    // agree — and the tests below still read the live value rather than these.
    mem.save({ type: 'project', ...WEAK }, projectScope(projectId));
    expect(liveLevel(STRONG)).toBe(1);
    expect(liveLevel(WEAK)).toBeLessThan(1);
  });

  it('abstains on a weak leader and returns it at a floor below that same level', async () => {
    mem.save({ type: 'project', ...WEAK }, projectScope(projectId));
    const weakLevel = liveLevel(WEAK);
    expect(weakLevel).toBeGreaterThan(0.05);
    expect(weakLevel).toBeLessThan(0.95);

    const above = await search({ abstentionFloor: weakLevel + 0.05 });
    expect(above.abstained).toBe(true);
    expect(above.ids).toEqual([]);

    // Same corpus, same query, same non-empty candidate set — only the floor moved.
    const below = await search({ abstentionFloor: weakLevel - 0.05 });
    expect(below.abstained).toBe(false);
    expect(below.ids).toHaveLength(1);
  });

  it('does not abstain at the same floor once a strong row joins the same window', async () => {
    mem.save({ type: 'project', ...WEAK }, projectScope(projectId));
    const strong = mem.save({ type: 'project', ...STRONG }, projectScope(projectId));

    // Above the weak row's level and at/below the strong row's 1.0.
    const result = await search({ abstentionFloor: liveLevel(WEAK) + 0.05 });
    expect(result.abstained).toBe(false);
    expect(result.ids).toContain(strong.id);
  });

  it('passes a leader whose level exactly equals the floor', async () => {
    // Pins the comparison as `level < floor` and not `<=`, at whatever level
    // the live index gives this row.
    const query = 'alpha beta gamma delta';
    const row = { title: 'Alpha notes', content: 'alpha and beta only' };
    mem.save({ type: 'project', ...row }, projectScope(projectId));
    const level = liveLevel(row, query);
    expect(level).toBeGreaterThan(0);
    expect(level).toBeLessThan(1);

    const atFloor = await search({ query, abstentionFloor: level });
    expect(atFloor.abstained).toBe(false);
    expect(atFloor.ids).toHaveLength(1);

    const justAbove = await search({ query, abstentionFloor: level * (1 + 1e-9) });
    expect(justAbove.abstained).toBe(true);
  });

  it('measures the floor against the window maximum, not the fusion leader', async () => {
    // `weak` is returned by BOTH branches so RRF ranks it first; `strong` is
    // lexical-only and ranks behind it while carrying full coverage.
    const fake = new FakeEmbedder();
    const embedded = new MemoryService(repos, db.handle.db, undefined, (t) => fake.embed(t));
    const weakText = { title: 'Nimbus roster', content: 'nimbus roster of on-call names' }; // 1/7
    const weak = embedded.save({ type: 'project', ...weakText }, projectScope(projectId));
    const strong = mem.save({ type: 'project', ...STRONG }, projectScope(projectId)); // 7/7
    const worker = new EmbeddingWorker({ repos, embedder: fake });
    while ((await worker.processBatch()).processed > 0) {
      /* only `weak` is queued: `mem` has no embedQuery */
    }

    const q = tokenSet(QUERY);
    expect(relevanceLevel(q, weakText, undefined, EQUAL_WEIGHTS)).toBeCloseTo(1 / 7, 10);
    expect(relevanceLevel(q, STRONG, undefined, EQUAL_WEIGHTS)).toBe(1);

    const embedQuery = (t: string) => fake.embed(t);
    // `relativeLevelRatio: null` is explicit: this test isolates the FLOOR, and
    // inheriting a shipped ratio would let a second mechanism move the result.
    const ungated = await search({ embedQuery, relativeLevelRatio: null });
    expect(ungated.ids[0]).toBe(weak.id); // fusion put the weak row first

    // Pool max = 1.0 clears the floor; the fusion leader's own 0.143 would not.
    const gated = await search({ embedQuery, abstentionFloor: 0.6, relativeLevelRatio: null });
    expect(gated.abstained).toBe(false);
    expect(gated.ids).toContain(strong.id);
  });

  it('a page shortened by the relative filter reports abstained:false', async () => {
    const { strong, cuts } = fourRowPool();

    const result = await search({ relativeLevelRatio: cuts.removes });
    expect(result.abstained).toBe(false);
    expect(result.ids).toEqual([strong.id]);

    // The same pool is returned whole at a ratio under the weak rows' level.
    const loose = await search({ relativeLevelRatio: cuts.keepsAll });
    expect(loose.ids).toHaveLength(4);
  });

  it('only the floor sets abstained:true — the relative filter never does, even at ratio 1', async () => {
    fourRowPool();
    const result = await search({ relativeLevelRatio: 1 });
    expect(result.abstained).toBe(false);
    expect(result.ids).toHaveLength(1);
  });

  it('filters before the page slice, so page 2 can be empty while page 1 was full — and that is not an abstention', async () => {
    const { survivors, cut } = twoSurvivorPool();
    const page1 = await search({ relativeLevelRatio: cut, limit: 2, offset: 0 });
    expect(page1.ids).toHaveLength(2); // full
    expect(new Set(page1.ids)).toEqual(new Set(survivors));

    const page2 = await search({ relativeLevelRatio: cut, limit: 2, offset: 2 });
    expect(page2.ids).toEqual([]); // short/empty because only two rows were relevant
    expect(page2.abstained).toBe(false);

    // Without the filter the same page 2 is populated, so the emptiness is the
    // filter's doing and not corpus exhaustion. `null` explicitly: inheriting
    // the shipped ratio would leave the filter on and make this no control.
    const page2Ungated = await search({ relativeLevelRatio: null, limit: 2, offset: 2 });
    expect(page2Ungated.ids).toHaveLength(2);

    // The gate IS the cause of the empty page 2, so the flag fires there too.
    expect(page2.gateShortened).toBe(true);
    expect(page2Ungated.gateShortened).toBeUndefined();
  });

  describe('gateShortened fires on cause AND effect, never on one alone', () => {
    it('the filter removed rows and the page is short — the flag fires', async () => {
      const { strong, cuts } = fourRowPool();
      const result = await search({ relativeLevelRatio: cuts.removes, limit: 8 });
      expect(result.ids).toEqual([strong.id]);
      expect(result.gateShortened).toBe(true);
      expect(result.abstained).toBe(false);
    });

    it('the filter removed rows but the page is full — no flag', async () => {
      const { strong, cuts } = fourRowPool();
      const result = await search({ relativeLevelRatio: cuts.removes, limit: 1 });
      expect(result.ids).toEqual([strong.id]);
      expect(result.gateShortened).toBeUndefined();
    });

    it('the page is short but the filter removed nothing — no flag', async () => {
      const { cuts } = fourRowPool();
      const result = await search({ relativeLevelRatio: cuts.keepsAll, limit: 8 });
      expect(result.ids).toHaveLength(4);
      expect(result.gateShortened).toBeUndefined();
    });

    it('the page is full and the filter removed nothing — no flag', async () => {
      const { cuts } = fourRowPool();
      const result = await search({ relativeLevelRatio: cuts.keepsAll, limit: 4 });
      expect(result.ids).toHaveLength(4);
      expect(result.gateShortened).toBeUndefined();
    });

    it('the filter disabled removes nothing, so a short page carries no flag', async () => {
      fourRowPool();
      const result = await search({ relativeLevelRatio: null, limit: 8 });
      expect(result.ids).toHaveLength(4);
      expect(result.gateShortened).toBeUndefined();
    });

    it('survives the service layer, including on an empty page past the survivors', async () => {
      const { survivors, cut } = twoSurvivorPool();

      const page1 = await mem.searchWithAbstention(
        { query: QUERY, limit: 2, offset: 0 },
        projectScope(projectId),
        { relativeLevelRatio: cut },
      );
      expect(page1.memories.map((m) => m.id).sort()).toEqual([...survivors].sort());
      expect(page1.gateShortened).toBeUndefined(); // full page

      const page2 = await mem.searchWithAbstention(
        { query: QUERY, limit: 2, offset: 2 },
        projectScope(projectId),
        { relativeLevelRatio: cut },
      );
      expect(page2.memories).toEqual([]);
      expect(page2.abstained).toBe(false);
      expect(page2.gateShortened).toBe(true);
    });

    it('never reports both an abstention and a shortening, even at ratio 1', async () => {
      fourRowPool();
      const filtered = await search({ relativeLevelRatio: 1, limit: 8 });
      expect(filtered.gateShortened).toBe(true);
      expect(filtered.abstained).toBe(false);

      // The other half of the disjointness: an empty pool gives the filter
      // nothing to remove, so the flag cannot accompany the abstention.
      const empty = await search({ query: 'zzzqqq wwwvvv', relativeLevelRatio: 1 });
      expect(empty.abstained).toBe(true);
      expect(empty.gateShortened).toBeUndefined();
    });
  });

  it('names each abstention cause with its own reason', async () => {
    mem.save({ type: 'project', ...WEAK }, projectScope(projectId));
    const floor = await search({ abstentionFloor: liveLevel(WEAK) + 0.05 });
    expect(floor.abstained).toBe(true);
    expect(floor.abstainReason).toBe(ABSTAIN_REASON);

    const emptyPool = await search({ query: 'zzzqqq wwwvvv' });
    expect(emptyPool.abstained).toBe(true);
    expect(emptyPool.abstainReason).toBe(EMPTY_POOL_REASON);

    expect(emptyPool.abstainReason).not.toBe(floor.abstainReason);
  });

  const saveWeakRows = (n: number) => {
    for (let i = 0; i < n; i++) {
      mem.save(
        { type: 'project', title: `Weak ${i}`, content: WEAK.content },
        projectScope(projectId),
      );
    }
  };

  /**
   * STRONG at level 1.0 plus three weak rows, so a ratio can be placed between
   * them. leaderLevel is the strong row's 1.0, so a cut IS the ratio — and both
   * cuts are placed around the weak rows' LIVE level rather than a constant, so
   * they follow the level function instead of having to be retuned with it.
   */
  const fourRowPool = () => {
    const strong = mem.save({ type: 'project', ...STRONG }, projectScope(projectId));
    saveWeakRows(3);
    const weak = liveLevel({ title: 'Weak 0', content: WEAK.content });
    expect(liveLevel(STRONG)).toBe(1);
    expect(weak).toBeGreaterThan(0.05);
    expect(weak).toBeLessThan(0.95);
    return { strong, cuts: { removes: weak + 0.05, keepsAll: weak - 0.05 } };
  };

  /** Two rows at the leader's level plus three weak ones, so `cut` leaves exactly two. */
  const twoSurvivorPool = () => {
    const survivors = [
      mem.save({ type: 'project', ...STRONG }, projectScope(projectId)).id,
      mem.save(
        { type: 'project', title: STRONG.title, content: STRONG.content },
        projectScope(projectId),
      ).id,
    ];
    saveWeakRows(3);
    return { survivors, cut: liveLevel({ title: 'Weak 0', content: WEAK.content }) + 0.05 };
  };

  // The gate levels the WHOLE fused pool. Asserted on the row set actually read
  // rather than on a verdict, because the two are only loosely coupled: a
  // `limit + offset + margin` prefix silently levels fewer rows, and whether
  // that changes the verdict then depends on where fusion happened to put the
  // best row. This pins the mechanism instead of one corpus's luck.
  const fillPool = (n: number) => {
    for (let i = 0; i < n; i++) {
      mem.save(
        {
          type: 'project',
          title: `Filler ${i}`,
          content: `the nimbus scheduler filler row ${i} for padding`,
        },
        projectScope(projectId),
      );
    }
  };

  it('levels every fused candidate, at every offset, not a page-sized prefix of them', async () => {
    mem.save({ type: 'project', ...STRONG }, projectScope(projectId));
    fillPool(40);
    const textByIds = vi.spyOn(repos.memory, 'textByIds');

    for (const offset of [0, 8, 24]) {
      textByIds.mockClear();
      let reported = 0;
      await search({
        abstentionFloor: 0.6,
        offset,
        onGateWindow: (l) => {
          reported = l.poolSize;
        },
      });
      expect(textByIds).toHaveBeenCalledTimes(1);
      const read = textByIds.mock.calls[0]![0].ids.length;
      expect(read, `offset ${offset} reads the whole pool`).toBe(reported);
      expect(read, `offset ${offset} pool is the full candidate set`).toBe(41);
    }
    textByIds.mockRestore();
  });

  it('reaches the same abstention verdict at every offset', async () => {
    mem.save({ type: 'project', ...WEAK }, projectScope(projectId));
    fillPool(40);

    for (const offset of [0, 8, 16, 24, 32]) {
      const page = await search({ abstentionFloor: 0.6, offset });
      expect(page.abstained, `offset ${offset}`).toBe(true);
      expect(page.ids, `offset ${offset}`).toEqual([]);
    }
  });

  it('reaches the same gate decision after 500 unrelated rows, where the replaced quantity has no range at all', async () => {
    mem.save({ type: 'project', ...WEAK }, projectScope(projectId));
    const level = () => relevanceLevel(tokenSet(QUERY), WEAK, undefined, EQUAL_WEIGHTS);
    /** The deleted `normalizeLexicalScore`, recomputed here to show what it could not express. */
    const normalizedLexicalLeader = () => {
      const rank = repos.memory.searchBm25Ids({
        matchExpr: sanitizeFtsQuery(QUERY),
        scope: projectScope(projectId),
        status: 'active',
        limit: 400,
      })[0]!.rank;
      return 1 / (1 + Math.exp(rank));
    };

    const before = await search({ abstentionFloor: 0.6 });
    const levelBefore = level();
    const normalizedBefore = normalizedLexicalLeader();

    for (let i = 0; i < 500; i++) {
      mem.save(
        {
          type: 'project',
          title: `Filler ${i}`,
          content: `the nimbus scheduler filler row ${i} for padding`,
        },
        projectScope(projectId),
      );
    }

    const after = await search({ abstentionFloor: 0.6 });
    expect(after.abstained).toBe(before.abstained);
    expect(after.abstained).toBe(true);
    expect(level()).toBe(levelBefore);
    expect(levelBefore).toBeCloseTo(3 / 7, 10);

    // Why a floor over the level can work and a floor over the old quantity
    // cannot: the whole observable range of the latter is under 1e-5 wide and
    // pinned just above 0.5, at both corpus sizes.
    for (const v of [normalizedBefore, normalizedLexicalLeader()]) {
      expect(v).toBeGreaterThan(0.5);
      expect(v).toBeLessThan(0.50001);
    }
  }, 30_000);
});

// The tests around the gates pass their values EXPLICITLY so they test the
// mechanism rather than the shipped configuration. That leaves nothing watching
// the configuration itself, so this pins it: `memory/spec.md` requires a
// committed sweep before a gate is enabled, and this is what makes a silent
// change to one visible in review.
describe('the shipped gate configuration', () => {
  it('ships the floor disabled and the relative filter at its swept value', async () => {
    const mod = await import('./hybrid-search.js');
    expect(mod.ABSTENTION_FLOOR).toBe(null);
    expect(mod.RELATIVE_LEVEL_RATIO).toBe(0.4);
  });
});

describe('the disabled path does no gate work', () => {
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

  /** Records every `repos.memory` method name `hybridSearch` reaches for. */
  function countingRepos(): { repos: Repositories; calls: string[] } {
    const calls: string[] = [];
    const counting = <T extends object>(target: T): T =>
      new Proxy(target, {
        get(t, prop, receiver) {
          const value = Reflect.get(t, prop, receiver) as unknown;
          if (typeof value !== 'function') return value;
          return (...args: unknown[]) => {
            calls.push(String(prop));
            return (value as (...a: unknown[]) => unknown).apply(t, args);
          };
        },
      });
    return {
      repos: {
        ...repos,
        memory: counting(repos.memory),
        termStatistics: counting(repos.termStatistics),
      },
      calls,
    };
  }

  it('issues exactly the pre-change reads and never the gate window text read', async () => {
    for (let i = 0; i < 12; i++) {
      mem.save(
        {
          type: 'project',
          title: `Rollout ${i}`,
          content: `rollout note ${i} on timezone rotation`,
        },
        projectScope(projectId),
      );
    }
    const { repos: counting, calls } = countingRepos();
    // Both gates passed as `null` EXPLICITLY. This test's subject is the
    // mechanism — disabled gates issue no extra read — not the current value of
    // the shipped constants. Reading them from the module made it fail the day
    // one gate was enabled on evidence, which is a legitimate change.
    await hybridSearch({
      repos: counting,
      query: 'rollout timezone rotation',
      scope: projectScope(projectId),
      status: 'active',
      limit: 8,
      offset: 0,
      abstentionFloor: null,
      relativeLevelRatio: null,
    });
    // One lexical read plus the boost's two metadata reads. An exact list, not a
    // `not.toContain`, so a second new read added later fails here too. The
    // proxy covers `termStatistics` as well as `memory`, so the level's term
    // lookups would show up here if the disabled path reached them.
    expect(calls).toEqual(['searchBm25Ids', 'rankingMetadataByIds', 'confirmationCountsByIds']);
    for (const read of ['textByIds', 'adminDocumentCount', 'adminQueryTermFrequencies'])
      expect(calls).not.toContain(read);
  });

  it('issues both of them the moment either gate is enabled — so the list above is a decision', async () => {
    mem.save(
      { type: 'project', title: 'Rollout 0', content: 'rollout note on timezone rotation' },
      projectScope(projectId),
    );
    const { repos: counting, calls } = countingRepos();
    await hybridSearch({
      repos: counting,
      query: 'rollout timezone rotation',
      scope: projectScope(projectId),
      status: 'active',
      limit: 8,
      offset: 0,
      abstentionFloor: null,
      relativeLevelRatio: 0.4,
    });
    for (const read of ['textByIds', 'adminDocumentCount', 'adminQueryTermFrequencies'])
      expect(calls).toContain(read);
  });

  it('returns the ids the pre-gate pipeline produces, reconstructed from its surviving parts', async () => {
    const saved = [];
    for (let i = 0; i < 12; i++) {
      saved.push(
        mem.save(
          {
            type: i % 2 === 0 ? 'project' : 'user',
            title: `Rollout ${i}`,
            content: `rollout note ${i} on timezone rotation and on-call handoff`,
          },
          projectScope(projectId),
        ),
      );
    }
    // Give one row every boost signal, so the oracle has to agree about the
    // boost too rather than only about fusion order.
    mem.confirm(saved[7]!.id, projectScope(projectId), { source: { agent: 'test' } });
    mem.confirm(saved[7]!.id, projectScope(projectId), { source: { agent: 'test' } });
    mem.confirm(saved[7]!.id, projectScope(projectId), { source: { agent: 'test' } });

    const opts = {
      repos,
      query: 'rollout timezone rotation handoff',
      scope: projectScope(projectId),
      status: 'active' as const,
      limit: 8,
      offset: 0,
      now: () => new Date('2026-01-01T00:00:00.000Z'),
    };

    // No embedder is wired, so the dense list is empty and the whole
    // pre-change pipeline is reproducible here: FTS ids -> RRF -> boost -> slice.
    const lexicalIds = repos.memory
      .searchBm25Ids({
        matchExpr: sanitizeFtsQuery(opts.query),
        scope: projectScope(projectId),
        status: 'active',
        limit: computeRankWindowSize(opts.limit, opts.offset),
      })
      .map((r) => r.id);
    const expected = applyRankingBoost(fuseRRFWithScores([[], lexicalIds], RANK_CONSTANT), opts)
      .map((r) => r.id)
      .slice(0, 8);

    const result = await hybridSearch(opts);
    expect(result.ids).toEqual(expected);
    expect(result.ids).toHaveLength(8);
    expect(result.abstained).toBe(false);
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
      defaultProjectScope(db.handle),
    );
    mem.save(
      {
        type: 'user',
        title: 'Deploys on Fridays after standup',
        content: 'deploys on Fridays after standup',
      },
      defaultProjectScope(db.handle),
    );
    const worker = new EmbeddingWorker({ repos, embedder });
    await worker.processBatch();

    // No lexical overlap + punctuation/accents that would crash a naive FTS query.
    const res = await mem.search({ query: '¿cómo toma el café?' }, defaultProjectScope(db.handle));
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
          defaultProjectScope(db.handle),
        ),
      );
    }

    const before = await mem.search(
      { query: 'rollout timezone rotation' },
      defaultProjectScope(db.handle),
    );

    // Link every row to entities — the entity index now exists, fully
    // populated — but no fusion stream reads it, so a plain text query
    // must be untouched by its presence.
    for (const r of rows) {
      repos.entities.linkMemory(
        r.id,
        defaultProjectScope(db.handle).projectId,
        [{ kind: 'ticket', value: 'PROJ-1' }],
        new Date(),
      );
    }

    const after = await mem.search(
      { query: 'rollout timezone rotation' },
      defaultProjectScope(db.handle),
    );
    expect(after.map((m) => m.id)).toEqual(before.map((m) => m.id));
  });
});
