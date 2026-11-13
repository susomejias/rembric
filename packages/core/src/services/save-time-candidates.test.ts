import {
  createRepositories,
  memory,
  memoryRelations,
  partitionKeyFor,
  projectScope,
  type Repositories,
  type Scope,
} from '@rembric/db';
import { eq, sql } from 'drizzle-orm';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { deriveTitle, MemoryService } from '@rembric/core';
import { ProjectsService } from '@rembric/core';
import { RelationsService } from '@rembric/core';
import {
  CANDIDATE_POOL_SIZE,
  ENTITY_RARITY_MIN_LINKS,
  findSaveTimeCandidates,
  LEXICAL_CANDIDATE_FLOOR,
  runPostSaveSteps,
  sanitizeFtsQuery,
  tokenContainment,
  tokenSet,
} from '@rembric/core';
import {
  DRAIN_MAX_PAIR_CHARS,
  evaluatePair,
  extractEntities,
  VEC_THRESHOLD,
  type EvaluatePairOptions,
  type PairEvaluation,
} from '@rembric/core';

import { seedProject } from '../test-support/default-project.js';
import { createTestDb, defaultProjectScope, type TestDb } from '../test-support/index.js';
import { SAVE_TIME_BASE, SAVE_TIME_SAVES } from '../test-support/retrieval/save-time-fixture.js';

let db: TestDb;
let memorySvc: MemoryService;
let projects: ProjectsService;
let relations: RelationsService;

beforeEach(() => {
  db = createTestDb();
  seedProject(db.handle, 'p0', 'project-zero');
  memorySvc = new MemoryService(createRepositories(db.handle.db), db.handle.db);
  projects = new ProjectsService(createRepositories(db.handle.db));
  relations = new RelationsService(createRepositories(db.handle.db), db.handle.db);
});

afterEach(() => db.cleanup());

describe('topic_key upsert path', () => {
  it('first save with a topic_key creates a fresh active row', () => {
    const { memory: m } = memorySvc.saveWithTopicKey(
      {
        type: 'project',
        title: 'Auth via JWT',
        content: 'auth via JWT',
        topicKey: 'decision/auth-model',
      },
      defaultProjectScope(db.handle),
    );
    expect(m.topicKey).toBe('decision/auth-model');
    expect(m.status).toBe('active');
    expect(m.replaces).toEqual([]);
  });

  it('second save with the same topic_key auto-supersedes the previous row', () => {
    const first = memorySvc.saveWithTopicKey(
      {
        type: 'project',
        title: 'Auth via JWT',
        content: 'auth via JWT',
        topicKey: 'decision/auth-model',
      },
      defaultProjectScope(db.handle),
    );
    const second = memorySvc.saveWithTopicKey(
      {
        type: 'project',
        title: 'Auth via opaque tokens',
        content: 'auth via opaque tokens',
        topicKey: 'decision/auth-model',
      },
      defaultProjectScope(db.handle),
    );

    expect(second.supersededByTopicKey?.id).toBe(first.memory.id);
    expect(second.memory.replaces).toEqual([first.memory.id]);

    const reloadedFirst = db.handle.db
      .select()
      .from(memory)
      .where(eq(memory.id, first.memory.id))
      .get();
    expect(reloadedFirst?.status).toBe('superseded');
  });

  it('scope isolation: same topic_key in different projects does NOT supersede across scopes', () => {
    const projA = projects.create({ slug: 'proj-a' });
    const projB = projects.create({ slug: 'proj-b' });
    const scopeA: Scope = projectScope(projA.id);
    const scopeB: Scope = projectScope(projB.id);

    const a = memorySvc.saveWithTopicKey(
      { type: 'project', title: 'A:auth', content: 'A:auth', topicKey: 'decision/auth-model' },
      scopeA,
    );
    const b = memorySvc.saveWithTopicKey(
      { type: 'project', title: 'B:auth', content: 'B:auth', topicKey: 'decision/auth-model' },
      scopeB,
    );

    expect(a.supersededByTopicKey).toBeNull();
    expect(b.supersededByTopicKey).toBeNull();

    const aReloaded = db.handle.db.select().from(memory).where(eq(memory.id, a.memory.id)).get();
    expect(aReloaded?.status).toBe('active'); // A is still active because B is in a different scope
  });

  it('topic_key > 128 chars is rejected', () => {
    const long = 'x'.repeat(129);
    expect(() =>
      memorySvc.saveWithTopicKey(
        { type: 'project', title: 'Long topic key', content: 'x', topicKey: long },
        defaultProjectScope(db.handle),
      ),
    ).toThrow(/128/);
  });

  it('empty topic_key is normalized to null', () => {
    const { memory: m } = memorySvc.saveWithTopicKey(
      { type: 'project', title: 'Empty topic key', content: 'x', topicKey: '   ' },
      defaultProjectScope(db.handle),
    );
    expect(m.topicKey).toBeNull();
  });

  it('concurrent saves with the same topic_key leave exactly one active row', () => {
    const N = 25;
    for (let i = 0; i < N; i++) {
      memorySvc.saveWithTopicKey(
        {
          type: 'project',
          title: `Version ${i}`,
          content: `v${i}`,
          topicKey: 'decision/auth-model',
        },
        defaultProjectScope(db.handle),
      );
    }
    const active = db.handle.db
      .select({ v: sql<number>`count(*)` })
      .from(memory)
      .where(sql`topic_key = 'decision/auth-model' AND status = 'active'`)
      .get();
    expect(active?.v).toBe(1);

    const superseded = db.handle.db
      .select({ v: sql<number>`count(*)` })
      .from(memory)
      .where(sql`topic_key = 'decision/auth-model' AND status = 'superseded'`)
      .get();
    expect(superseded?.v).toBe(N - 1);
  });
});

