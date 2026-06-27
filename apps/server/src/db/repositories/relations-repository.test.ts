import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveTitle } from '../../services/memory.js';
import { createTestDb, type TestDb } from '../../test/db.js';
import { memoryRelations, type NewMemoryRelation } from '../schema/memory-relations.js';
import { memory, type NewMemory } from '../schema/memory.js';

import { RelationsRepository } from './relations-repository.js';

function mem(id: string, content: string): NewMemory {
  return {
    id,
    title: deriveTitle(content),
    content,
    scope: 'global',
    projectId: null,
    type: 'project',
    tags: [],
    status: 'active',
    replaces: [],
    createdAt: new Date(1_000),
    lastSeenAt: new Date(1_000),
  };
}

function rel(
  overrides: Partial<NewMemoryRelation> & { id: string; judgmentId: string },
): NewMemoryRelation {
  return {
    sourceId: 'M1',
    targetId: 'M2',
    relation: null,
    status: 'pending',
    createdAt: new Date(1_000),
    ...overrides,
  };
}

describe('RelationsRepository', () => {
  let t: TestDb;
  let repo: RelationsRepository;

  beforeEach(() => {
    t = createTestDb();
    repo = new RelationsRepository(t.handle.db);
    t.handle.db
      .insert(memory)
      .values([mem('M1', 'source memory'), mem('M2', 'target memory')])
      .run();
    t.handle.db
      .insert(memoryRelations)
      .values([
        rel({ id: 'R1', judgmentId: 'J1', status: 'pending', createdAt: new Date(1_000) }),
        rel({
          id: 'R2',
          judgmentId: 'J2',
          status: 'judged',
          relation: 'supersedes',
          reason: 'newer take',
          confidence: 0.9,
          markedByKind: 'agent',
          markedByActor: 'claude-code',
          judgedAt: new Date(2_500),
          evidence: { quotes: ['a'] },
          createdAt: new Date(2_000),
        }),
        rel({
          id: 'R3',
          judgmentId: 'J3',
          status: 'judged',
          relation: 'not_conflict',
          judgedAt: new Date(3_500),
          createdAt: new Date(3_000),
        }),
        rel({ id: 'R4', judgmentId: 'J4', status: 'orphaned', createdAt: new Date(4_000) }),
      ])
      .run();
  });

  afterEach(() => {
    t.cleanup();
  });

  describe('adminListWithContent', () => {
    it('no filters: all rows newest first with joined content', () => {
      const rows = repo.adminListWithContent({}, 10, 0);
      expect(rows.map((r) => r.id)).toEqual(['R4', 'R3', 'R2', 'R1']);
      expect(rows[0]?.sourceContent).toBe('source memory');
      expect(rows[0]?.targetContent).toBe('target memory');
    });

    it('filters by each status', () => {
      expect(repo.adminListWithContent({ status: 'pending' }, 10, 0).map((r) => r.id)).toEqual([
        'R1',
      ]);
      expect(repo.adminListWithContent({ status: 'judged' }, 10, 0).map((r) => r.id)).toEqual([
        'R3',
        'R2',
      ]);
      expect(repo.adminListWithContent({ status: 'orphaned' }, 10, 0).map((r) => r.id)).toEqual([
        'R4',
      ]);
    });

    it('filters by relation kind', () => {
      expect(repo.adminListWithContent({ kind: 'supersedes' }, 10, 0).map((r) => r.id)).toEqual([
        'R2',
      ]);
      expect(repo.adminListWithContent({ kind: 'not_conflict' }, 10, 0).map((r) => r.id)).toEqual([
        'R3',
      ]);
      expect(repo.adminListWithContent({ kind: 'related' }, 10, 0)).toEqual([]);
    });

    it("kind 'pending' selects rows with NULL relation", () => {
      expect(repo.adminListWithContent({ kind: 'pending' }, 10, 0).map((r) => r.id)).toEqual([
        'R4',
        'R1',
      ]);
    });

    it('combines status and kind filters', () => {
      expect(
        repo.adminListWithContent({ status: 'orphaned', kind: 'pending' }, 10, 0).map((r) => r.id),
      ).toEqual(['R4']);
      expect(
        repo.adminListWithContent({ status: 'judged', kind: 'supersedes' }, 10, 0).map((r) => r.id),
      ).toEqual(['R2']);
      expect(repo.adminListWithContent({ status: 'pending', kind: 'supersedes' }, 10, 0)).toEqual(
        [],
      );
    });

    it('respects limit and offset', () => {
      expect(repo.adminListWithContent({}, 2, 1).map((r) => r.id)).toEqual(['R3', 'R2']);
    });
  });

  describe('adminGetWithContent', () => {
    it('returns the full row with joined content', () => {
      const row = repo.adminGetWithContent('R2');
      expect(row).toMatchObject({
        id: 'R2',
        judgmentId: 'J2',
        sourceId: 'M1',
        targetId: 'M2',
        relation: 'supersedes',
        status: 'judged',
        reason: 'newer take',
        confidence: 0.9,
        markedByKind: 'agent',
        markedByActor: 'claude-code',
        sourceContent: 'source memory',
        targetContent: 'target memory',
      });
      expect(row?.evidence).toEqual({ quotes: ['a'] });
      expect(row?.judgedAt).toEqual(new Date(2_500));
      expect(row?.createdAt).toEqual(new Date(2_000));
    });

    it('returns undefined for unknown id', () => {
      expect(repo.adminGetWithContent('nope')).toBeUndefined();
    });
  });

  describe('listNotConflictTargetsForSources', () => {
    beforeEach(() => {
      t.handle.db
        .insert(memory)
        .values([
          mem('S1', 's1'),
          mem('S2', 's2'),
          mem('T1', 't1'),
          mem('T2', 't2'),
          mem('T3', 't3'),
        ])
        .run();
      t.handle.db
        .insert(memoryRelations)
        .values([
          rel({
            id: 'N1',
            judgmentId: 'JN1',
            sourceId: 'S1',
            targetId: 'T1',
            relation: 'not_conflict',
            status: 'judged',
          }),
          rel({
            id: 'N2',
            judgmentId: 'JN2',
            sourceId: 'S1',
            targetId: 'T2',
            relation: 'not_conflict',
            status: 'judged',
          }),
          rel({
            id: 'N3',
            judgmentId: 'JN3',
            sourceId: 'S1',
            targetId: 'T1',
            relation: 'not_conflict',
            status: 'judged',
          }), // dup target
          rel({
            id: 'N4',
            judgmentId: 'JN4',
            sourceId: 'S1',
            targetId: 'T3',
            relation: 'conflicts_with',
            status: 'judged',
          }), // wrong relation
          rel({
            id: 'N5',
            judgmentId: 'JN5',
            sourceId: 'S1',
            targetId: 'T2',
            relation: null,
            status: 'pending',
          }), // not judged
          rel({
            id: 'N6',
            judgmentId: 'JN6',
            sourceId: 'S2',
            targetId: 'T1',
            relation: 'not_conflict',
            status: 'judged',
          }), // other source
        ])
        .run();
    });

    it('returns distinct not_conflict judged targets, scoped to the given sources', () => {
      expect(repo.listNotConflictTargetsForSources(['S1']).sort()).toEqual(['T1', 'T2']);
      expect(repo.listNotConflictTargetsForSources(['S2'])).toEqual(['T1']);
      expect(repo.listNotConflictTargetsForSources(['S1', 'S2']).sort()).toEqual(['T1', 'T2']);
    });

    it('returns [] for empty input', () => {
      expect(repo.listNotConflictTargetsForSources([])).toEqual([]);
    });
  });
});
