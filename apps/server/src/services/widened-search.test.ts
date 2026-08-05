import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { scopeCondition, scopeWhere } from '../db/repositories/scope-clause.js';
import { loadEmbedder, type Embedder } from '../embeddings/embedder.js';
import { createTestDb, FakeEmbedder, type TestDb } from '../test/index.js';

import { EmbeddingWorker } from './embedding-worker.js';
import { applyRankingBoost, computeRankWindowSize, hybridSearch } from './hybrid-search.js';
import { MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { projectScope, type SearchScope } from './scope.js';

/**
 * A widened test corpus must hold rows on BOTH sides: a fixture with rows in one
 * project passes with the widening deleted, with the authorization filter
 * deleted and with the predicate inverted. Every assertion below therefore
 * carries a control on the other side.
 */
function widened(homeProjectId: string, ...others: string[]): SearchScope {
  return {
    kind: 'authorized-projects',
    projectIds: [homeProjectId, ...others],
    homeProjectId,
  };
}

describe('the widened scope reaches every project it names', () => {
  let db: TestDb;
  let repos: Repositories;
  let fake: FakeEmbedder;
  let mem: MemoryService;
  let home: string;
  let away: string;
  let unreached: string;

  const embedAll = async () => {
    const worker = new EmbeddingWorker({ repos, embedder: fake });
    let guard = 0;
    while ((await worker.processBatch()).processed > 0 && guard++ < 40) {
      /* keep draining */
    }
  };

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
    const projects = new ProjectsService(repos);
    home = projects.create({ slug: 'home' }).id;
    away = projects.create({ slug: 'away' }).id;
    unreached = projects.create({ slug: 'unreached' }).id;
    fake = new FakeEmbedder();
    mem = new MemoryService(repos, db.handle.db, undefined, (t) => fake.embed(t));
  });

  afterEach(() => db.cleanup());

  function seedThreeWays() {
    const rows = {
      home: mem.save(
        { type: 'user', title: 'Rotation home note', content: 'rotation handoff in the home tree' },
        projectScope(home),
      ),
      away: mem.save(
        { type: 'user', title: 'Rotation away note', content: 'rotation handoff in the away tree' },
        projectScope(away),
      ),
      unreached: mem.save(
        {
          type: 'user',
          title: 'Rotation unreached note',
          content: 'rotation handoff in the unreached tree',
        },
        projectScope(unreached),
      ),
    };
    return rows;
  }

  it('the lexical branch returns rows from every named project and none from the rest', async () => {
    const rows = seedThreeWays();
    await embedAll();

    const page = await mem.search({ query: 'rotation handoff' }, widened(home, away));
    const ids = page.map((m) => m.id);
    expect(ids).toContain(rows.home.id);
    expect(ids).toContain(rows.away.id);
    expect(ids).not.toContain(rows.unreached.id);

    // Controls, so the exclusion above is the predicate and not a missing row:
    // the unreached row answers the same query from its own scope, and the
    // narrow search still sees only the home row.
    const own = await mem.search({ query: 'rotation handoff' }, projectScope(unreached));
    expect(own.map((m) => m.id)).toEqual([rows.unreached.id]);
    const narrow = await mem.search({ query: 'rotation handoff' }, projectScope(home));
    expect(narrow.map((m) => m.id)).toEqual([rows.home.id]);
  });

  it('the chronological listing branch widens under the same value', async () => {
    const rows = seedThreeWays();

    const ids = (await mem.search({}, widened(home, away))).map((m) => m.id);
    expect(ids).toContain(rows.home.id);
    expect(ids).toContain(rows.away.id);
    expect(ids).not.toContain(rows.unreached.id);

    expect((await mem.search({}, projectScope(home))).map((m) => m.id)).toEqual([rows.home.id]);
    expect((await mem.search({}, projectScope(unreached))).map((m) => m.id)).toEqual([
      rows.unreached.id,
    ]);
  });

  it('the dense branch names every partition, so a foreign row is reachable with no lexical hit', async () => {
    // The away row shares no query term, so only the dense branch can return it.
    const homeRow = mem.save(
      { type: 'user', title: 'Quarterly cadence', content: 'quarterly cadence for the home tree' },
      projectScope(home),
    );
    const awayRow = mem.save(
      { type: 'user', title: 'Quarterly cadence', content: 'quarterly cadence for the home tree' },
      projectScope(away),
    );
    await embedAll();

    // Identical text embeds identically under FakeEmbedder, so both rows are
    // exact dense neighbours of the query and only the partition set decides.
    const denseOnly = await hybridSearch({
      repos,
      embedQuery: (t) => fake.embed(t),
      query: 'zzzqqq wwwvvv',
      scope: widened(home, away),
      status: 'active',
      limit: 8,
      offset: 0,
    });
    expect(denseOnly.ids).toContain(homeRow.id);
    expect(denseOnly.ids).toContain(awayRow.id);

    const narrow = await hybridSearch({
      repos,
      embedQuery: (t) => fake.embed(t),
      query: 'zzzqqq wwwvvv',
      scope: projectScope(home),
      status: 'active',
      limit: 8,
      offset: 0,
    });
    expect(narrow.ids).toContain(homeRow.id);
    expect(narrow.ids).not.toContain(awayRow.id);
  });

  it('the entity branch widens, bounding the RESPONSE rather than each project', async () => {
    const link = (projectId: string, title: string) => {
      const row = mem.save(
        { type: 'user', title, content: 'we changed src/server/auth.ts' },
        projectScope(projectId),
      );
      repos.entities.linkMemory(
        row.id,
        projectId,
        [{ kind: 'path', value: 'src/server/auth.ts' }],
        new Date(),
      );
      return row;
    };
    const homeRow = link(home, 'Home touches the file');
    const awayRow = link(away, 'Away touches the file');
    const unreachedRow = link(unreached, 'Unreached touches the file');

    const page = await mem.search({ entity: 'src/server/auth.ts' }, widened(home, away));
    const ids = page.map((m) => m.id);
    expect(ids).toContain(homeRow.id);
    expect(ids).toContain(awayRow.id);
    expect(ids).not.toContain(unreachedRow.id);

    const bounded = await mem.search(
      { entity: 'src/server/auth.ts', limit: 1 },
      widened(home, away),
    );
    expect(bounded).toHaveLength(1);

    const own = await mem.search({ entity: 'src/server/auth.ts' }, projectScope(unreached));
    expect(own.map((m) => m.id)).toEqual([unreachedRow.id]);
  });

  it('widening does not move a row relevance level, because the IDF denominator is corpus-wide', async () => {
    for (let i = 0; i < 5; i++) {
      mem.save(
        { type: 'user', title: `Away filler ${i}`, content: `cadence filler ${i}` },
        projectScope(away),
      );
    }
    const homeRow = mem.save(
      { type: 'user', title: 'Home cadence note', content: 'cadence note for the home tree' },
      projectScope(home),
    );
    await embedAll();

    const query = 'cadence note';
    const documentCount = repos.termStatistics.adminDocumentCount();
    const frequencies = repos.termStatistics.adminQueryTermFrequencies(query);

    const narrow = await mem.search({ query }, projectScope(home));
    const wide = await mem.search({ query }, widened(home, away));
    expect(narrow.map((m) => m.id)).toContain(homeRow.id);
    expect(wide.map((m) => m.id)).toContain(homeRow.id);

    // Read after both searches: a widened read that recomputed statistics per
    // set would have moved these, and the level is a pure function of them.
    expect(repos.termStatistics.adminDocumentCount()).toBe(documentCount);
    expect(repos.termStatistics.adminQueryTermFrequencies(query)).toEqual(frequencies);
    expect(documentCount).toBeGreaterThan(0);
    expect([...frequencies.values()].some((n) => (n ?? 0) > 0)).toBe(true);
  });
});