describe('findSaveTimeCandidates', () => {
  function fillHeterogeneousCorpus(n: number): void {
    for (let i = 0; i < n; i++) {
      memorySvc.save(
        {
          type: 'feedback',
          title: `Rollout schedule entry ${i}`,
          content: `rollout schedule entry ${i} covers timezone rotation and on-call handoff details for cycle ${i}`,
        },
        defaultProjectScope(db.handle),
      );
    }
  }

  it('surfaces a byte-identical in-scope duplicate with source fts and similarity 1.0 (no embedding, >=50 active rows)', () => {
    fillHeterogeneousCorpus(48);
    const original = memorySvc.save(
      {
        type: 'feedback',
        title: 'Use two-space indentation always',
        content: 'use two-space indentation always in every file',
      },
      defaultProjectScope(db.handle),
    );
    const duplicate = memorySvc.save(
      {
        type: 'feedback',
        title: 'Use two-space indentation always',
        content: 'use two-space indentation always in every file',
      },
      defaultProjectScope(db.handle),
    );

    const cands = findSaveTimeCandidates(createRepositories(db.handle.db), duplicate, {
      perSaveMax: 5,
    }).candidates;
    const match = cands.find((c) => c.targetId === original.id);
    expect(match).toBeDefined();
    expect(match!.source).toBe('fts');
    expect(match!.similarity).toBe(1);
  });

  it.each([50, 150, 300])(
    'does not go silent as the corpus grows — surfaces the duplicate at %i active rows',
    (n) => {
      fillHeterogeneousCorpus(n - 2);
      const original = memorySvc.save(
        {
          type: 'feedback',
          title: 'Prefer explicit error types over generic Error',
          content: 'prefer explicit error types over a generic Error across the codebase',
        },
        defaultProjectScope(db.handle),
      );
      const duplicate = memorySvc.save(
        {
          type: 'feedback',
          title: 'Prefer explicit error types over generic Error',
          content: 'prefer explicit error types over a generic Error across the codebase',
        },
        defaultProjectScope(db.handle),
      );

      const cands = findSaveTimeCandidates(createRepositories(db.handle.db), duplicate, {
        perSaveMax: 5,
      }).candidates;
      expect(cands.some((c) => c.targetId === original.id && c.source === 'fts')).toBe(true);
    },
  );

  it('a row sharing only a near-universal term is not reported near 1.0 and does not consume the candidate budget', () => {
    fillHeterogeneousCorpus(55);
    const genuine = memorySvc.save(
      {
        type: 'feedback',
        title: 'Canary rollout strategy for the checkout service',
        content:
          'canary rollout strategy for the checkout service reduces blast radius during releases',
      },
      defaultProjectScope(db.handle),
    );
    const saved = memorySvc.save(
      {
        type: 'feedback',
        title: 'Canary rollout plan for the checkout service',
        content:
          'canary rollout plan for the checkout service reduces blast radius during releases too',
      },
      defaultProjectScope(db.handle),
    );

    const cands = findSaveTimeCandidates(createRepositories(db.handle.db), saved, {
      perSaveMax: 5,
    }).candidates;
    const genuineMatch = cands.find((c) => c.targetId === genuine.id);
    expect(genuineMatch).toBeDefined();
    expect(genuineMatch!.similarity).toBeGreaterThan(0.5);
    for (const c of cands) {
      if (c.targetId !== genuine.id) expect(c.similarity).toBeLessThan(0.5);
    }
  });

  it('surfaces FTS candidates for non-ASCII content (Unicode-aware MATCH builder)', () => {
    const a = memorySvc.save(
      { type: 'feedback', title: '認証 トークン 設計', content: '認証 トークン 設計 の メモ' },
      defaultProjectScope(db.handle),
    );
    const b = memorySvc.save(
      {
        type: 'feedback',
        title: '認証 トークン 設計 改訂',
        content: '認証 トークン 設計 の 改訂 メモ',
      },
      defaultProjectScope(db.handle),
    );
    const cands = findSaveTimeCandidates(createRepositories(db.handle.db), b, {
      perSaveMax: 5,
    }).candidates;
    expect(cands.some((c) => c.targetId === a.id && c.source === 'fts')).toBe(true);
  });

  it('respects perSaveMax', () => {
    for (let i = 0; i < 10; i++) {
      memorySvc.save(
        {
          type: 'feedback',
          title: `Similar marker keyword ${i}`,
          content: `similar marker keyword ${i}`,
        },
        defaultProjectScope(db.handle),
      );
    }
    const recent = memorySvc.save(
      {
        type: 'feedback',
        title: 'Similar marker keyword extra',
        content: 'similar marker keyword extra',
      },
      defaultProjectScope(db.handle),
    );
    const cands = findSaveTimeCandidates(createRepositories(db.handle.db), recent, {
      perSaveMax: 3,
    }).candidates;
    expect(cands.length).toBeLessThanOrEqual(3);
  });

  it('skips memories outside the saved row scope (cross-scope safety)', () => {
    const projA = projects.create({ slug: 'proj-a' });
    const scopeA: Scope = projectScope(projA.id);

    const _global = memorySvc.save(
      { type: 'feedback', title: 'Cross-scope marker', content: 'cross-scope marker' },
      defaultProjectScope(db.handle),
    );
    void _global;
    const saved = memorySvc.save(
      {
        type: 'feedback',
        title: 'Cross-scope marker in project a',
        content: 'cross-scope marker in project a',
      },
      scopeA,
    );

    const cands = findSaveTimeCandidates(createRepositories(db.handle.db), saved, {
      perSaveMax: 5,
    }).candidates;
    // The global match must NOT appear because it has scope='global'.
    expect(cands.some((c) => c.targetId === _global.id)).toBe(false);
  });

  it('does not re-surface a target the new memory ancestry already judged not_conflict', () => {
    const x = memorySvc.save(
      { type: 'feedback', title: 'shared dedup marker', content: 'shared dedup marker token' },
      defaultProjectScope(db.handle),
    );
    const y = memorySvc.save(
      {
        type: 'feedback',
        title: 'shared dedup marker two',
        content: 'shared dedup marker token two',
      },
      defaultProjectScope(db.handle),
    );
    const base = memorySvc.saveWithTopicKey(
      {
        type: 'feedback',
        title: 'shared dedup marker base',
        content: 'shared dedup marker token base',
        topicKey: 'dedup/k',
      },
      defaultProjectScope(db.handle),
    ).memory;

    // `base` previously dismissed X (not_conflict) but flagged Y (conflicts_with).
    const px = relations.createPending({ sourceId: base.id, targetId: x.id });
    relations.judge(px.judgmentId, { relation: 'not_conflict', actor: 'tester', kind: 'agent' });
    const py = relations.createPending({ sourceId: base.id, targetId: y.id });
    relations.judge(py.judgmentId, { relation: 'conflicts_with', actor: 'tester', kind: 'agent' });

    // Re-save the same topic → replaces = [base.id].
    const revised = memorySvc.saveWithTopicKey(
      {
        type: 'feedback',
        title: 'shared dedup marker revised',
        content: 'shared dedup marker token revised',
        topicKey: 'dedup/k',
      },
      defaultProjectScope(db.handle),
    ).memory;
    expect(revised.replaces).toEqual([base.id]);

    const cands = findSaveTimeCandidates(createRepositories(db.handle.db), revised, {
      perSaveMax: 10,
    }).candidates;
    const ids = cands.map((c) => c.targetId);
    expect(ids).not.toContain(x.id); // dismissed not_conflict → suppressed
    expect(ids).toContain(y.id); // conflicts_with → still surfaces
  });

  it('carries a not_conflict dismissal forward across two saves of the same topic', () => {
    const x = memorySvc.save(
      { type: 'feedback', title: 'shared dedup marker', content: 'shared dedup marker token' },
      defaultProjectScope(db.handle),
    );
    const y = memorySvc.save(
      {
        type: 'feedback',
        title: 'shared dedup marker two',
        content: 'shared dedup marker token two',
      },
      defaultProjectScope(db.handle),
    );
    const saveTopic = (suffix: string) =>
      memorySvc.saveWithTopicKey(
        {
          type: 'feedback',
          title: `shared dedup marker ${suffix}`,
          content: `shared dedup marker token ${suffix}`,
          topicKey: 'dedup/deep',
        },
        defaultProjectScope(db.handle),
      ).memory;

    const base = saveTopic('base');
    const px = relations.createPending({ sourceId: base.id, targetId: x.id });
    relations.judge(px.judgmentId, { relation: 'not_conflict', actor: 'tester', kind: 'agent' });
    const py = relations.createPending({ sourceId: base.id, targetId: y.id });
    relations.judge(py.judgmentId, { relation: 'conflicts_with', actor: 'tester', kind: 'agent' });

    const v2 = saveTopic('v2');
    const v3 = saveTopic('v3');
    expect(v3.replaces).toEqual([v2.id]);
    expect(v2.replaces).toEqual([base.id]);

    const ids = findSaveTimeCandidates(createRepositories(db.handle.db), v3, {
      perSaveMax: 10,
    }).candidates.map((c) => c.targetId);
    expect(ids).not.toContain(x.id);
    expect(ids).toContain(y.id);
  });

  it('skips rows already linked via the just-saved row replaces[]', () => {
    const first = memorySvc.saveWithTopicKey(
      {
        type: 'project',
        title: 'Auth model JWT',
        content: 'auth model JWT',
        topicKey: 'decision/auth',
      },
      defaultProjectScope(db.handle),
    );
    const second = memorySvc.saveWithTopicKey(
      {
        type: 'project',
        title: 'Auth model opaque tokens',
        content: 'auth model opaque tokens',
        topicKey: 'decision/auth',
      },
      defaultProjectScope(db.handle),
    );
    const cands = findSaveTimeCandidates(createRepositories(db.handle.db), second.memory, {
      perSaveMax: 5,
    }).candidates;
    expect(cands.some((c) => c.targetId === first.memory.id)).toBe(false);
  });
});

