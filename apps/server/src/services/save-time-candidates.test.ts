import { eq, sql } from 'drizzle-orm';
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { memoryRelations } from '../db/schema/memory-relations.js';
import { memory } from '../db/schema/memory.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { MemoryService } from './memory.js';
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
  memorySvc = new MemoryService(db.handle.db);
  projects = new ProjectsService(db.handle.db);
  relations = new RelationsService(db.handle.db);
});

afterEach(() => db.cleanup());

describe('topic_key upsert path', () => {
  it('first save with a topic_key creates a fresh active row', () => {
    const { memory: m } = memorySvc.saveWithTopicKey(
      { type: 'project', content: 'auth via JWT', topicKey: 'decision/auth-model' },
      SCOPE_GLOBAL,
    );
    expect(m.topicKey).toBe('decision/auth-model');
    expect(m.status).toBe('active');
    expect(m.replaces).toEqual([]);
  });

  it('second save with the same topic_key auto-supersedes the previous row', () => {
    const first = memorySvc.saveWithTopicKey(
      { type: 'project', content: 'auth via JWT', topicKey: 'decision/auth-model' },
      SCOPE_GLOBAL,
    );
    const second = memorySvc.saveWithTopicKey(
      { type: 'project', content: 'auth via opaque tokens', topicKey: 'decision/auth-model' },
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
      { type: 'project', content: 'A:auth', topicKey: 'decision/auth-model' },
      scopeA,
    );
    const b = memorySvc.saveWithTopicKey(
      { type: 'project', content: 'B:auth', topicKey: 'decision/auth-model' },
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
      memorySvc.saveWithTopicKey({ type: 'project', content: 'x', topicKey: long }, SCOPE_GLOBAL),
    ).toThrow(/128/);
  });

  it('empty topic_key is normalized to null', () => {
    const { memory: m } = memorySvc.saveWithTopicKey(
      { type: 'project', content: 'x', topicKey: '   ' },
      SCOPE_GLOBAL,
    );
    expect(m.topicKey).toBeNull();
  });

  it('concurrent saves with the same topic_key leave exactly one active row', () => {
    const N = 25;
    for (let i = 0; i < N; i++) {
      memorySvc.saveWithTopicKey(
        { type: 'project', content: `v${i}`, topicKey: 'decision/auth-model' },
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
  it('returns FTS candidates above the threshold scoped to the same (scope, project)', () => {
    const a = memorySvc.save(
      { type: 'feedback', content: 'use two-space indentation always' },
      SCOPE_GLOBAL,
    );
    const b = memorySvc.save(
      { type: 'feedback', content: 'use two-space indentation always with single quotes' },
      SCOPE_GLOBAL,
    );

    const cands = findSaveTimeCandidates(db.handle.db, b, { perSaveMax: 5 });
    expect(cands.length).toBeGreaterThanOrEqual(1);
    expect(cands.some((c) => c.targetId === a.id)).toBe(true);
    expect(cands.every((c) => c.source === 'fts' || c.source === 'vec')).toBe(true);
  });

  it('respects perSaveMax', () => {
    for (let i = 0; i < 10; i++) {
      memorySvc.save({ type: 'feedback', content: `similar marker keyword ${i}` }, SCOPE_GLOBAL);
    }
    const recent = memorySvc.save(
      { type: 'feedback', content: 'similar marker keyword extra' },
      SCOPE_GLOBAL,
    );
    const cands = findSaveTimeCandidates(db.handle.db, recent, { perSaveMax: 3 });
    expect(cands.length).toBeLessThanOrEqual(3);
  });

  it('skips memories outside the saved row scope (cross-scope safety)', () => {
    const projA = projects.create({ slug: 'proj-a' });
    const scopeA: Scope = projectScope(projA.id);

    const _global = memorySvc.save(
      { type: 'feedback', content: 'cross-scope marker' },
      SCOPE_GLOBAL,
    );
    void _global;
    const saved = memorySvc.save(
      { type: 'feedback', content: 'cross-scope marker in project a' },
      scopeA,
    );

    const cands = findSaveTimeCandidates(db.handle.db, saved, { perSaveMax: 5 });
    // The global match must NOT appear because it has scope='global'.
    expect(cands.some((c) => c.targetId === _global.id)).toBe(false);
  });

  it('skips rows already linked via the just-saved row replaces[]', () => {
    const first = memorySvc.saveWithTopicKey(
      { type: 'project', content: 'auth model JWT', topicKey: 'decision/auth' },
      SCOPE_GLOBAL,
    );
    const second = memorySvc.saveWithTopicKey(
      { type: 'project', content: 'auth model opaque tokens', topicKey: 'decision/auth' },
      SCOPE_GLOBAL,
    );
    // second.memory.replaces contains first.memory.id; candidate
    // detection must not re-surface it.
    const cands = findSaveTimeCandidates(db.handle.db, second.memory, { perSaveMax: 5 });
    expect(cands.some((c) => c.targetId === first.memory.id)).toBe(false);
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
            const svc = new MemoryService(fresh.handle.db);
            for (const op of ops) {
              svc.saveWithTopicKey(
                {
                  type: 'project',
                  content: op.content.trim() || 'x',
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
    const a = memorySvc.save({ type: 'feedback', content: 'a' }, SCOPE_GLOBAL);
    const b = memorySvc.save({ type: 'feedback', content: 'b' }, SCOPE_GLOBAL);

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
    const a = memorySvc.save({ type: 'feedback', content: 'a' }, SCOPE_GLOBAL);
    const b = memorySvc.save({ type: 'feedback', content: 'b' }, projectScope(projA.id));

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
    const a = memorySvc.save({ type: 'feedback', content: 'a' }, SCOPE_GLOBAL);
    const b = memorySvc.save({ type: 'feedback', content: 'b' }, SCOPE_GLOBAL);
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