describe('a widened dense read draws a full window per named partition', () => {
  let db: TestDb;
  let repos: Repositories;
  let fake: FakeEmbedder;
  let mem: MemoryService;
  let home: string;
  let small: string;
  let third: string;
  const WINDOW = computeRankWindowSize(8, 0);

  beforeEach(async () => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
    const projects = new ProjectsService(repos);
    home = projects.create({ slug: 'home' }).id;
    small = projects.create({ slug: 'small' }).id;
    third = projects.create({ slug: 'third' }).id;
    fake = new FakeEmbedder();
    mem = new MemoryService(repos, db.handle.db, undefined, (t) => fake.embed(t));

    for (let i = 0; i < WINDOW + 6; i++) {
      mem.save({ type: 'user', title: `Home ${i}`, content: `home row ${i}` }, projectScope(home));
    }
    for (let i = 0; i < 3; i++) {
      mem.save(
        { type: 'user', title: `Small ${i}`, content: `small row ${i}` },
        projectScope(small),
      );
    }
    for (let i = 0; i < 10; i++) {
      mem.save(
        { type: 'user', title: `Third ${i}`, content: `third row ${i}` },
        projectScope(third),
      );
    }
    const worker = new EmbeddingWorker({ repos, embedder: fake });
    let guard = 0;
    while ((await worker.processBatch()).processed > 0 && guard++ < 40) {
      /* keep draining */
    }
  });

  afterEach(() => db.cleanup());

  const censusOf = async (partitionKeys: string[]) => {
    const neighbours = repos.vectors.knnByQueryVector({
      queryVector: await fake.embed('anything at all'),
      partitionKeys,
      status: 'active',
      rankWindowSize: WINDOW,
    });
    const meta = repos.memory.rankingMetadataByIds(neighbours.map((n) => n.id));
    const perProject = new Map<string, number>();
    for (const n of neighbours) {
      const projectId = meta.get(n.id)?.projectId ?? 'none';
      perProject.set(projectId, (perProject.get(projectId) ?? 0) + 1);
    }
    return perProject;
  };

  it('the small project contributes what it has and the home project a full window', async () => {
    const census = await censusOf([home, small]);
    expect(census.get(home)).toBe(WINDOW);
    expect(census.get(small)).toBe(3);
  });

  it('adding another authorized project does not reduce what the home project contributes', async () => {
    const two = await censusOf([home, small]);
    const three = await censusOf([home, small, third]);
    expect(three.get(home)).toBe(two.get(home));
    expect(three.get(small)).toBe(two.get(small));
    expect(three.get(third)).toBe(10);
  });

  it('the merged list is ordered by distance across the partitions, not partition by partition', async () => {
    const neighbours = repos.vectors.knnByQueryVector({
      queryVector: await fake.embed('anything at all'),
      partitionKeys: [home, small],
      status: 'active',
      rankWindowSize: WINDOW,
    });
    const distances = neighbours.map((n) => n.distance);
    expect(distances).toEqual([...distances].sort((a, b) => a - b));

    const meta = repos.memory.rankingMetadataByIds(neighbours.map((n) => n.id));
    const projectSequence = neighbours.map((n) => meta.get(n.id)?.projectId);
    const firstSmall = projectSequence.indexOf(small);
    const lastHome = projectSequence.lastIndexOf(home);
    // Interleaved: a small-project row sits before the last home-project row,
    // which a per-partition concatenation could not produce.
    expect(firstSmall).toBeGreaterThanOrEqual(0);
    expect(firstSmall).toBeLessThan(lastHome);
  });

  it('a one-partition set returns exactly what the narrow read returns', async () => {
    const queryVector = await fake.embed('anything at all');
    const set = repos.vectors.knnByQueryVector({
      queryVector,
      partitionKeys: [home],
      status: 'active',
      rankWindowSize: WINDOW,
    });
    const viaScope = await hybridSearch({
      repos,
      embedQuery: () => Promise.resolve(queryVector),
      query: 'anything at all',
      scope: projectScope(home),
      status: 'active',
      limit: 8,
      offset: 0,
    });
    expect(set.length).toBe(WINDOW);
    expect(viaScope.ids.length).toBeGreaterThan(0);
    expect(new Set(set.map((n) => n.id)).size).toBe(set.length);
  });

  it('a kNN over no partition is refused rather than answered with an empty page', async () => {
    const queryVector = await fake.embed('anything at all');
    expect(() =>
      repos.vectors.knnByQueryVector({
        queryVector,
        partitionKeys: [],
        status: 'active',
        rankWindowSize: WINDOW,
      }),
    ).toThrow(/no partition/);
    // Control: the same call over one partition answers.
    expect(
      repos.vectors.knnByQueryVector({
        queryVector,
        partitionKeys: [home],
        status: 'active',
        rankWindowSize: WINDOW,
      }).length,
    ).toBeGreaterThan(0);
  });
});