describe('findSaveTimeCandidates — lexical floor', () => {
  const HETEROGENEOUS_FACTS: ReadonlyArray<[string, string]> = [
    [
      'Billing service uses Drizzle ORM',
      'The billing service talks to SQLite through Drizzle ORM; migrations are plain SQL files reviewed in every pull request.',
    ],
    [
      'Scheduler listens on port 8781',
      'The job scheduler binds to port 8781 instead of 8080 so it does not collide with the health-check sidecar in the same pod.',
    ],
    [
      'Node 22 is the minimum runtime',
      'All services require Node 22 or newer because the test runner relies on the built-in fetch and the stable watch mode.',
    ],
    [
      'Dashboard sessions expire after 12 hours',
      'Operator dashboard sessions are signed cookies that expire 12 hours after login and are checked on every request.',
    ],
    [
      'Nightly backups go to the off-site bucket',
      'A cron job at 02:30 UTC copies the SQLite file to the off-site bucket and keeps fourteen daily copies.',
    ],
    [
      'Search results are cached for 60 seconds',
      'The public search endpoint caches responses in memory for 60 seconds keyed by the normalized query string.',
    ],
    [
      'The production image is distroless',
      'The Docker image is built in two stages and the runtime stage is distroless, so there is no shell; debugging goes through the ephemeral debug container.',
    ],
    [
      'Use pnpm through corepack',
      'The repository pins pnpm with corepack; run corepack enable once and never install pnpm globally with npm.',
    ],
    [
      'Deploys happen on Tuesdays',
      'The team deploys to production only on Tuesday mornings to keep time to react before the weekend.',
    ],
    [
      'API rate limit is 120 requests per minute',
      'The HTTP API allows 120 requests per minute per bearer token; excess requests get 429 with a Retry-After header.',
    ],
    [
      'Logs are JSON lines on stdout',
      'Every service writes structured JSON lines to stdout and the log shipper adds the pod name before forwarding them.',
    ],
    [
      'Feature flags have an owner and a removal date',
      'Feature flags are declared with an owner and a removal date, and a CI check fails when a flag is past that date.',
    ],
    [
      'Invoices are rendered with a headless browser',
      'Invoice PDFs are produced by rendering the invoice HTML template in headless Chromium with embedded fonts.',
    ],
    [
      'Outbound webhooks retry with backoff',
      'Failed outbound webhooks are retried up to eight times with exponential backoff, then marked dead in the admin panel.',
    ],
    [
      'Translations are loaded per route',
      'Translation bundles are split per route and loaded lazily, so the initial page only ships the strings it renders.',
    ],
    [
      'Public identifiers are ULIDs',
      'Records exposed through the API use ULID identifiers so they sort by creation time.',
    ],
    [
      'Shared UI components live in one package',
      'Reusable React components belong in the shared UI package and the apps must not import from each other.',
    ],
    [
      'Timestamps are stored in UTC',
      'Every timestamp is stored as UTC milliseconds and converted to the viewer time zone only in the presentation layer.',
    ],
    [
      'Two approvals to merge into main',
      'Any pull request against main needs two approvals and a green continuous integration run before it can be merged.',
    ],
    [
      'The analytics replica is read-only',
      'The analytics replica is opened read-only; every write must go to the primary through the billing service.',
    ],
  ];

  const UNRELATED = {
    type: 'feedback' as const,
    title: 'Design review moved to Thursdays',
    content:
      'The design review for the onboarding flow is on the shared calendar every Thursday, and the notes go to the team channel.',
  };

  function seedFacts(): Map<string, string> {
    const ids = new Map<string, string>();
    for (const [title, content] of HETEROGENEOUS_FACTS) {
      ids.set(
        title,
        memorySvc.save({ type: 'project', title, content }, defaultProjectScope(db.handle)).id,
      );
    }
    return ids;
  }

  function unitVector(axis: number): Buffer {
    const v = new Float32Array(768);
    v[axis] = 1;
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }

  it('an unrelated save over a heterogeneous scope writes no lexical pending judgment, though rank-only admission would', async () => {
    seedFacts();
    const repos = createRepositories(db.handle.db);
    const scope = defaultProjectScope(db.handle);
    const unrelated = memorySvc.save(UNRELATED, scope);

    const rankOnly = findSaveTimeCandidates(repos, unrelated, { perSaveMax: 5, lexicalFloor: 0 });
    expect(rankOnly.candidates.filter((c) => c.source === 'fts').length).toBeGreaterThan(0);

    const { candidates, candidatesDetected } = await runPostSaveSteps(
      { repos, relations, candidates: { perSaveMax: 5 } },
      unrelated,
      scope,
    );
    expect(candidates).toEqual([]);
    expect(candidatesDetected).toBe(0);
    expect(relations.countPendingInScope(scope)).toBe(0);
  });

  it('a lightly edited near-duplicate is still surfaced lexically at or above the floor', () => {
    const ids = seedFacts();
    const saved = memorySvc.save(
      {
        type: 'project',
        title: 'Production container is distroless',
        content:
          'The Docker image builds in two stages and its runtime stage is distroless, so no shell exists; debugging uses the ephemeral debug container.',
      },
      defaultProjectScope(db.handle),
    );
    const cands = findSaveTimeCandidates(createRepositories(db.handle.db), saved, {
      perSaveMax: 5,
    }).candidates;
    const match = cands.find((c) => c.targetId === ids.get('The production image is distroless'));
    expect(match?.source).toBe('fts');
    expect(match!.similarity).toBeGreaterThanOrEqual(LEXICAL_CANDIDATE_FLOOR);
  });

  it('a below-floor lexical match takes no slot and is not counted', () => {
    for (let i = 0; i < 8; i++) {
      memorySvc.save(
        {
          type: 'project',
          title: `Checkout note ${i}`,
          content: `checkout latency dashboard ${i} lives under observability panel ${i}`,
        },
        defaultProjectScope(db.handle),
      );
    }
    const restating = memorySvc.save(
      {
        type: 'project',
        title: 'Checkout retries idempotency keys',
        content: 'checkout retries reuse the same idempotency key so a double submit charges once',
      },
      defaultProjectScope(db.handle),
    );
    const saved = memorySvc.save(
      {
        type: 'project',
        title: 'Checkout retries reuse idempotency keys',
        content: 'checkout retries reuse one idempotency key so a double submit only charges once',
      },
      defaultProjectScope(db.handle),
    );
    const repos = createRepositories(db.handle.db);

    const rankOnly = findSaveTimeCandidates(repos, saved, {
      perSaveMax: 5,
      lexicalFloor: 0,
      commonTermRatio: null,
    });
    expect(rankOnly.detected).toBeGreaterThan(5);

    const floored = findSaveTimeCandidates(repos, saved, { perSaveMax: 5, commonTermRatio: null });
    expect(floored.candidates.map((c) => c.targetId)).toEqual([restating.id]);
    expect(floored.detected).toBe(1);
    for (const c of floored.candidates)
      expect(c.similarity).toBeGreaterThanOrEqual(LEXICAL_CANDIDATE_FLOOR);
  });

  it('a lexical match exactly at the floor is admitted', () => {
    const scope = defaultProjectScope(db.handle);
    const atFloor = memorySvc.save(
      {
        type: 'procedural',
        title: 'Key rotation trigger',
        content: 'rotate signing keys after incidents',
      },
      scope,
    );
    const saved = memorySvc.save(
      {
        type: 'procedural',
        title: 'Quarterly rotation',
        content: 'rotate signing keys every quarter',
      },
      scope,
    );
    const repos = createRepositories(db.handle.db);
    const hit = findSaveTimeCandidates(repos, saved, {
      perSaveMax: 5,
      lexicalFloor: 0.6,
    }).candidates.find((c) => c.targetId === atFloor.id);
    expect(hit?.source).toBe('fts');
    expect(hit!.similarity).toBe(0.6);
    expect(
      findSaveTimeCandidates(repos, saved, { perSaveMax: 5, lexicalFloor: 0.61 }).candidates.some(
        (c) => c.targetId === atFloor.id,
      ),
    ).toBe(false);
  });

  it('a pair below the lexical floor is still surfaced by the dense channel', () => {
    seedFacts();
    const scope = defaultProjectScope(db.handle);
    const repos = createRepositories(db.handle.db);
    const target = memorySvc.save(
      {
        type: 'project',
        title: 'Cold starts on the worker fleet',
        content: 'Worker pods take forty seconds to warm the model cache after a deploy.',
      },
      scope,
    );
    const saved = memorySvc.save(
      {
        type: 'project',
        title: 'Slow first request after rollout',
        content:
          'The first request after each rollout waits while pods warm up, roughly forty seconds.',
      },
      scope,
    );
    expect(
      tokenContainment(tokenSet(saved.content), tokenSet(`${target.title}\n\n${target.content}`)),
    ).toBeLessThan(LEXICAL_CANDIDATE_FLOOR);
    repos.vectors.insertEmbedding(target.id, unitVector(3), partitionKeyFor(scope.projectId));
    repos.vectors.insertEmbedding(saved.id, unitVector(3), partitionKeyFor(scope.projectId));

    const lexical = findSaveTimeCandidates(repos, saved, { perSaveMax: 5, lexicalFloor: 0 });
    const lexicalHit = lexical.candidates.find((c) => c.targetId === target.id);
    expect(lexicalHit?.source).toBe('vec');

    const cands = findSaveTimeCandidates(repos, saved, { perSaveMax: 5 }).candidates;
    const hit = cands.find((c) => c.targetId === target.id);
    expect(hit?.source).toBe('vec');
  });

  it('the lexical floor does not gate the entity channel', () => {
    seedFacts();
    const scope = defaultProjectScope(db.handle);
    const repos = createRepositories(db.handle.db);
    const target = memorySvc.save(
      {
        type: 'project',
        title: 'Session expiry lives in one module',
        content:
          'The twelve hour expiry is enforced in src/lib/session-expiry.ts on every request.',
      },
      scope,
    );
    repos.entities.linkMemory(
      target.id,
      scope.projectId,
      [{ kind: 'path', value: 'src/lib/session-expiry.ts' }],
      new Date(),
    );
    const saved = memorySvc.save(
      {
        type: 'project',
        title: 'Operators keep their login for a week',
        content: 'Changed src/lib/session-expiry.ts so operators stay signed in seven days.',
      },
      scope,
    );
    const cands = findSaveTimeCandidates(repos, saved, { perSaveMax: 5 }, [
      { kind: 'path', value: 'src/lib/session-expiry.ts' },
    ]).candidates;
    const hit = cands.find((c) => c.targetId === target.id);
    expect(hit?.source).toBe('entity');
    expect(hit!.similarity).toBeLessThan(LEXICAL_CANDIDATE_FLOOR);
  });

  it('the floor adds no repository read: the same reads run at the shipped floor and at 0', () => {
    seedFacts();
    const saved = memorySvc.save(UNRELATED, defaultProjectScope(db.handle));
    const record = (calls: string[]): Repositories => {
      const repos = createRepositories(db.handle.db);
      return new Proxy(repos, {
        get(target, repoName: string) {
          const repo = target[repoName as keyof Repositories] as object;
          return new Proxy(repo, {
            get(r, method: string) {
              const value = (r as Record<string, unknown>)[method];
              if (typeof value !== 'function') return value;
              return (...args: unknown[]) => {
                calls.push(`${repoName}.${method}`);
                return (value as (...a: unknown[]) => unknown).apply(r, args);
              };
            },
          });
        },
      });
    };
    const atShipped: string[] = [];
    const atZero: string[] = [];
    findSaveTimeCandidates(record(atShipped), saved, { perSaveMax: 5 });
    findSaveTimeCandidates(record(atZero), saved, { perSaveMax: 5, lexicalFloor: 0 });
    expect(atShipped.length).toBeGreaterThan(0);
    expect(atShipped).toEqual(atZero);
  });
});

