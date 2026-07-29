import { eq, sql } from 'drizzle-orm';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { memoryRelations } from '../db/schema/memory-relations.js';
import { memory } from '../db/schema/memory.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { deriveTitle, MemoryService } from './memory.js';
import { ProjectsService } from './projects.js';
import { RelationsService } from './relations.js';
import { findSaveTimeCandidates } from './save-time-candidates.js';
import { projectScope, SCOPE_GLOBAL, type Scope } from './scope.js';

let db: TestDb;
let memorySvc: MemoryService;
let projects: ProjectsService;
let relations: RelationsService;

beforeEach(() => {
  db = createTestDb();
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
      SCOPE_GLOBAL,
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
      SCOPE_GLOBAL,
    );
    const second = memorySvc.saveWithTopicKey(
      {
        type: 'project',
        title: 'Auth via opaque tokens',
        content: 'auth via opaque tokens',
        topicKey: 'decision/auth-model',
      },
      SCOPE_GLOBAL,
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
        SCOPE_GLOBAL,
      ),
    ).toThrow(/128/);
  });

  it('empty topic_key is normalized to null', () => {
    const { memory: m } = memorySvc.saveWithTopicKey(
      { type: 'project', title: 'Empty topic key', content: 'x', topicKey: '   ' },
      SCOPE_GLOBAL,
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
        SCOPE_GLOBAL,
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
  // A 2-row corpus drives FTS5 IDF to ~1e-6, so the old inverted-similarity
  // gate passed by scoring the "true match" as noise — a fix validated
  // against a fixture that small proves nothing. These use >=50 heterogeneous
  // rows so the pool genuinely competes (fix-retrieval-ranking-math).
  function fillHeterogeneousCorpus(n: number): void {
    for (let i = 0; i < n; i++) {
      memorySvc.save(
        {
          type: 'feedback',
          title: `Rollout schedule entry ${i}`,
          content: `rollout schedule entry ${i} covers timezone rotation and on-call handoff details for cycle ${i}`,
        },
        SCOPE_GLOBAL,
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
      SCOPE_GLOBAL,
    );
    const duplicate = memorySvc.save(
      {
        type: 'feedback',
        title: 'Use two-space indentation always',
        content: 'use two-space indentation always in every file',
      },
      SCOPE_GLOBAL,
    );

    const cands = findSaveTimeCandidates(createRepositories(db.handle.db), duplicate, {
      perSaveMax: 5,
    });
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
        SCOPE_GLOBAL,
      );
      const duplicate = memorySvc.save(
        {
          type: 'feedback',
          title: 'Prefer explicit error types over generic Error',
          content: 'prefer explicit error types over a generic Error across the codebase',
        },
        SCOPE_GLOBAL,
      );

      const cands = findSaveTimeCandidates(createRepositories(db.handle.db), duplicate, {
        perSaveMax: 5,
      });
      expect(cands.some((c) => c.targetId === original.id && c.source === 'fts')).toBe(true);
    },
  );

  it('a row sharing only a near-universal term is not reported near 1.0 and does not consume the candidate budget', () => {
    // Every filler row shares the word "rollout" (near-universal here) with
    // the saved row, but only the genuine match shares its distinctive terms.
    fillHeterogeneousCorpus(55);
    const genuine = memorySvc.save(
      {
        type: 'feedback',
        title: 'Canary rollout strategy for the checkout service',
        content:
          'canary rollout strategy for the checkout service reduces blast radius during releases',
      },
      SCOPE_GLOBAL,
    );
    const saved = memorySvc.save(
      {
        type: 'feedback',
        title: 'Canary rollout plan for the checkout service',
        content:
          'canary rollout plan for the checkout service reduces blast radius during releases too',
      },
      SCOPE_GLOBAL,
    );

    const cands = findSaveTimeCandidates(createRepositories(db.handle.db), saved, {
      perSaveMax: 5,
    });
    const genuineMatch = cands.find((c) => c.targetId === genuine.id);
    expect(genuineMatch).toBeDefined();
    expect(genuineMatch!.similarity).toBeGreaterThan(0.5);
    for (const c of cands) {
      if (c.targetId !== genuine.id) expect(c.similarity).toBeLessThan(0.5);
    }
  });

  it('surfaces FTS candidates for non-ASCII content (Unicode-aware MATCH builder)', () => {
    // No embedder is wired here, so any candidate MUST come from FTS — which the
    // old ASCII-only builder could never produce for CJK content (it returned '').
    const a = memorySvc.save(
      { type: 'feedback', title: '認証 トークン 設計', content: '認証 トークン 設計 の メモ' },
      SCOPE_GLOBAL,
    );
    const b = memorySvc.save(
      {
        type: 'feedback',
        title: '認証 トークン 設計 改訂',
        content: '認証 トークン 設計 の 改訂 メモ',
      },
      SCOPE_GLOBAL,
    );
    const cands = findSaveTimeCandidates(createRepositories(db.handle.db), b, { perSaveMax: 5 });
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
        SCOPE_GLOBAL,
      );
    }
    const recent = memorySvc.save(
      {
        type: 'feedback',
        title: 'Similar marker keyword extra',
        content: 'similar marker keyword extra',
      },
      SCOPE_GLOBAL,
    );
    const cands = findSaveTimeCandidates(createRepositories(db.handle.db), recent, {
      perSaveMax: 3,
    });
    expect(cands.length).toBeLessThanOrEqual(3);
  });

  it('skips memories outside the saved row scope (cross-scope safety)', () => {
    const projA = projects.create({ slug: 'proj-a' });
    const scopeA: Scope = projectScope(projA.id);

    const _global = memorySvc.save(
      { type: 'feedback', title: 'Cross-scope marker', content: 'cross-scope marker' },
      SCOPE_GLOBAL,
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
    });
    // The global match must NOT appear because it has scope='global'.
    expect(cands.some((c) => c.targetId === _global.id)).toBe(false);
  });

  it('does not re-surface a target the new memory ancestry already judged not_conflict', () => {
    const x = memorySvc.save(
      { type: 'feedback', title: 'shared dedup marker', content: 'shared dedup marker token' },
      SCOPE_GLOBAL,
    );
    const y = memorySvc.save(
      {
        type: 'feedback',
        title: 'shared dedup marker two',
        content: 'shared dedup marker token two',
      },
      SCOPE_GLOBAL,
    );
    const base = memorySvc.saveWithTopicKey(
      {
        type: 'feedback',
        title: 'shared dedup marker base',
        content: 'shared dedup marker token base',
        topicKey: 'dedup/k',
      },
      SCOPE_GLOBAL,
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
      SCOPE_GLOBAL,
    ).memory;
    expect(revised.replaces).toEqual([base.id]);

    const cands = findSaveTimeCandidates(createRepositories(db.handle.db), revised, {
      perSaveMax: 10,
    });
    const ids = cands.map((c) => c.targetId);
    expect(ids).not.toContain(x.id); // dismissed not_conflict → suppressed
    expect(ids).toContain(y.id); // conflicts_with → still surfaces
  });

  // `saveWithTopicKey` sets a single-element `replaces`, so reading only the
  // just-saved row's own `replaces` sees one hop and loses a dismissal made
  // two or more saves back on the same topic.
  it('carries a not_conflict dismissal forward across two saves of the same topic', () => {
    const x = memorySvc.save(
      { type: 'feedback', title: 'shared dedup marker', content: 'shared dedup marker token' },
      SCOPE_GLOBAL,
    );
    const y = memorySvc.save(
      {
        type: 'feedback',
        title: 'shared dedup marker two',
        content: 'shared dedup marker token two',
      },
      SCOPE_GLOBAL,
    );
    const saveTopic = (suffix: string) =>
      memorySvc.saveWithTopicKey(
        {
          type: 'feedback',
          title: `shared dedup marker ${suffix}`,
          content: `shared dedup marker token ${suffix}`,
          topicKey: 'dedup/deep',
        },
        SCOPE_GLOBAL,
      ).memory;

    const base = saveTopic('base');
    const px = relations.createPending({ sourceId: base.id, targetId: x.id });
    relations.judge(px.judgmentId, { relation: 'not_conflict', actor: 'tester', kind: 'agent' });
    const py = relations.createPending({ sourceId: base.id, targetId: y.id });
    relations.judge(py.judgmentId, { relation: 'conflicts_with', actor: 'tester', kind: 'agent' });

    const v2 = saveTopic('v2');
    const v3 = saveTopic('v3');
    // Two hops from the dismissal: v3 -> v2 -> base, and no relation row
    // anywhere references v3 as a source.
    expect(v3.replaces).toEqual([v2.id]);
    expect(v2.replaces).toEqual([base.id]);

    const ids = findSaveTimeCandidates(createRepositories(db.handle.db), v3, {
      perSaveMax: 10,
    }).map((c) => c.targetId);
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
      SCOPE_GLOBAL,
    );
    const second = memorySvc.saveWithTopicKey(
      {
        type: 'project',
        title: 'Auth model opaque tokens',
        content: 'auth model opaque tokens',
        topicKey: 'decision/auth',
      },
      SCOPE_GLOBAL,
    );
    // second.memory.replaces contains first.memory.id; candidate
    // detection must not re-surface it.
    const cands = findSaveTimeCandidates(createRepositories(db.handle.db), second.memory, {
      perSaveMax: 5,
    });
    expect(cands.some((c) => c.targetId === first.memory.id)).toBe(false);
  });
});

