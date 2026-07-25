import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveTitle } from '../../services/memory.js';
import { REVIEW_TTL_MS } from '../../services/review.js';
import { createTestDb, type TestDb } from '../../test/db.js';
import { confirmations } from '../schema/confirmations.js';
import { memory, type NewMemory } from '../schema/memory.js';
import { projects } from '../schema/projects.js';

import { MemoryRepository } from './memory-repository.js';

function row(overrides: Partial<NewMemory> & { id: string; content: string }): NewMemory {
  return {
    title: deriveTitle(overrides.content),
    scope: 'global',
    projectId: null,
    type: 'project',
    tags: [],
    status: 'active',
    replaces: [],
    createdAt: new Date(1_000),
    lastSeenAt: new Date(1_000),
    ...overrides,
  };
}

describe('MemoryRepository', () => {
  let t: TestDb;
  let repo: MemoryRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new MemoryRepository(t.handle.db);
    t.handle.db
      .insert(projects)
      .values([
        { id: 'p1', slug: 'project-one', createdAt: new Date(500) },
        { id: 'p2', slug: 'project-two', createdAt: new Date(500) },
      ])
      .run();
  });

  afterEach(() => {
    t.cleanup();
  });

  describe('adminSearchFts', () => {
    beforeEach(() => {
      t.handle.db
        .insert(memory)
        .values([
          row({
            id: '01A',
            content: 'alpha bravo',
            createdAt: new Date(1_000),
            type: 'project',
          }),
          row({
            id: '01B',
            content: 'bravo charlie',
            createdAt: new Date(2_000),
            scope: 'project',
            projectId: 'p1',
            status: 'archived',
            type: 'project',
          }),
          row({ id: '01C', content: 'delta', createdAt: new Date(3_000), type: 'project' }),
        ])
        .run();
    });

    it('filters by status in SQL', () => {
      const hits = repo.adminSearchFts('bravo', {
        status: 'active',
        limit: 10,
        offset: 0,
      });
      expect(hits.map((m) => m.id)).toEqual(['01A']);
    });

    it('filters by project scope in SQL', () => {
      const hits = repo.adminSearchFts('bravo', {
        status: 'archived',
        project: { kind: 'project', projectId: 'p1' },
        limit: 10,
        offset: 0,
      });
      expect(hits.map((m) => m.id)).toEqual(['01B']);
    });

    it('returns hydrated rows', () => {
      const [hit] = repo.adminSearchFts('delta', { status: 'active', limit: 10, offset: 0 });
      expect(hit?.content).toBe('delta');
      expect(hit?.status).toBe('active');
    });

    it('pages consistently with limit/offset', () => {
      t.handle.db
        .insert(memory)
        .values([
          row({ id: 'P1', content: 'bravo', createdAt: new Date(11_000) }),
          row({ id: 'P2', content: 'bravo', createdAt: new Date(10_000) }),
        ])
        .run();
      const all = repo
        .adminSearchFts('bravo', { status: 'active', limit: 3, offset: 0 })
        .map((m) => m.id);
      const first = repo
        .adminSearchFts('bravo', { status: 'active', limit: 1, offset: 0 })
        .map((m) => m.id);
      const second = repo
        .adminSearchFts('bravo', { status: 'active', limit: 1, offset: 1 })
        .map((m) => m.id);
      const third = repo
        .adminSearchFts('bravo', { status: 'active', limit: 1, offset: 2 })
        .map((m) => m.id);
      expect([...first, ...second, ...third].sort()).toEqual([...all].sort());
    });

    it('returns empty for no matches', () => {
      expect(repo.adminSearchFts('zulu', { status: 'active', limit: 10, offset: 0 })).toEqual([]);
    });

    it('does not under-fill a page when higher-ranked rows are filtered out by status', () => {
      // The 3 highest-ranked matches are archived; a post-fetch filter would return zero active rows.
      t.handle.db
        .insert(memory)
        .values([
          row({ id: 'ARC1', content: 'bravo', createdAt: new Date(9_000), status: 'archived' }),
          row({ id: 'ARC2', content: 'bravo', createdAt: new Date(8_000), status: 'archived' }),
          row({ id: 'ARC3', content: 'bravo', createdAt: new Date(7_000), status: 'archived' }),
          row({ id: 'ACT1', content: 'bravo', createdAt: new Date(6_000), status: 'active' }),
          row({ id: 'ACT2', content: 'bravo', createdAt: new Date(5_000), status: 'active' }),
          row({ id: 'ACT3', content: 'bravo', createdAt: new Date(4_000), status: 'active' }),
        ])
        .run();

      const page = repo.adminSearchFts('bravo', { status: 'active', limit: 3, offset: 0 });
      expect(page.map((m) => m.id)).toEqual(['ACT1', 'ACT2', 'ACT3']);
    });
  });

  describe('adminList', () => {
    beforeEach(() => {
      t.handle.db
        .insert(memory)
        .values([
          row({ id: '02A', content: 'g active', createdAt: new Date(1_000) }),
          row({ id: '02B', content: 'g archived', status: 'archived', createdAt: new Date(2_000) }),
          row({
            id: '02C',
            content: 'p1 active',
            scope: 'project',
            projectId: 'p1',
            type: 'feedback',
            createdAt: new Date(3_000),
          }),
          row({
            id: '02D',
            content: 'p2 active',
            scope: 'project',
            projectId: 'p2',
            createdAt: new Date(4_000),
          }),
        ])
        .run();
    });

    it('filters by status and orders newest first', () => {
      const rows = repo.adminList({ status: 'active', limit: 10, offset: 0 });
      expect(rows.map((m) => m.id)).toEqual(['02D', '02C', '02A']);
    });

    it('filters by type', () => {
      const rows = repo.adminList({ status: 'active', type: 'feedback', limit: 10, offset: 0 });
      expect(rows.map((m) => m.id)).toEqual(['02C']);
    });

    it('filters global-only', () => {
      const rows = repo.adminList({
        status: 'active',
        project: { kind: 'global' },
        limit: 10,
        offset: 0,
      });
      expect(rows.map((m) => m.id)).toEqual(['02A']);
    });

    it('filters by project id', () => {
      const rows = repo.adminList({
        status: 'active',
        project: { kind: 'project', projectId: 'p2' },
        limit: 10,
        offset: 0,
      });
      expect(rows.map((m) => m.id)).toEqual(['02D']);
    });

    it('respects limit and offset', () => {
      const rows = repo.adminList({ status: 'active', limit: 1, offset: 1 });
      expect(rows.map((m) => m.id)).toEqual(['02C']);
    });
  });

  describe('absorbed query helpers', () => {
    beforeEach(() => {
      t.handle.db
        .insert(memory)
        .values([
          row({ id: '03A', content: 'global one', createdAt: new Date(1_000) }),
          row({
            id: '03B',
            content: 'project one',
            scope: 'project',
            projectId: 'p1',
            createdAt: new Date(2_000),
          }),
          row({ id: '03C', content: 'gone', status: 'superseded', createdAt: new Date(3_000) }),
        ])
        .run();
    });

    it('unsafeGetById / unsafeGetByIds / adminGetByIds', () => {
      expect(repo.unsafeGetById('03A')?.content).toBe('global one');
      expect(repo.unsafeGetById('nope')).toBeUndefined();
      expect(repo.unsafeGetByIds([])).toEqual([]);
      expect(
        repo
          .adminGetByIds(['03A', '03B'])
          .map((m) => m.id)
          .sort(),
      ).toEqual(['03A', '03B']);
    });

    it('countRowsByStatus groups all scopes by status in one query', () => {
      const rows = repo.countRowsByStatus();
      const byStatus = Object.fromEntries(rows.map((r) => [r.status, r.count]));
      expect(byStatus).toEqual({ active: 2, superseded: 1 });
    });
  });

  it('adminCountConfirmations counts events for a memory', () => {
    t.handle.db
      .insert(memory)
      .values([row({ id: '04A', content: 'confirmed' })])
      .run();
    t.handle.db
      .insert(confirmations)
      .values([
        { id: 'c1', memoryId: '04A', eventTs: new Date(1_000) },
        { id: 'c2', memoryId: '04A', eventTs: new Date(2_000) },
      ])
      .run();
    expect(repo.adminCountConfirmations('04A')).toBe(2);
    expect(repo.adminCountConfirmations('missing')).toBe(0);
  });

  describe('findDecayCandidateIds (per-type thresholds)', () => {
    const NOW = 1_000_000;

    beforeEach(() => {
      t.handle.db
        .insert(memory)
        .values([
          row({
            id: 'P_OLD',
            content: 'project old',
            type: 'project',
            lastSeenAt: new Date(NOW - 200),
          }),
          row({
            id: 'P_NEW',
            content: 'project new',
            type: 'project',
            lastSeenAt: new Date(NOW - 50),
          }),
          row({
            id: 'U_SAME',
            content: 'user same age',
            type: 'user',
            lastSeenAt: new Date(NOW - 200),
          }),
          row({
            id: 'F_OLD',
            content: 'feedback old',
            type: 'feedback',
            lastSeenAt: new Date(NOW - 2_000),
          }),
          row({
            id: 'F_NEW',
            content: 'feedback new',
            type: 'feedback',
            lastSeenAt: new Date(NOW - 500),
          }),
        ])
        .run();
    });

    it('selects rows past their per-type threshold; longer-lived & fresh rows exempt; missing type uses default', () => {
      const ids = repo.findDecayCandidateIds({
        scope: 'global',
        projectId: null,
        nowMs: NOW,
        thresholdByType: [
          ['project', 100],
          ['user', 10_000],
        ],
        defaultThresholdMs: 1_000, // covers 'feedback' (no explicit entry)
        confidenceFloor: 1,
        reviewTtlByType: [], // escalation disabled for this test — pure recency+confidence rule only
        escalationMultiplier: 2,
      });
      // P_OLD: project age 200 > 100 → in.  P_NEW: 50 < 100 → out.
      // U_SAME: user age 200 < 10_000 → out (longer threshold than project).
      // F_OLD: feedback age 2_000 > default 1_000 → in.  F_NEW: 500 < 1_000 → out.
      expect([...ids].sort()).toEqual(['F_OLD', 'P_OLD']);
    });
  });

  describe('review reads', () => {
    const PROJECT_TTL = REVIEW_TTL_MS.project!;
    const ttlByType = Object.entries(REVIEW_TTL_MS).filter(
      (e): e is [NonNullable<NewMemory['type']>, number] => typeof e[1] === 'number',
    );

    it('latestConfirmationTsByIds returns the max event_ts per id; empty for no input', () => {
      t.handle.db
        .insert(memory)
        .values([row({ id: 'm1', content: 'x' })])
        .run();
      t.handle.db
        .insert(confirmations)
        .values([
          { id: 'k1', memoryId: 'm1', eventTs: new Date(5_000) },
          { id: 'k2', memoryId: 'm1', eventTs: new Date(9_000) },
        ])
        .run();
      const map = repo.latestConfirmationTsByIds(['m1', 'absent']);
      expect(map.get('m1')?.getTime()).toBe(9_000);
      expect(map.has('absent')).toBe(false);
      expect(repo.latestConfirmationTsByIds([]).size).toBe(0);
    });

    it('findNeedsReview returns active in-scope rows past their TTL, oldest baseline first', () => {
      const past = new Date(10_000);
      t.handle.db
        .insert(memory)
        .values([
          row({ id: 'old1', content: 'oldest', createdAt: new Date(1_000) }),
          row({ id: 'old2', content: 'newer', createdAt: past }),
          row({ id: 'fresh', content: 'within ttl', createdAt: new Date(50_000) }),
          row({ id: 'ref', content: 'no ttl type', type: 'reference', createdAt: new Date(1) }),
          row({ id: 'arch', content: 'archived', status: 'archived', createdAt: new Date(1) }),
        ])
        .run();
      const nowMs = past.getTime() + PROJECT_TTL + 1; // old1 & old2 past; fresh within
      const found = repo.findNeedsReview({
        scope: 'global',
        projectId: null,
        nowMs,
        limit: 10,
        ttlByType,
      });
      expect(found.map((m) => m.id)).toEqual(['old1', 'old2']); // oldest baseline first; ref/arch/fresh excluded
    });

    it('findNeedsReview uses the latest confirmation as the baseline', () => {
      t.handle.db
        .insert(memory)
        .values([row({ id: 'c', content: 'confirmed recently', createdAt: new Date(1_000) })])
        .run();
      const nowMs = 1_000 + PROJECT_TTL + 1; // would be stale by created_at alone
      expect(
        repo
          .findNeedsReview({ scope: 'global', projectId: null, nowMs, limit: 10, ttlByType })
          .map((m) => m.id),
      ).toEqual(['c']);
      t.handle.db
        .insert(confirmations)
        .values([{ id: 'cc', memoryId: 'c', eventTs: new Date(nowMs - 1) }])
        .run();
      expect(
        repo.findNeedsReview({ scope: 'global', projectId: null, nowMs, limit: 10, ttlByType }),
      ).toHaveLength(0);
    });

    it('findNeedsReview is scope-isolated and respects limit', () => {
      t.handle.db
        .insert(memory)
        .values([
          row({ id: 'g', content: 'global', createdAt: new Date(1) }),
          row({
            id: 'a1',
            content: 'pa',
            scope: 'project',
            projectId: 'p1',
            createdAt: new Date(1),
          }),
          row({
            id: 'a2',
            content: 'pa2',
            scope: 'project',
            projectId: 'p1',
            createdAt: new Date(2),
          }),
        ])
        .run();
      const nowMs = PROJECT_TTL + 1_000;
      expect(
        repo
          .findNeedsReview({ scope: 'project', projectId: 'p1', nowMs, limit: 10, ttlByType })
          .map((m) => m.id),
      ).toEqual(['a1', 'a2']);
      expect(
        repo
          .findNeedsReview({ scope: 'project', projectId: 'p1', nowMs, limit: 1, ttlByType })
          .map((m) => m.id),
      ).toEqual(['a1']);
      expect(
        repo
          .findNeedsReview({ scope: 'global', projectId: null, nowMs, limit: 10, ttlByType })
          .map((m) => m.id),
      ).toEqual(['g']);
    });
  });
});