describe('findSaveTimeCandidates — common-term pruning', () => {
  const FILLER_WORDS = ['amber', 'birch', 'cedar', 'dune', 'ember', 'fjord', 'grove', 'heath'];

  function seed(contents: readonly string[]): string[] {
    return contents.map(
      (content, i) =>
        memorySvc.save(
          { type: 'project', title: `Seed ${FILLER_WORDS[i % 8]}`, content },
          defaultProjectScope(db.handle),
        ).id,
    );
  }

  function saveProbe(content: string) {
    return memorySvc.save(
      { type: 'project', title: 'Probe heading', content },
      defaultProjectScope(db.handle),
    );
  }

  function detectRecordingMatch(
    saved: ReturnType<typeof saveProbe>,
    opts: { perSaveMax: number; commonTermRatio?: number | null } = { perSaveMax: 5 },
  ) {
    const repos = createRepositories(db.handle.db);
    const spy = vi.spyOn(repos.memory, 'searchBm25Candidates');
    const result = findSaveTimeCandidates(repos, saved, opts);
    return { result, matchExprs: spy.mock.calls.map(([call]) => call.matchExpr) };
  }

  function documentFrequency(term: string): number | null | undefined {
    return createRepositories(db.handle.db)
      .termStatistics.adminQueryTermFrequencies(term)
      .get(term);
  }

  function documentCount(): number {
    return createRepositories(db.handle.db).termStatistics.adminDocumentCount();
  }

  it('omits a token present in at least half of the rows and keeps a rarer one', () => {
    seed([
      ...FILLER_WORDS.map((w) => `the ${w} ledger`),
      'the zephyrkite manual covers kite repairs',
    ]);
    const saved = saveProbe('the zephyrkite');
    expect(documentFrequency('the')! >= documentCount() / 2).toBe(true);

    const { matchExprs } = detectRecordingMatch(saved);
    expect(matchExprs).toEqual(['"zephyrkite"']);
  });

  it.each([
    [5, '"zephyrkite"'],
    [4, '"pivot" OR "zephyrkite"'],
  ])(
    'at %i of 10 rows the token is omitted only from exactly half upward',
    (pivotRows, expected) => {
      seed([
        'zephyrkite marker',
        ...Array.from({ length: pivotRows - 1 }, (_, i) => `pivot ${FILLER_WORDS[i]}`),
        ...Array.from({ length: 9 - pivotRows }, (_, i) => `filler ${FILLER_WORDS[i]}`),
      ]);
      const saved = saveProbe('pivot zephyrkite');
      expect(documentCount()).toBe(10);
      expect(documentFrequency('pivot')).toBe(pivotRows);

      expect(detectRecordingMatch(saved).matchExprs).toEqual([expected]);
    },
  );

  it('a near-duplicate sharing a rarer token surfaces lexically with an unchanged similarity', () => {
    seed(FILLER_WORDS.map((w) => `the ${w} ledger`));
    const [target] = seed(['the zephyrkite manual covers kite repairs']);
    const saved = saveProbe('the zephyrkite manual covers kite repair');

    const pruned = detectRecordingMatch(saved);
    const unpruned = detectRecordingMatch(saved, { perSaveMax: 5, commonTermRatio: null });
    expect(pruned.matchExprs).not.toEqual(unpruned.matchExprs);
    expect(unpruned.matchExprs).toEqual([sanitizeFtsQuery(saved.content, { maxTerms: 16 })]);

    const hit = pruned.result.candidates.find((c) => c.targetId === target);
    expect(hit?.source).toBe('fts');
    expect(hit!.similarity).toBe(
      unpruned.result.candidates.find((c) => c.targetId === target)!.similarity,
    );
  });

  it('a save whose every token is common keeps the builder expression unchanged', () => {
    seed(FILLER_WORDS.map((w) => `alpha beta gamma ${w}`));
    const saved = saveProbe('alpha beta gamma');
    for (const t of ['alpha', 'beta', 'gamma'])
      expect(documentFrequency(t)! >= documentCount() / 2).toBe(true);

    expect(detectRecordingMatch(saved).matchExprs).toEqual([
      sanitizeFtsQuery(saved.content, { maxTerms: 16 }),
    ]);
  });

  it('tokens found only in the saved text do not count as kept, so the common tokens stay', () => {
    const [sharing] = seed([
      'alpha beta',
      ...FILLER_WORDS.slice(0, 3).map((w) => `alpha beta ${w}`),
    ]);
    const saved = saveProbe('alpha beta zzonlyhere');
    expect(documentFrequency('zzonlyhere')).toBe(1);
    expect(documentFrequency('alpha')! >= documentCount() / 2).toBe(true);

    const { result, matchExprs } = detectRecordingMatch(saved);
    expect(matchExprs).toEqual([sanitizeFtsQuery(saved.content, { maxTerms: 16 })]);
    expect(result.candidates.find((c) => c.targetId === sharing)?.source).toBe('fts');
  });

  function seedIn(projectId: string, contents: readonly string[]): void {
    for (const [i, content] of contents.entries())
      memorySvc.save(
        { type: 'project', title: `Other ${FILLER_WORDS[i % 8]}`, content },
        projectScope(projectId),
      );
  }

  it('omits a token common in the saving project even when it is rare across the server', () => {
    seed(['zephyrkite marker', ...FILLER_WORDS.slice(0, 7).map((w) => `pivot ${w}`), 'filler one']);
    seedIn(
      'p0',
      Array.from({ length: 40 }, (_, i) => `unrelated ${FILLER_WORDS[i % 8]} ${i}`),
    );
    const saved = saveProbe('pivot zephyrkite');
    expect(documentFrequency('pivot')! < documentCount() / 2).toBe(true);

    expect(detectRecordingMatch(saved).matchExprs).toEqual(['"zephyrkite"']);
  });

  it('is not changed by rows another project adds', () => {
    const [rare] = seed(['kite alpha', 'kite beta', 'beta ember']);
    seed(FILLER_WORDS.slice(0, 6).map((w) => `filler ${w}`));
    const saved = saveProbe('kite alpha beta');
    const detect = () =>
      findSaveTimeCandidates(createRepositories(db.handle.db), saved, {
        perSaveMax: 5,
        poolSize: 1,
      }).candidates.map((c) => [c.targetId, c.similarity]);
    const before = detect();
    expect(before.map(([id]) => id)).toEqual([rare]);

    seedIn(
      'p0',
      Array.from({ length: 12 }, (_, i) => `alpha ${FILLER_WORDS[i % 8]} ${i}`),
    );
    expect(detect()).toEqual(before);
  });

  it('a multi-term token stays even when each of its terms is common', () => {
    seed(['zephyrkite marker', ...FILLER_WORDS.map((w) => `two ${w} space`)]);
    const saved = saveProbe('two-space zephyrkite');
    for (const t of ['two', 'space'])
      expect(documentFrequency(t)! >= documentCount() / 2).toBe(true);

    expect(detectRecordingMatch(saved).matchExprs).toEqual(['"two-space" OR "zephyrkite"']);
  });
});