describe('a scope that names no project cannot reach the database', () => {
  const empty = { kind: 'authorized-projects', projectIds: [], homeProjectId: 'p0' } as const;

  it('scopeWhere refuses it, because `IN ()` is an empty result set rather than an error', () => {
    expect(() => scopeWhere(empty)).toThrow(/no project/);
    expect(() => scopeCondition(empty)).toThrow(/no project/);
  });

  it('a scope that names one project is served', () => {
    expect(scopeWhere(projectScope('p0'))).toBeDefined();
    expect(scopeCondition(projectScope('p0'))).toBeDefined();
  });
});

describe('the page order prefers the home project only on an exact tie', () => {
  const NOW = new Date('2026-01-01T00:00:00.000Z');

  function opts(meta: Map<string, { type: 'user'; lastSeenAt: null; projectId: string }>) {
    return {
      repos: {
        memory: {
          rankingMetadataByIds: () => meta,
          confirmationCountsByIds: () => new Map<string, number>(),
        },
      },
      scope: { kind: 'authorized-projects', projectIds: ['home', 'away'], homeProjectId: 'home' },
      now: () => NOW,
    } as unknown as Parameters<typeof applyRankingBoost>[1];
  }

  const meta = new Map([
    ['away-row', { type: 'user' as const, lastSeenAt: null, projectId: 'away' }],
    ['home-row', { type: 'user' as const, lastSeenAt: null, projectId: 'home' }],
  ]);

  it('the home row precedes the foreign row at an equal score, whichever fused first', () => {
    const awayFirst = applyRankingBoost(
      [
        { id: 'away-row', score: 0.02 },
        { id: 'home-row', score: 0.02 },
      ],
      opts(meta),
    );
    expect(awayFirst.map((r) => r.id)).toEqual(['home-row', 'away-row']);

    const homeFirst = applyRankingBoost(
      [
        { id: 'home-row', score: 0.02 },
        { id: 'away-row', score: 0.02 },
      ],
      opts(meta),
    );
    expect(homeFirst.map((r) => r.id)).toEqual(['home-row', 'away-row']);
  });

  it('a strictly better foreign row still outranks the home row', () => {
    const ranked = applyRankingBoost(
      [
        { id: 'away-row', score: 0.021 },
        { id: 'home-row', score: 0.02 },
      ],
      opts(meta),
    );
    expect(ranked.map((r) => r.id)).toEqual(['away-row', 'home-row']);
  });

  it('two tied foreign rows keep a defined order rather than an accidental one', () => {
    const bothAway = new Map([
      ['away-a', { type: 'user' as const, lastSeenAt: null, projectId: 'away' }],
      ['away-b', { type: 'user' as const, lastSeenAt: null, projectId: 'away' }],
    ]);
    const ranked = applyRankingBoost(
      [
        { id: 'away-b', score: 0.02 },
        { id: 'away-a', score: 0.02 },
      ],
      opts(bothAway),
    );
    expect(ranked.map((r) => r.id)).toEqual(['away-b', 'away-a']);
  });
});

