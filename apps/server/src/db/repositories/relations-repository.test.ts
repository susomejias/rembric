import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { deriveTitle, MemoryService } from '../../services/memory.js';
import { ProjectsService } from '../../services/projects.js';
import { RelationsService } from '../../services/relations.js';
import { projectScope } from '../../services/scope.js';
import { createTestDb, type TestDb } from '../../test/db.js';
import { defaultProjectScope, seedProject } from '../../test/default-project.js';
import { memoryRelations, type NewMemoryRelation } from '../schema/memory-relations.js';
import { memory, type NewMemory } from '../schema/memory.js';

import { RelationsRepository } from './relations-repository.js';

import { createRepositories, type Repositories } from './index.js';

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
    // A global pair too, so the assertion below distinguishes scope filtering
    // from lifecycle filtering rather than passing on either alone.
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