describe('findSaveTimeCandidates — the pre-cap detected count', () => {
  function fillNearDuplicates(n: number): void {
    for (let i = 0; i < n; i++) {
      memorySvc.save(
        {
          type: 'feedback',
          title: `Indentation rule ${i}`,
          content: `use two-space indentation always in every file, revision ${i}`,
        },
        defaultProjectScope(db.handle),
      );
    }
  }

  it('reports the pre-cap length when the cap binds, and the list length when it does not', () => {
    fillNearDuplicates(12);
    const saved = memorySvc.save(
      {
        type: 'feedback',
        title: 'Indentation rule',
        content: 'use two-space indentation always in every file, revision final',
      },
      defaultProjectScope(db.handle),
    );
    const repos = createRepositories(db.handle.db);

    const capped = findSaveTimeCandidates(repos, saved, { perSaveMax: 5 });
    expect(capped.candidates).toHaveLength(5);
    expect(capped.detected).toBeGreaterThan(5);

    const uncapped = findSaveTimeCandidates(repos, saved, { perSaveMax: 50 });
    expect(uncapped.candidates.length).toBe(uncapped.detected);
    expect(uncapped.detected).toBe(capped.detected);
  });

  it('the capped list is the prefix of the order the count was taken over', () => {
    fillNearDuplicates(12);
    const saved = memorySvc.save(
      {
        type: 'feedback',
        title: 'Indentation rule',
        content: 'use two-space indentation always in every file, revision final',
      },
      defaultProjectScope(db.handle),
    );
    const repos = createRepositories(db.handle.db);
    const full = findSaveTimeCandidates(repos, saved, { perSaveMax: 50 }).candidates;
    for (const n of [1, 3, 5, 8]) {
      const page = findSaveTimeCandidates(repos, saved, { perSaveMax: n }).candidates;
      expect(page.map((c) => c.targetId)).toEqual(full.slice(0, n).map((c) => c.targetId));
    }
  });

  it('the count MAY exceed CANDIDATE_POOL_SIZE — each rare entity contributes its own pool', () => {
    const repos = createRepositories(db.handle.db);
    const entities = ['a.ts', 'b.ts', 'c.ts', 'd.ts'];
    for (let i = 0; i < 40; i++) {
      const m = memorySvc.save(
        { type: 'project', title: `Note ${i}`, content: `wholly unrelated note ${i}` },
        defaultProjectScope(db.handle),
      );
      repos.entities.linkMemory(
        m.id,
        defaultProjectScope(db.handle).projectId,
        [{ kind: 'path', value: entities[i % entities.length]! }],
        new Date(),
      );
    }
    // Dilute so each entity's 10 links stay under the 0.15 rarity gate.
    for (let i = 0; i < 90; i++) {
      memorySvc.save(
        { type: 'project', title: `Filler ${i}`, content: `filler ${i}` },
        defaultProjectScope(db.handle),
      );
    }
    const saved = memorySvc.save(
      { type: 'project', title: 'Touches four files', content: 'touches four files at once' },
      defaultProjectScope(db.handle),
    );
    const res = findSaveTimeCandidates(
      repos,
      saved,
      { perSaveMax: 100 },
      entities.map((value) => ({ kind: 'path' as const, value })),
    );
    expect(res.detected).toBe(40);
    expect(res.detected).toBeGreaterThan(CANDIDATE_POOL_SIZE);
  });
});

