import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { loadEmbedder, type Embedder } from '../embeddings/embedder.js';
import { createTestDb, FakeEmbedder, type TestDb } from '../test/index.js';

import { EmbeddingWorker } from './embedding-worker.js';
import { applyRankingBoost, fuseRRF, sanitizeFtsQuery } from './hybrid-search.js';
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
    expect(result[0]).toBe('fresh');
  });

  it('never introduces an id absent from the fused pool', () => {
    const meta = new Map([['a', { type: 'user' as const, lastSeenAt: NOW }]]);
    const fused = [{ id: 'a', score: 0.05 }];
    const result = applyRankingBoost(fused, fakeOpts(meta, new Map()));
    expect(result).toEqual(['a']);
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

  it('clamps the boost so it cannot invert a large raw-score gap', () => {
    const meta = new Map([
      ['weak', { type: 'user' as const, lastSeenAt: NOW }],
      ['strong', { type: 'project' as const, lastSeenAt: new Date(NOW.getTime() - 200 * DAY_MS) }],
    ]);
    const confirmations = new Map([['weak', 5]]);
    // Max boost on weak (0.01·1.4) still can't overtake strong (0.1·0.7 floor).
    const fused = [
      { id: 'strong', score: 0.1 },
      { id: 'weak', score: 0.01 },
    ];
    const result = applyRankingBoost(fused, fakeOpts(meta, confirmations));
    expect(result[0]).toBe('strong');
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
    mem.confirm(older.id, projectScope(projectId), { agent: 'test' });
    mem.confirm(older.id, projectScope(projectId), { agent: 'test' });
    mem.confirm(older.id, projectScope(projectId), { agent: 'test' });

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