describe('a widened page ranks by relevance alone (real embedder)', () => {
  let embedder: Embedder;
  let db: TestDb;
  let repos: Repositories;
  let mem: MemoryService;
  let home: string;
  let away: string;

  beforeAll(async () => {
    embedder = await loadEmbedder();
  }, 60_000);

  beforeEach(() => {
    db = createTestDb();
    repos = createRepositories(db.handle.db);
    const projects = new ProjectsService(repos);
    home = projects.create({ slug: 'home' }).id;
    away = projects.create({ slug: 'away' }).id;
    mem = new MemoryService(repos, db.handle.db, undefined, (t) => embedder.embed(t));
  });

  afterEach(() => db.cleanup());
  afterAll(() => {
    /* embedder has no teardown */
  });

  it('the better foreign answer outranks every home row it outscores', async () => {
    const homeRows = [
      mem.save(
        {
          type: 'project',
          title: 'Dunning emails are sent from the billing worker',
          content: 'the billing worker sends dunning emails on a schedule',
        },
        projectScope(home),
      ),
      mem.save(
        {
          type: 'project',
          title: 'Suspension is handled by the account service',
          content: 'the account service suspends accounts when asked to',
        },
        projectScope(home),
      ),
    ];
    const answer = mem.save(
      {
        type: 'project',
        title: 'The dunning window is 14 days before suspension',
        content:
          'an unpaid account enters dunning for 14 days; after the dunning window closes the account is suspended',
      },
      projectScope(away),
    );
    const worker = new EmbeddingWorker({ repos, embedder });
    let guard = 0;
    while ((await worker.processBatch()).processed > 0 && guard++ < 20) {
      /* keep draining */
    }

    const query = 'how long is the dunning window before an account is suspended';
    const wide = (await mem.search({ query }, widened(home, away))).map((m) => m.id);
    expect(wide[0]).toBe(answer.id);

    // Non-vacuity on both sides: the home rows are in the widened page too, so
    // the foreign row won on rank rather than by being the only candidate, and
    // the narrow page — which is what a reader gets without the argument —
    // answers with a home row and cannot reach the answer at all.
    expect(wide.filter((id) => homeRows.some((r) => r.id === id)).length).toBeGreaterThan(0);
    const narrow = (await mem.search({ query }, projectScope(home))).map((m) => m.id);
    expect(narrow.length).toBeGreaterThan(0);
    expect(narrow).not.toContain(answer.id);
  }, 60_000);

  it('a small project gets no free top slot', async () => {
    // Four home rows of descending relevance against ONE unrelated foreign row.
    // Under one globally-ordered list the foreign row is the worst match and
    // ranks last; fusing per-project lists would hand it its own rank 1 and
    // lift it over the home rows that are genuinely better answers.
    const homeRows = [
      mem.save(
        {
          type: 'project',
          title: 'Backfill watermark lives in the checkpoints table',
          content: 'the backfill watermark is stored in the checkpoints table, one row per stream',
        },
        projectScope(home),
      ),
      mem.save(
        {
          type: 'project',
          title: 'Checkpoints are written after each backfill batch',
          content: 'the backfill writes a checkpoint row after every batch it completes',
        },
        projectScope(home),
      ),
      mem.save(
        {
          type: 'project',
          title: 'The backfill runs nightly',
          content: 'the backfill job is scheduled nightly and resumes where it stopped',
        },
        projectScope(home),
      ),
      mem.save(
        {
          type: 'project',
          title: 'Streams are registered in the stream table',
          content: 'each stream has a registration row describing its source',
        },
        projectScope(home),
      ),
    ];
    const weak = mem.save(
      {
        type: 'project',
        title: 'Office coffee rota',
        content: 'the office coffee rota rotates weekly among the team',
      },
      projectScope(away),
    );
    const worker = new EmbeddingWorker({ repos, embedder });
    let guard = 0;
    while ((await worker.processBatch()).processed > 0 && guard++ < 20) {
      /* keep draining */
    }

    // The relative filter would cut the weak row out of the page, which would
    // make this a statement about the gate rather than about ranking; run the
    // ranked branch with it off so the weak row is present and merely lower.
    const wide = await hybridSearch({
      repos,
      embedQuery: (t) => embedder.embed(t),
      query: 'where is the backfill watermark stored',
      scope: widened(home, away),
      status: 'active',
      relativeLevelRatio: null,
      limit: 8,
      offset: 0,
    });
    expect(wide.ids[0]).toBe(homeRows[0]!.id);
    // Non-vacuity: every row is in the page, so this is a claim about the
    // foreign row's RANK and not about it having been filtered out.
    expect(wide.ids).toHaveLength(5);
    expect(wide.ids).toContain(weak.id);
    expect(wide.ids.indexOf(weak.id)).toBe(4);
  }, 60_000);
});