describe('findSaveTimeCandidates — entity overlap channel (add-entity-index)', () => {
  it('surfaces a low-vocabulary-overlap contradiction about the same rare file', () => {
    const repos = createRepositories(db.handle.db);
    for (let i = 0; i < 10; i++) {
      memorySvc.save(
        { type: 'project', title: `Filler ${i}`, content: `filler note ${i}` },
        defaultProjectScope(db.handle),
      );
    }
    const chown = memorySvc.save(
      { type: 'project', title: 'Use chown 10001', content: 'use chown 10001 for the data dir' },
      defaultProjectScope(db.handle),
    );
    repos.entities.linkMemory(
      chown.id,
      defaultProjectScope(db.handle).projectId,
      [{ kind: 'path', value: 'docs/docker.md' }],
      new Date(),
    );
    const root = memorySvc.save(
      { type: 'project', title: 'Run as root', content: 'run as root instead' },
      defaultProjectScope(db.handle),
    );

    const cands = findSaveTimeCandidates(repos, root, { perSaveMax: 5 }, [
      { kind: 'path', value: 'docs/docker.md' },
    ]).candidates;
    const match = cands.find((c) => c.targetId === chown.id);
    expect(match).toBeDefined();
    expect(match!.source).toBe('entity');
    expect(match!.entityValue).toBe('docs/docker.md');
  });

  it('a very common entity surfaces nothing — exactly AT the link floor', () => {
    const repos = createRepositories(db.handle.db);
    for (let i = 0; i < 5; i++) {
      const m = memorySvc.save(
        { type: 'project', title: `Note ${i}`, content: `note number ${i}` },
        defaultProjectScope(db.handle),
      );
      repos.entities.linkMemory(
        m.id,
        defaultProjectScope(db.handle).projectId,
        [{ kind: 'ticket', value: 'PROJ-1' }],
        new Date(),
      );
    }
    const saved = memorySvc.save(
      { type: 'project', title: 'Note last', content: 'note number last' },
      defaultProjectScope(db.handle),
    );

    expect(
      repos.entities.entityLinkCount({
        projectId: defaultProjectScope(db.handle).projectId,
        kind: 'ticket',
        value: 'PROJ-1',
        excludeMemoryId: saved.id,
      }),
    ).toBe(ENTITY_RARITY_MIN_LINKS);

    const cands = findSaveTimeCandidates(repos, saved, { perSaveMax: 5 }, [
      { kind: 'ticket', value: 'PROJ-1' },
    ]).candidates;
    expect(cands.some((c) => c.source === 'entity')).toBe(false);
  });

  it('the per-save cap holds across vec/fts/entity channels combined', () => {
    const repos = createRepositories(db.handle.db);
    for (let i = 0; i < 20; i++) {
      memorySvc.save(
        { type: 'project', title: `Filler ${i}`, content: `filler note ${i}` },
        defaultProjectScope(db.handle),
      );
    }
    for (let i = 0; i < 3; i++) {
      const m = memorySvc.save(
        {
          type: 'project',
          title: `Distinct note ${i}`,
          content: `distinct note ${i} about topic ${i}`,
        },
        defaultProjectScope(db.handle),
      );
      repos.entities.linkMemory(
        m.id,
        defaultProjectScope(db.handle).projectId,
        [{ kind: 'error_code', value: 'ENOENT' }],
        new Date(),
      );
    }
    const saved = memorySvc.save(
      {
        type: 'project',
        title: 'Distinct note last',
        content: 'distinct note last about topic last',
      },
      defaultProjectScope(db.handle),
    );

    const cands = findSaveTimeCandidates(repos, saved, { perSaveMax: 2 }, [
      { kind: 'error_code', value: 'ENOENT' },
    ]).candidates;
    expect(cands.some((c) => c.source === 'entity')).toBe(true);
    expect(cands.length).toBeLessThanOrEqual(2);
  });

  it('reports containment, not rarity, and still leads the merged list', () => {
    const repos = createRepositories(db.handle.db);
    for (let i = 0; i < 18; i++) {
      memorySvc.save(
        { type: 'project', title: `Filler ${i}`, content: `filler note ${i}` },
        defaultProjectScope(db.handle),
      );
    }
    const nearDuplicate = memorySvc.save(
      { type: 'project', title: 'Deploy runbook', content: 'the deploy runbook lives here' },
      defaultProjectScope(db.handle),
    );
    const entityOnly = memorySvc.save(
      { type: 'project', title: 'Ownership', content: 'chown ten thousand and one' },
      defaultProjectScope(db.handle),
    );
    repos.entities.linkMemory(
      entityOnly.id,
      defaultProjectScope(db.handle).projectId,
      [{ kind: 'path', value: 'docs/docker.md' }],
      new Date(),
    );
    const saved = memorySvc.save(
      { type: 'project', title: 'Deploy runbook', content: 'the deploy runbook lives here' },
      defaultProjectScope(db.handle),
    );

    const cands = findSaveTimeCandidates(repos, saved, { perSaveMax: 1 }, [
      { kind: 'path', value: 'docs/docker.md' },
    ]).candidates;

    expect(cands.map((c) => c.targetId)).toEqual([entityOnly.id]);
    expect(cands[0]!.similarity).toBeLessThan(0.2);

    const wide = findSaveTimeCandidates(repos, saved, { perSaveMax: 5 }, [
      { kind: 'path', value: 'docs/docker.md' },
    ]).candidates;
    expect(wide[0]!.targetId).toBe(entityOnly.id);
    expect(wide.find((c) => c.targetId === nearDuplicate.id)!.similarity).toBeGreaterThan(
      wide[0]!.similarity,
    );
  });

  it('a long superseded topic chain on the same entity does not switch the channel off', () => {
    const repos = createRepositories(db.handle.db);
    const target = memorySvc.save(
      { type: 'project', title: 'Bind the port', content: 'bind the port to loopback only' },
      defaultProjectScope(db.handle),
    );
    repos.entities.linkMemory(
      target.id,
      defaultProjectScope(db.handle).projectId,
      [{ kind: 'path', value: 'docker-compose.yml' }],
      new Date(),
    );
    for (let i = 0; i < 9; i++) {
      memorySvc.save(
        { type: 'project', title: `Filler ${i}`, content: `filler note ${i}` },
        defaultProjectScope(db.handle),
      );
    }
    // Non-archived: 6/16 = 0.375, over the gate. Active: 1/11 = 0.09, under it.
    const chain: string[] = [];
    for (let i = 0; i < 6; i++) {
      const { memory: m } = memorySvc.saveWithTopicKey(
        {
          type: 'project',
          title: `Compose revision ${i}`,
          content: `compose revision ${i} adjusts the healthcheck interval`,
          topicKey: 'ops/compose-healthcheck',
        },
        defaultProjectScope(db.handle),
      );
      chain.push(m.id);
    }
    for (const id of chain.slice(0, -1)) {
      repos.entities.linkMemory(
        id,
        defaultProjectScope(db.handle).projectId,
        [{ kind: 'path', value: 'docker-compose.yml' }],
        new Date(),
      );
    }
    db.handle.db
      .update(memory)
      .set({ createdAt: new Date(1_000) })
      .where(eq(memory.id, target.id))
      .run();

    const saved = memorySvc.save(
      {
        type: 'project',
        title: 'Publish on all interfaces',
        content: 'publish on 0.0.0.0 instead',
      },
      defaultProjectScope(db.handle),
    );
    const cands = findSaveTimeCandidates(repos, saved, { perSaveMax: 5 }, [
      { kind: 'path', value: 'docker-compose.yml' },
    ]).candidates;
    const match = cands.find((c) => c.targetId === target.id);
    expect(match).toBeDefined();
    expect(match!.source).toBe('entity');
    expect(match!.entityValue).toBe('docker-compose.yml');
  });

  it('a young scope is not gated into silence: one link below the floor still surfaces', () => {
    const repos = createRepositories(db.handle.db);
    const target = memorySvc.save(
      { type: 'project', title: 'Auth module note', content: 'the auth module retries twice' },
      defaultProjectScope(db.handle),
    );
    repos.entities.linkMemory(
      target.id,
      defaultProjectScope(db.handle).projectId,
      [{ kind: 'ticket', value: 'AUTH-7' }],
      new Date(),
    );
    memorySvc.save(
      { type: 'project', title: 'Unrelated one', content: 'nothing to do with auth' },
      defaultProjectScope(db.handle),
    );
    const saved = memorySvc.save(
      { type: 'project', title: 'Auth retry raised', content: 'auth retry count raised' },
      defaultProjectScope(db.handle),
    );
    expect(
      repos.entities.scopeActiveMemoryCount({
        projectId: defaultProjectScope(db.handle).projectId,
        excludeMemoryId: saved.id,
      }),
    ).toBe(2);
    expect(
      repos.entities.entityLinkCount({
        projectId: defaultProjectScope(db.handle).projectId,
        kind: 'ticket',
        value: 'AUTH-7',
        excludeMemoryId: saved.id,
      }),
    ).toBe(1);

    const cands = findSaveTimeCandidates(repos, saved, { perSaveMax: 5 }, [
      { kind: 'ticket', value: 'AUTH-7' },
    ]).candidates;
    const match = cands.find((c) => c.targetId === target.id);
    expect(match).toBeDefined();
    expect(match!.source).toBe('entity');
    expect(match!.entityValue).toBe('AUTH-7');
  });

  it('several separately-exempt entities CAN together fill the budget — recorded, not claimed away', () => {
    const repos = createRepositories(db.handle.db);
    const DUP = 'The deploy pipeline retries three times before giving up entirely.';
    const original = memorySvc.save(
      { type: 'project', title: 'Deploy retries', content: DUP },
      defaultProjectScope(db.handle),
    );
    const ents = Array.from({ length: 5 }, (_, i) => ({
      kind: 'ticket' as const,
      value: `TCK-${i}`,
    }));
    for (const e of ents) {
      const m = memorySvc.save(
        { type: 'project', title: `Note ${e.value}`, content: `about ${e.value}` },
        defaultProjectScope(db.handle),
      );
      repos.entities.linkMemory(m.id, defaultProjectScope(db.handle).projectId, [e], new Date());
    }
    const saved = memorySvc.save(
      { type: 'project', title: 'Deploy retries again', content: DUP },
      defaultProjectScope(db.handle),
    );

    const result = findSaveTimeCandidates(repos, saved, { perSaveMax: 5 }, ents);
    expect(result.candidates.map((c) => c.source)).toEqual([
      'entity',
      'entity',
      'entity',
      'entity',
      'entity',
    ]);
    expect(result.candidates.some((c) => c.targetId === original.id)).toBe(false);
  });

  it('the floor is an exemption for entities that cannot saturate, not a small-scope bypass', () => {
    const repos = createRepositories(db.handle.db);
    for (let i = 0; i < 5; i++) {
      const m = memorySvc.save(
        { type: 'project', title: `Ticketed ${i}`, content: `ticketed note ${i}` },
        defaultProjectScope(db.handle),
      );
      repos.entities.linkMemory(
        m.id,
        defaultProjectScope(db.handle).projectId,
        [{ kind: 'ticket', value: 'OPS-3' }],
        new Date(),
      );
    }
    for (let i = 0; i < 3; i++) {
      memorySvc.save(
        { type: 'project', title: `Plain ${i}`, content: `plain note ${i}` },
        defaultProjectScope(db.handle),
      );
    }
    const saved = memorySvc.save(
      { type: 'project', title: 'Ops follow-up', content: 'ops follow-up note' },
      defaultProjectScope(db.handle),
    );
    expect(
      repos.entities.entityLinkCount({
        projectId: defaultProjectScope(db.handle).projectId,
        kind: 'ticket',
        value: 'OPS-3',
        excludeMemoryId: saved.id,
      }),
    ).toBe(ENTITY_RARITY_MIN_LINKS);
    expect(
      repos.entities.scopeActiveMemoryCount({
        projectId: defaultProjectScope(db.handle).projectId,
        excludeMemoryId: saved.id,
      }),
    ).toBe(8);

    const cands = findSaveTimeCandidates(repos, saved, { perSaveMax: 5 }, [
      { kind: 'ticket', value: 'OPS-3' },
    ]).candidates;
    expect(cands.some((c) => c.source === 'entity')).toBe(false);
  });

  it('an entity concentrated on the active population is gated even where superseded rows dilute it', () => {
    const repos = createRepositories(db.handle.db);
    for (let i = 0; i < 5; i++) {
      const m = memorySvc.save(
        { type: 'project', title: `Retry note ${i}`, content: `retry note ${i} on the queue` },
        defaultProjectScope(db.handle),
      );
      repos.entities.linkMemory(
        m.id,
        defaultProjectScope(db.handle).projectId,
        [{ kind: 'error_code', value: 'ETIMEDOUT' }],
        new Date(),
      );
    }
    for (let i = 0; i < 14; i++) {
      memorySvc.save(
        { type: 'project', title: `Filler ${i}`, content: `filler note ${i}` },
        defaultProjectScope(db.handle),
      );
    }
    for (let i = 0; i < 15; i++) {
      memorySvc.saveWithTopicKey(
        {
          type: 'project',
          title: `Unrelated revision ${i}`,
          content: `unrelated revision ${i} of the release checklist`,
          topicKey: 'ops/release-checklist',
        },
        defaultProjectScope(db.handle),
      );
    }
    const saved = memorySvc.save(
      { type: 'project', title: 'Queue timeout raised', content: 'queue timeout raised to sixty' },
      defaultProjectScope(db.handle),
    );
    // Non-vacuous: the arithmetic the assertion rests on, asserted.
    expect(
      repos.entities.entityLinkCount({
        projectId: defaultProjectScope(db.handle).projectId,
        kind: 'error_code',
        value: 'ETIMEDOUT',
        excludeMemoryId: saved.id,
      }),
    ).toBe(5);
    expect(
      repos.entities.scopeActiveMemoryCount({
        projectId: defaultProjectScope(db.handle).projectId,
        excludeMemoryId: saved.id,
      }),
    ).toBe(20);
    const cands = findSaveTimeCandidates(repos, saved, { perSaveMax: 5 }, [
      { kind: 'error_code', value: 'ETIMEDOUT' },
    ]).candidates;
    expect(cands.some((c) => c.source === 'entity')).toBe(false);
  });
});