describe('findSaveTimeCandidates — entity overlap channel (add-entity-index)', () => {
  it('surfaces a low-vocabulary-overlap contradiction about the same rare file', () => {
    const repos = createRepositories(db.handle.db);
    // Dilute the scope so the entity's single existing link stays well
    // under the 15% rarity gate (1 link / 12 memories ≈ 8%).
    for (let i = 0; i < 10; i++) {
      memorySvc.save(
        { type: 'project', title: `Filler ${i}`, content: `filler note ${i}` },
        SCOPE_GLOBAL,
      );
    }
    const chown = memorySvc.save(
      { type: 'project', title: 'Use chown 10001', content: 'use chown 10001 for the data dir' },
      SCOPE_GLOBAL,
    );
    repos.entities.linkMemory(
      chown.id,
      'global',
      null,
      [{ kind: 'path', value: 'docs/docker.md' }],
      new Date(),
    );
    const root = memorySvc.save(
      { type: 'project', title: 'Run as root', content: 'run as root instead' },
      SCOPE_GLOBAL,
    );

    const cands = findSaveTimeCandidates(repos, root, { perSaveMax: 5 }, [
      { kind: 'path', value: 'docs/docker.md' },
    ]);
    const match = cands.find((c) => c.targetId === chown.id);
    expect(match).toBeDefined();
    expect(match!.source).toBe('entity');
    expect(match!.entityValue).toBe('docs/docker.md');
  });

  it('a very common entity surfaces nothing', () => {
    const repos = createRepositories(db.handle.db);
    // 5 of 6 scope memories link the same entity — well over the 15% rarity
    // gate, so it must generate zero candidates despite being an exact match.
    for (let i = 0; i < 5; i++) {
      const m = memorySvc.save(
        { type: 'project', title: `Note ${i}`, content: `note number ${i}` },
        SCOPE_GLOBAL,
      );
      repos.entities.linkMemory(
        m.id,
        'global',
        null,
        [{ kind: 'ticket', value: 'PROJ-1' }],
        new Date(),
      );
    }
    const saved = memorySvc.save(
      { type: 'project', title: 'Note last', content: 'note number last' },
      SCOPE_GLOBAL,
    );

    const cands = findSaveTimeCandidates(repos, saved, { perSaveMax: 5 }, [
      { kind: 'ticket', value: 'PROJ-1' },
    ]);
    expect(cands.some((c) => c.source === 'entity')).toBe(false);
  });

  it('the per-save cap holds across vec/fts/entity channels combined', () => {
    const repos = createRepositories(db.handle.db);
    // Dilute the scope so 3 entity links stay under the 15% rarity gate
    // (3 / 24 = 12.5%) while still producing more raw matches than the cap.
    for (let i = 0; i < 20; i++) {
      memorySvc.save(
        { type: 'project', title: `Filler ${i}`, content: `filler note ${i}` },
        SCOPE_GLOBAL,
      );
    }
    for (let i = 0; i < 3; i++) {
      const m = memorySvc.save(
        {
          type: 'project',
          title: `Distinct note ${i}`,
          content: `distinct note ${i} about topic ${i}`,
        },
        SCOPE_GLOBAL,
      );
      repos.entities.linkMemory(
        m.id,
        'global',
        null,
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
      SCOPE_GLOBAL,
    );

    const cands = findSaveTimeCandidates(repos, saved, { perSaveMax: 2 }, [
      { kind: 'error_code', value: 'ENOENT' },
    ]);
    expect(cands.some((c) => c.source === 'entity')).toBe(true);
    expect(cands.length).toBeLessThanOrEqual(2);
  });

  it('reports containment, not rarity, and still leads the merged list', () => {
    const repos = createRepositories(db.handle.db);
    // A near-duplicate the lexical pass scores ~1.0, plus an entity match that
    // shares the path and no vocabulary at all. Under the old rarity score the
    // entity row reported ~0.95 purely because the scope was large; it must now
    // report its (near-zero) containment and lead on precedence instead.
    for (let i = 0; i < 18; i++) {
      memorySvc.save(
        { type: 'project', title: `Filler ${i}`, content: `filler note ${i}` },
        SCOPE_GLOBAL,
      );
    }
    const nearDuplicate = memorySvc.save(
      { type: 'project', title: 'Deploy runbook', content: 'the deploy runbook lives here' },
      SCOPE_GLOBAL,
    );
    const entityOnly = memorySvc.save(
      { type: 'project', title: 'Ownership', content: 'chown ten thousand and one' },
      SCOPE_GLOBAL,
    );
    repos.entities.linkMemory(
      entityOnly.id,
      'global',
      null,
      [{ kind: 'path', value: 'docs/docker.md' }],
      new Date(),
    );
    const saved = memorySvc.save(
      { type: 'project', title: 'Deploy runbook', content: 'the deploy runbook lives here' },
      SCOPE_GLOBAL,
    );

    const cands = findSaveTimeCandidates(repos, saved, { perSaveMax: 1 }, [
      { kind: 'path', value: 'docs/docker.md' },
    ]);

    // perSaveMax of 1 is the whole point: the entity row must occupy it even
    // though the near-duplicate scores far higher on the shared quantity.
    expect(cands.map((c) => c.targetId)).toEqual([entityOnly.id]);
    expect(cands[0]!.similarity).toBeLessThan(0.2);

    const wide = findSaveTimeCandidates(repos, saved, { perSaveMax: 5 }, [
      { kind: 'path', value: 'docs/docker.md' },
    ]);
    expect(wide[0]!.targetId).toBe(entityOnly.id);
    expect(wide.find((c) => c.targetId === nearDuplicate.id)!.similarity).toBeGreaterThan(
      wide[0]!.similarity,
    );
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
            for (const op of ops) {
              const content = op.content.trim() || 'x';
              svc.saveWithTopicKey(
                {
                  type: 'project',
                  title: deriveTitle(content),
                  content,
                  topicKey: `decision/${op.key}`,
                },
                SCOPE_GLOBAL,
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
    const a = memorySvc.save({ type: 'feedback', title: 'Memory a', content: 'a' }, SCOPE_GLOBAL);
    const b = memorySvc.save({ type: 'feedback', title: 'Memory b', content: 'b' }, SCOPE_GLOBAL);

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
    const a = memorySvc.save({ type: 'feedback', title: 'Memory a', content: 'a' }, SCOPE_GLOBAL);
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
    const a = memorySvc.save({ type: 'feedback', title: 'Memory a', content: 'a' }, SCOPE_GLOBAL);
    const b = memorySvc.save({ type: 'feedback', title: 'Memory b', content: 'b' }, SCOPE_GLOBAL);
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
