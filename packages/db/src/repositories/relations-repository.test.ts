import { deriveTitle, MemoryService } from '@rembric/core';
import { ProjectsService } from '@rembric/core';
import { RelationsService } from '@rembric/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createRepositories,
  memory,
  memoryRelations,
  projectScope,
  RelationsRepository,
  type NewMemory,
  type NewMemoryRelation,
  type Repositories,
} from '@rembric/db';

import { createTestDb, type TestDb } from '../test-support/db.js';
import { defaultProjectScope, seedProject } from '../test-support/default-project.js';

function mem(id: string, content: string): NewMemory {
  return {
    id,
    title: deriveTitle(content),
    content,
    scope: 'project',
    projectId: 'p0',
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
    seedProject(t.handle, 'p0', 'project-zero');
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

    describe('q filter', () => {
      beforeEach(() => {
        t.handle.db
          .insert(memory)
          .values([
            mem('M3', 'alpha needle in source'),
            mem('M4', 'clean target'),
            mem('M5', 'gamma source'),
            mem('M6', 'delta NEEDLE in target'),
          ])
          .run();
        t.handle.db
          .insert(memoryRelations)
          .values([
            rel({
              id: 'R5',
              judgmentId: 'J5',
              sourceId: 'M3',
              targetId: 'M4',
              createdAt: new Date(5_000),
            }),
            rel({
              id: 'R6',
              judgmentId: 'J6',
              sourceId: 'M5',
              targetId: 'M6',
              createdAt: new Date(6_000),
            }),
          ])
          .run();
      });

      it('control: without q the list and count are unchanged', () => {
        expect(repo.adminListWithContent({}, 10, 0).map((r) => r.id)).toEqual([
          'R6',
          'R5',
          'R4',
          'R3',
          'R2',
          'R1',
        ]);
        expect(repo.adminCountWithFilters({})).toBe(6);
      });

      it('q matches either endpoint and is case-insensitive', () => {
        const rows = repo.adminListWithContent({ q: 'needle' }, 10, 0);
        expect(rows.map((r) => r.id).sort()).toEqual(['R5', 'R6']);
        expect(repo.adminCountWithFilters({ q: 'needle' })).toBe(rows.length);

        const upper = repo.adminListWithContent({ q: 'NEEDLE' }, 10, 0);
        expect(upper.map((r) => r.id).sort()).toEqual(['R5', 'R6']);
        expect(repo.adminCountWithFilters({ q: 'NEEDLE' })).toBe(upper.length);
      });

      it('q excludes non-matching rows and count agrees', () => {
        expect(repo.adminListWithContent({ q: 'no-such-keyword' }, 10, 0)).toEqual([]);
        expect(repo.adminCountWithFilters({ q: 'no-such-keyword' })).toBe(0);
      });

      it('q combines with status in both list and count', () => {
        const rows = repo.adminListWithContent({ q: 'needle', status: 'pending' }, 10, 0);
        expect(rows.map((r) => r.id).sort()).toEqual(['R5', 'R6']);
        expect(repo.adminCountWithFilters({ q: 'needle', status: 'pending' })).toBe(rows.length);
      });

      it('escapes LIKE wildcards in q', () => {
        expect(repo.adminCountWithFilters({ q: '%' })).toBe(0);
        expect(repo.adminCountWithFilters({ q: '_' })).toBe(0);
      });
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

  describe('listPendingTouchingAny', () => {
    beforeEach(() => {
      t.handle.db
        .insert(memory)
        .values([mem('A', 'a'), mem('B', 'b'), mem('C', 'c'), mem('D', 'd')])
        .run();
      t.handle.db
        .insert(memoryRelations)
        .values([
          rel({
            id: 'P1',
            judgmentId: 'JP1',
            sourceId: 'A',
            targetId: 'C',
            createdAt: new Date(7),
          }),
          rel({
            id: 'P2',
            judgmentId: 'JP2',
            sourceId: 'C',
            targetId: 'A',
            createdAt: new Date(5),
          }),
          rel({
            id: 'P3',
            judgmentId: 'JP3',
            sourceId: 'B',
            targetId: 'D',
            createdAt: new Date(5),
          }),
          rel({
            id: 'P4',
            judgmentId: 'JP0',
            sourceId: 'A',
            targetId: 'B',
            createdAt: new Date(5),
          }),
          rel({
            id: 'P5',
            judgmentId: 'JP5',
            sourceId: 'A',
            targetId: 'D',
            status: 'judged',
            relation: 'related',
          }),
          rel({ id: 'P6', judgmentId: 'JP6', sourceId: 'D', targetId: 'A', status: 'orphaned' }),
          rel({ id: 'P7', judgmentId: 'JP7', sourceId: 'C', targetId: 'D' }),
        ])
        .run();
    });

    it('returns the pending rows on either side, in (created_at, judgment_id) order', () => {
      expect(repo.listPendingTouchingAny(['A']).map((r) => r.judgmentId)).toEqual([
        'JP0',
        'JP2',
        'JP1',
      ]);
    });

    it('returns a row touching two of the ids once', () => {
      expect(repo.listPendingTouchingAny(['A', 'B']).map((r) => r.judgmentId)).toEqual([
        'JP0',
        'JP2',
        'JP3',
        'JP1',
      ]);
    });

    it('carries the pair, so the caller can journal it', () => {
      expect(repo.listPendingTouchingAny(['B'])).toEqual([
        { judgmentId: 'JP0', sourceId: 'A', targetId: 'B' },
        { judgmentId: 'JP3', sourceId: 'B', targetId: 'D' },
      ]);
    });

    it('control: judged and orphaned rows touching the id are left out', () => {
      const ids = repo.listPendingTouchingAny(['D']).map((r) => r.judgmentId);
      expect(ids).toEqual(['JP3', 'JP7']);
      expect(ids).not.toContain('JP5');
      expect(ids).not.toContain('JP6');
    });

    it('returns [] for empty input', () => {
      expect(repo.listPendingTouchingAny([])).toEqual([]);
    });
  });
});

describe('RelationsRepository scoped pending reads', () => {
  let SCOPE: { projectId: string };
  let t: TestDb;
  let repo: RelationsRepository;
  let repos: Repositories;
  let memories: MemoryService;

  beforeEach(() => {
    t = createTestDb();
    SCOPE = defaultProjectScope(t.handle);
    repos = createRepositories(t.handle.db);
    repo = new RelationsRepository(t.handle.db);
    memories = new MemoryService(repos, t.handle.db);
  });

  afterEach(() => {
    t.cleanup();
  });

  function save(label: string, topicKey?: string): string {
    return memories.saveWithTopicKey(
      { type: 'project', title: label, content: label, topicKey },
      defaultProjectScope(t.handle),
    ).memory.id;
  }

  function pendingAt(sourceId: string, targetId: string, at: Date): string {
    return new RelationsService(repos, t.handle.db, () => at).createPending({ sourceId, targetId })
      .judgmentId;
  }

  function seedTopicKeyRevision(): { a: string; b: string; live: string } {
    const a = save('A on t', 't');
    for (let i = 0; i < 5; i += 1) {
      pendingAt(a, save(`x${i}`), new Date(1_000 + i));
    }
    const b = save('B on t', 't');
    const live = pendingAt(b, save('y'), new Date(9_000));
    return { a, b, live };
  }

  it('withholds a superseded source under a project scope too', () => {
    const projects = new ProjectsService(repos);
    const project = projects.create({ slug: 'pending-scoped', displayName: null });
    const scope = projectScope(project.id);
    const inProject = (label: string, topicKey?: string): string =>
      memories.saveWithTopicKey({ type: 'project', title: label, content: label, topicKey }, scope)
        .memory.id;

    const a = inProject('A on p', 'p');
    const dead = pendingAt(a, inProject('pa'), new Date(1_000));
    const b = inProject('B on p', 'p');
    const live = pendingAt(b, inProject('pb'), new Date(9_000));
    pendingAt(save('G on t', 'g'), save('gt'), new Date(2_000));

    expect(repos.memory.unsafeGetById(a)?.status).toBe('superseded');
    const args = { projectId: project.id };
    const rows = repo.listPendingInScope({ ...args, cutoffMs: null, limit: 10 });

    expect(rows.map((r) => r.judgmentId)).toEqual([live]);
    expect(repo.countPendingInScope(args)).toBe(1);
    expect(repo.adminCountWithFilters({ status: 'pending' })).toBe(3);
    expect(rows.map((r) => r.judgmentId)).not.toContain(dead);
  });

  it('withholds a superseded source from both the page and the total', () => {
    const { a, b, live } = seedTopicKeyRevision();

    expect(repos.memory.unsafeGetById(a)?.status).toBe('superseded');
    expect(repos.memory.unsafeGetById(b)?.status).toBe('active');

    const rows = repo.listPendingInScope({ ...SCOPE, cutoffMs: null, limit: 10 });
    expect(rows.map((r) => r.judgmentId)).toEqual([live]);
    expect(rows.map((r) => r.sourceId)).toEqual([b]);
    expect(repo.countPendingInScope(SCOPE)).toBe(1);
  });

  it('withholds an archived target from both the page and the total', () => {
    const deadTarget = save('dead target');
    pendingAt(save('live source'), deadTarget, new Date(1_000));
    const live = pendingAt(save('s'), save('t'), new Date(2_000));
    memories.archive(deadTarget, defaultProjectScope(t.handle));

    expect(repos.memory.unsafeGetById(deadTarget)?.status).toBe('archived');

    const rows = repo.listPendingInScope({ ...SCOPE, cutoffMs: null, limit: 10 });
    expect(rows.map((r) => r.judgmentId)).toEqual([live]);
    expect(repo.countPendingInScope(SCOPE)).toBe(1);
  });

  it('control: a pair between two active memories is listed and counted, aged or not', () => {
    const live = pendingAt(save('s'), save('t'), new Date(1_000));

    expect(
      repo.listPendingInScope({ ...SCOPE, cutoffMs: 5_000, limit: 10 }).map((r) => r.judgmentId),
    ).toEqual([live]);
    expect(
      repo.listPendingInScope({ ...SCOPE, cutoffMs: null, limit: 10 }).map((r) => r.judgmentId),
    ).toEqual([live]);
    expect(repo.countPendingInScope(SCOPE)).toBe(1);
  });

  it('control: the operator reads still return every pending row', () => {
    seedTopicKeyRevision();

    expect(repo.adminCountWithFilters({ status: 'pending' })).toBe(6);
    expect(repo.adminListWithContent({ status: 'pending' }, 20, 0)).toHaveLength(6);
  });

  it("control: the sweep's aged-pending selection still sees the withheld pairs", () => {
    const { a } = seedTopicKeyRevision();

    const aged = repo.findPendingOlderThanInScope({ ...SCOPE, cutoffMs: 100_000, limit: 50 });
    expect(aged).toHaveLength(6);
    expect(aged.filter((r) => r.sourceId === a)).toHaveLength(5);
  });
});

describe('RelationsRepository.listExaminablePendingInScope', () => {
  let t: TestDb;
  let repo: RelationsRepository;

  function memRow(
    id: string,
    projectId: string,
    status: NewMemory['status'] = 'active',
  ): NewMemory {
    return { ...mem(id, `memory ${id}`), projectId, status };
  }

  beforeEach(() => {
    t = createTestDb();
    seedProject(t.handle, 'p0', 'project-zero');
    seedProject(t.handle, 'p1', 'project-one');
    repo = new RelationsRepository(t.handle.db);
    t.handle.db
      .insert(memory)
      .values([
        memRow('A1', 'p0'),
        memRow('A2', 'p0'),
        memRow('A3', 'p0', 'superseded'),
        memRow('B1', 'p1'),
        memRow('B2', 'p1'),
      ])
      .run();
    t.handle.db
      .insert(memoryRelations)
      .values([
        rel({
          id: 'R3',
          judgmentId: 'J3',
          sourceId: 'A1',
          targetId: 'A2',
          createdAt: new Date(2_000),
        }),
        rel({
          id: 'R1',
          judgmentId: 'J1',
          sourceId: 'A1',
          targetId: 'A2',
          createdAt: new Date(1_000),
        }),
        rel({
          id: 'R2',
          judgmentId: 'J2',
          sourceId: 'A3',
          targetId: 'A2',
          createdAt: new Date(2_000),
        }),
        rel({
          id: 'R4',
          judgmentId: 'J4',
          sourceId: 'A2',
          targetId: 'A1',
          createdAt: new Date(3_000),
          status: 'judged',
          relation: 'related',
        }),
        rel({
          id: 'R5',
          judgmentId: 'J5',
          sourceId: 'B1',
          targetId: 'B2',
          createdAt: new Date(1_500),
        }),
        rel({
          id: 'R6',
          judgmentId: 'J6',
          sourceId: 'A1',
          targetId: 'B1',
          createdAt: new Date(1_200),
        }),
      ])
      .run();
  });

  afterEach(() => t.cleanup());

  const ids = (rows: { judgmentId: string }[]): string[] => rows.map((r) => r.judgmentId);

  it('lists pending rows of the project in (created_at, judgment_id) order, retired endpoints included', () => {
    const rows = repo.listExaminablePendingInScope({
      projectId: 'p0',
      excludeJudgmentIds: [],
      limit: 10,
    });
    expect(ids(rows)).toEqual(['J1', 'J2', 'J3']);
    expect(rows[0]).toEqual({
      judgmentId: 'J1',
      sourceId: 'A1',
      targetId: 'A2',
      createdAt: new Date(1_000),
    });
  });

  it("never returns another project's rows or a cross-project pair", () => {
    expect(
      ids(
        repo.listExaminablePendingInScope({ projectId: 'p1', excludeJudgmentIds: [], limit: 10 }),
      ),
    ).toEqual(['J5']);
  });

  it('resumes strictly after a cursor and stops at an inclusive upper key', () => {
    const after = { createdAt: new Date(2_000), judgmentId: 'J2' };
    expect(
      ids(
        repo.listExaminablePendingInScope({
          projectId: 'p0',
          after,
          excludeJudgmentIds: [],
          limit: 10,
        }),
      ),
    ).toEqual(['J3']);
    expect(
      ids(
        repo.listExaminablePendingInScope({
          projectId: 'p0',
          until: after,
          excludeJudgmentIds: [],
          limit: 10,
        }),
      ),
    ).toEqual(['J1', 'J2']);
  });

  it('excludes the given judgment ids inside the query, so the limit counts only examinable rows', () => {
    expect(
      ids(
        repo.listExaminablePendingInScope({
          projectId: 'p0',
          excludeJudgmentIds: ['J1'],
          limit: 2,
        }),
      ),
    ).toEqual(['J2', 'J3']);
  });

  it('the small-project probe and the indexed range return the same prefix at every limit', () => {
    const full = ids(
      repo.listExaminablePendingInScope({ projectId: 'p0', excludeJudgmentIds: [], limit: 100 }),
    );
    for (let limit = 1; limit <= full.length + 1; limit++) {
      expect(
        ids(repo.listExaminablePendingInScope({ projectId: 'p0', excludeJudgmentIds: [], limit })),
      ).toEqual(full.slice(0, limit));
    }
  });

  it('honours the limit', () => {
    expect(
      ids(repo.listExaminablePendingInScope({ projectId: 'p0', excludeJudgmentIds: [], limit: 1 })),
    ).toEqual(['J1']);
  });
});