describe('9.7 property: at most one active row per (scope, project_id, topic_key)', () => {
  it('random save sequences never violate the uniqueness invariant', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            key: fc.constantFrom('alpha', 'bravo', 'charlie', 'delta'),
            content: fc.string({ minLength: 1, maxLength: 40 }),
          }),
          { minLength: 1, maxLength: 25 },
        ),
        (ops) => {
          const fresh = createTestDb();
          try {
            const svc = new MemoryService(createRepositories(fresh.handle.db), fresh.handle.db);
            const freshScope = defaultProjectScope(fresh.handle);
            for (const op of ops) {
              const content = op.content.trim() || 'x';
              svc.saveWithTopicKey(
                {
                  type: 'project',
                  title: deriveTitle(content),
                  content,
                  topicKey: `decision/${op.key}`,
                },
                freshScope,
              );
            }
            // Invariant: per topic_key, at most one active row.
            const rows = fresh.handle.db.all<{ topic_key: string; n: number }>(
              sql`SELECT topic_key, COUNT(*) AS n FROM memory WHERE status = 'active' AND topic_key IS NOT NULL GROUP BY topic_key`,
            );
            for (const r of rows) {
              expect(Number(r.n)).toBe(1);
            }
          } finally {
            fresh.cleanup();
          }
        },
      ),
      { numRuns: 25 },
    );
  });
});

describe('RelationsService.compare — idempotency + cross-scope rejection', () => {
  it('compare twice on the same pair updates the existing row in place', () => {
    const a = memorySvc.save(
      { type: 'feedback', title: 'Memory a', content: 'a' },
      defaultProjectScope(db.handle),
    );
    const b = memorySvc.save(
      { type: 'feedback', title: 'Memory b', content: 'b' },
      defaultProjectScope(db.handle),
    );

    const first = relations.compare({
      sourceId: a.id,
      targetId: b.id,
      relation: 'related',
      confidence: 0.5,
      actor: 'tok',
    });
    const second = relations.compare({
      sourceId: a.id,
      targetId: b.id,
      relation: 'conflicts_with',
      confidence: 0.9,
      actor: 'tok',
    });

    expect(second.id).toBe(first.id);
    expect(second.relation).toBe('conflicts_with');

    const rows = db.handle.db
      .select()
      .from(memoryRelations)
      .where(eq(memoryRelations.sourceId, a.id))
      .all();
    expect(rows.length).toBe(1);
  });

  it('compare across scopes is rejected with cross_scope_relation', () => {
    const projA = projects.create({ slug: 'proj-a' });
    const a = memorySvc.save(
      { type: 'feedback', title: 'Memory a', content: 'a' },
      defaultProjectScope(db.handle),
    );
    const b = memorySvc.save(
      { type: 'feedback', title: 'Memory b', content: 'b' },
      projectScope(projA.id),
    );

    expect(() =>
      relations.compare({
        sourceId: a.id,
        targetId: b.id,
        relation: 'related',
        confidence: 0.9,
        actor: 'tok',
      }),
    ).toThrow(/cross_scope/i);
  });

  it('double-judge of the same pending row throws conflict', () => {
    const a = memorySvc.save(
      { type: 'feedback', title: 'Memory a', content: 'a' },
      defaultProjectScope(db.handle),
    );
    const b = memorySvc.save(
      { type: 'feedback', title: 'Memory b', content: 'b' },
      defaultProjectScope(db.handle),
    );
    const pending = relations.createPending({ sourceId: a.id, targetId: b.id });

    relations.judge(pending.judgmentId, {
      relation: 'related',
      actor: 'tok',
      kind: 'agent',
    });
    expect(() =>
      relations.judge(pending.judgmentId, {
        relation: 'conflicts_with',
        actor: 'tok',
        kind: 'agent',
      }),
    ).toThrow(/already/i);
  });
});

describe('evaluatePair — the drain re-check of one pending pair', () => {
  const current: EvaluatePairOptions = { vectorIndexCurrent: true };

  function vec(axisWeights: [number, number]): Buffer {
    const v = new Float32Array(768);
    const norm = Math.hypot(...axisWeights);
    v[0] = axisWeights[0] / norm;
    v[1] = axisWeights[1] / norm;
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }

  function save(title: string, content: string, scope: Scope = defaultProjectScope(db.handle)) {
    return memorySvc.save({ type: 'project', title, content }, scope);
  }

  function embed(id: string, v: Buffer, projectId = defaultProjectScope(db.handle).projectId) {
    createRepositories(db.handle.db).vectors.insertEmbedding(id, v, partitionKeyFor(projectId));
  }

  function evaluate(
    sourceId: string,
    targetId: string,
    opts: EvaluatePairOptions = current,
    repos: Repositories = createRepositories(db.handle.db),
  ): PairEvaluation {
    return evaluatePair(repos, defaultProjectScope(db.handle).projectId, sourceId, targetId, opts);
  }

  function channels(e: PairEvaluation) {
    if (e.kind !== 'channels') throw new Error(`expected channel verdicts, got ${e.kind}`);
    return e;
  }

  function unrelatedPair(): { source: string; target: string } {
    const target = save(
      'Quarterly offsite venue',
      'The offsite moved to the lakeside hall in May.',
    );
    const source = save(
      'Linter rule for imports',
      'Imports are sorted by the formatter before every commit.',
    );
    return { source: source.id, target: target.id };
  }

  it('control: a pair no channel admits returns three not_admitted verdicts', () => {
    const { source, target } = unrelatedPair();
    embed(source, vec([1, 0]));
    embed(target, vec([0, 1]));
    const e = channels(evaluate(source, target));
    expect([e.lexical, e.vector, e.entity]).toEqual([
      'not_admitted',
      'not_admitted',
      'not_admitted',
    ]);
    expect(e.lexicalSimilarity).toBeLessThan(LEXICAL_CANDIDATE_FLOOR);
    expect(e.vectorSimilarity).toBeLessThan(VEC_THRESHOLD);
  });

  it('a lexically admitted pair returns lexical admitted', () => {
    const target = save('Two-space indentation', 'use two-space indentation always in every file');
    const source = save('Indentation again', 'use two-space indentation always in every file');
    expect(channels(evaluate(source.id, target.id)).lexical).toBe('admitted');
  });

  it('a pair exactly at the lexical floor is admitted, as at save time', () => {
    const target = save('Floor', 'alpha beta gamma');
    const source = save('Floor source', 'alpha beta gamma delta epsilon');
    const e = channels(evaluate(source.id, target.id));
    expect(e.lexicalSimilarity).toBe(LEXICAL_CANDIDATE_FLOOR);
    expect(e.lexical).toBe('admitted');
  });

  it('a vector-admitted pair returns vector admitted from the stored embeddings', () => {
    const { source, target } = unrelatedPair();
    embed(source, vec([1, 0]));
    embed(target, vec([1, 0.2]));
    const e = channels(evaluate(source, target));
    expect(e.vector).toBe('admitted');
    expect(e.vectorSimilarity).toBeGreaterThanOrEqual(VEC_THRESHOLD);
  });

  it('a shared entity the rarity gate blocks still returns entity admitted', () => {
    const repos = createRepositories(db.handle.db);
    const projectId = defaultProjectScope(db.handle).projectId;
    for (let i = 0; i < 6; i++) {
      const m = save(`Ticket note ${i}`, `ticket note number ${i}`);
      repos.entities.linkMemory(m.id, projectId, [{ kind: 'ticket', value: 'PROJ-1' }], new Date());
    }
    const { source, target } = unrelatedPair();
    for (const id of [source, target]) {
      repos.entities.linkMemory(id, projectId, [{ kind: 'ticket', value: 'PROJ-1' }], new Date());
    }
    const [saved] = repos.memory.unsafeGetByIds([source]);
    const detected = findSaveTimeCandidates(repos, saved!, { perSaveMax: 50 }, [
      { kind: 'ticket', value: 'PROJ-1' },
    ]).candidates;
    expect(detected.some((c) => c.targetId === target && c.source === 'entity')).toBe(false);

    expect(channels(evaluate(source, target)).entity).toBe('admitted');
  });

  it('a target ranked beyond CANDIDATE_POOL_SIZE that clears the floor returns lexical admitted', () => {
    const repos = createRepositories(db.handle.db);
    for (let i = 0; i < CANDIDATE_POOL_SIZE + 5; i++) {
      save(`Short ${i}`, 'deploy freeze friday');
    }
    const target = save(
      'Long note',
      `deploy freeze friday ${Array.from({ length: 60 }, (_, i) => `filler${i}`).join(' ')}`,
    );
    const source = save('Freeze', 'deploy freeze friday');
    const detected = findSaveTimeCandidates(repos, source, { perSaveMax: 100 }).candidates;
    expect(detected.some((c) => c.targetId === target.id)).toBe(false);

    expect(channels(evaluate(source.id, target.id)).lexical).toBe('admitted');
  });

  it.each(['source', 'target'] as const)(
    'a missing embedding on the %s returns vector unknown',
    (missing) => {
      const { source, target } = unrelatedPair();
      if (missing !== 'source') embed(source, vec([1, 0]));
      if (missing !== 'target') embed(target, vec([0, 1]));
      const e = channels(evaluate(source, target));
      expect(e.vector).toBe('unknown');
      expect(e.vectorSimilarity).toBeNull();
    },
  );

  it('a stale vector index returns vector unknown, even below the threshold', () => {
    const { source, target } = unrelatedPair();
    embed(source, vec([1, 0]));
    embed(target, vec([0, 1]));
    const e = channels(evaluate(source, target, { vectorIndexCurrent: false }));
    expect(e.vector).toBe('unknown');
    expect(e.vectorSimilarity).toBeNull();
  });

  it('a target scanned without links is still checked by fresh extraction', () => {
    const repos = createRepositories(db.handle.db);
    const projectId = defaultProjectScope(db.handle).projectId;
    const target = save('Session store', 'Expiry is enforced in src/lib/session-expiry.ts today.');
    repos.entities.markScanned(target.id, new Date());
    const source = save('Login lifetime', 'Operators edited src/lib/session-expiry.ts last week.');
    repos.entities.linkMemory(
      source.id,
      projectId,
      [{ kind: 'path', value: 'src/lib/session-expiry.ts' }],
      new Date(),
    );
    expect(repos.entities.findEntitiesForMemory(target.id)).toEqual([]);
    expect(channels(evaluate(source.id, target.id)).entity).toBe('admitted');
  });

  it.each(['source', 'target'] as const)(
    'an extraction that throws for the %s returns entity unknown',
    (side) => {
      const { source, target } = unrelatedPair();
      const failing = side === 'source' ? 'Imports are sorted' : 'The offsite moved';
      const extract = (title: string, content: string) => {
        if (content.includes(failing)) throw new Error('extractor failed');
        return extractEntities(title, content);
      };
      expect(channels(evaluate(source, target, { ...current, extract })).entity).toBe('unknown');
    },
  );

  it('an endpoint longer than DRAIN_MAX_PAIR_CHARS is unknown, and its text is never loaded', () => {
    const repos = createRepositories(db.handle.db);
    const target = save('Huge', 'word '.repeat(Math.ceil(DRAIN_MAX_PAIR_CHARS / 5) + 1));
    const source = save('Small', 'a short unrelated note');
    const read = repos.memory.findBoundedEndpoints.bind(repos.memory);
    const loaded: (string | null)[] = [];
    const memoryRepo = Object.create(repos.memory) as typeof repos.memory;
    memoryRepo.findBoundedEndpoints = (o) => {
      const rows = read(o);
      for (const r of rows) loaded.push(r.content);
      return rows;
    };
    let extracted = 0;
    const extract = (title: string, content: string) => {
      extracted++;
      return extractEntities(title, content);
    };
    const e = evaluate(
      source.id,
      target.id,
      { ...current, extract },
      { ...repos, memory: memoryRepo },
    );
    expect(e.kind).toBe('oversized');
    expect(loaded).toContain(null);
    expect(extracted).toBe(0);
  });

  it('control: an endpoint exactly at DRAIN_MAX_PAIR_CHARS is evaluated', () => {
    const title = 'Edge';
    const target = save(title, 'x'.repeat(DRAIN_MAX_PAIR_CHARS - title.length));
    const source = save('Small', 'a short unrelated note');
    expect(evaluate(source.id, target.id).kind).toBe('channels');
  });

  it('a missing endpoint row is unreadable', () => {
    const { source } = unrelatedPair();
    expect(evaluate(source, 'no-such-memory').kind).toBe('unreadable');
  });

  it('an endpoint in another project is unreadable, never evaluated', () => {
    const other = projects.create({ slug: 'other-project' });
    const { source } = unrelatedPair();
    const foreign = save(
      'Foreign',
      'Imports are sorted by the formatter before every commit.',
      projectScope(other.id),
    );
    expect(evaluate(source, foreign.id).kind).toBe('unreadable');
  });

  it('a read that throws returns failed instead of throwing', () => {
    const repos = createRepositories(db.handle.db);
    const { source, target } = unrelatedPair();
    const vectors = Object.create(repos.vectors) as typeof repos.vectors;
    vectors.pairCosineDistance = () => {
      throw new Error('vector read failed');
    };
    const e = evaluate(source, target, current, { ...repos, vectors });
    expect(e.kind).toBe('failed');
  });

  it('a retired endpoint is reported as retired without reading any channel', () => {
    const repos = createRepositories(db.handle.db);
    const { source, target } = unrelatedPair();
    repos.memory.archiveOne(target);
    let extracted = 0;
    const extract = (title: string, content: string) => {
      extracted++;
      return extractEntities(title, content);
    };
    expect(evaluate(source, target, { ...current, extract })).toEqual({
      kind: 'retired',
      sourceStatus: 'active',
      targetStatus: 'archived',
    });
    expect(extracted).toBe(0);
  });
});

describe('evaluatePair agrees with detection over the save-time fixture', () => {
  function bagOfWordsVector(text: string): Buffer {
    const v = new Float32Array(768);
    for (const term of tokenSet(text)) {
      let h = 0x811c9dc5;
      for (let i = 0; i < term.length; i++) h = Math.imul(h ^ term.charCodeAt(i), 0x01000193) >>> 0;
      v[h % 768]! += 1;
    }
    const norm = Math.hypot(...v) || 1;
    for (let i = 0; i < v.length; i++) v[i]! /= norm;
    return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  }

  it('every candidate detection returns at an unbounded cap is admitted by evaluatePair on some channel', async () => {
    const repos = createRepositories(db.handle.db);
    const scope = defaultProjectScope(db.handle);
    const saved = [];
    for (const item of [...SAVE_TIME_BASE, ...SAVE_TIME_SAVES]) {
      const m = memorySvc.save(
        { type: item.type, title: item.title, content: item.content },
        scope,
      );
      repos.vectors.insertEmbedding(
        m.id,
        bagOfWordsVector(`${m.title}\n\n${m.content}`),
        partitionKeyFor(scope.projectId),
      );
      await runPostSaveSteps({ repos }, m, scope);
      saved.push(m);
    }

    const bySource = { vec: 0, fts: 0, entity: 0 };
    const disagreements: string[] = [];
    for (const m of saved) {
      const found = findSaveTimeCandidates(
        repos,
        m,
        { perSaveMax: Number.MAX_SAFE_INTEGER },
        extractEntities(m.title, m.content),
      );
      for (const c of found.candidates) {
        bySource[c.source]++;
        const e = evaluatePair(repos, scope.projectId, m.id, c.targetId, {
          vectorIndexCurrent: true,
        });
        const admitted =
          e.kind === 'channels' &&
          (e.lexical === 'admitted' || e.vector === 'admitted' || e.entity === 'admitted');
        if (!admitted) disagreements.push(`${m.title} -> ${c.title} (${c.source}): ${e.kind}`);
      }
    }

    expect(disagreements).toEqual([]);
    expect(bySource.vec).toBeGreaterThan(0);
    expect(bySource.fts).toBeGreaterThan(0);
    expect(bySource.entity).toBeGreaterThan(0);
  });
});
