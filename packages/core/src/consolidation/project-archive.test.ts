import {
  consolidationOps,
  consolidationRuns,
  createRepositories,
  projectScope,
  type ConsolidationOp,
  type Repositories,
  type Scope,
} from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ConsolidationRunner,
  DomainError,
  DRAIN_RETIRED_REASON,
  DRAIN_RULES_REASON,
  PROJECT_ARCHIVE_ORPHAN_REASON,
  RETIREMENT_ORPHAN_REASON,
  MemoryService,
  PROJECT_ARCHIVE_ORPHANING_PREFIX,
  ProjectsService,
  RelationsService,
  reconcileArchivedProjectJudgments,
  undoOp,
  undoRun,
} from '@rembric/core';

import { createTestDb, type TestDb, TestClock } from '../test-support/index.js';

const DAY = 86_400_000;
const DEADLINE = 14 * DAY;

let db: TestDb;
let repos: Repositories;
let clock: TestClock;
let projects: ProjectsService;
let memory: MemoryService;
let relations: RelationsService;
let p: string;
let q: string;

beforeEach(() => {
  db = createTestDb();
  clock = new TestClock();
  repos = createRepositories(db.handle.db);
  projects = new ProjectsService(repos, clock.now, db.handle.db);
  memory = new MemoryService(repos, db.handle.db, clock.now);
  relations = new RelationsService(repos, db.handle.db, clock.now);
  p = projects.create({ slug: 'p' }).id;
  q = projects.create({ slug: 'q' }).id;
});

afterEach(() => db.cleanup());

function save(projectId: string, title: string): string {
  clock.advance(1_000);
  const scope: Scope = projectScope(projectId);
  return memory.save({ type: 'project', title, content: `${title} body` }, scope).id;
}

function pendingIn(projectId: string, label: string): string {
  const a = save(projectId, `${label} a`);
  const b = save(projectId, `${label} b`);
  clock.advance(1_000);
  return relations.createPending({ sourceId: a, targetId: b }).judgmentId;
}

const rel = (judgmentId: string) => repos.relations.findByJudgmentId(judgmentId)!;
const allOps = (): ConsolidationOp[] => db.handle.db.select().from(consolidationOps).all();
const runs = () => db.handle.db.select().from(consolidationRuns).all();
const archiveRuns = () =>
  runs().filter(
    (r) => r.scope === 'maintenance' && r.summary?.includes('"project_archive_orphan"') === true,
  );
interface ArchiveRunSummary {
  kind: string;
  projectId: string;
  origin: string;
  orphaned: number;
}
const summaryOf = (summary: string | null): ArchiveRunSummary =>
  JSON.parse(summary ?? '{}') as ArchiveRunSummary;
const opFor = (judgmentId: string) => allOps().find((o) => o.createdId === judgmentId)!;
const projectRuns = (projectId: string) => runs().filter((r) => r.scope === `project:${projectId}`);

function stateHash(): string {
  const rels = db.handle.raw
    .prepare('SELECT judgment_id, status, relation, judged_at FROM memory_relations ORDER BY 1')
    .all();
  const ops = db.handle.raw
    .prepare('SELECT id, reverted_at FROM consolidation_ops ORDER BY 1')
    .all();
  return JSON.stringify({ rels, ops });
}

function runner(opts: { decayThresholdMs?: number } = {}) {
  return new ConsolidationRunner({
    repos,
    tx: db.handle.db,
    relations,
    projects,
    agentSessions: { purgeEmpty: () => ({ deletedIds: ['purged'] }) },
    decay: {
      thresholdByType: {},
      defaultThresholdMs: opts.decayThresholdMs ?? DAY,
      confidenceFloor: 1,
    },
    orphanDeadlineMs: DEADLINE,
  });
}

function backdate(table: 'memory' | 'memory_relations', column: string, msAgo: number) {
  db.handle.raw.prepare(`UPDATE ${table} SET ${column} = ?`).run(Date.now() - msAgo);
}

function archivedWithoutClosing(projectId: string): void {
  repos.projects.setArchivedAt(projectId, new Date(), true);
}

describe('archiving a project closes its pending judgments', () => {
  it('orphans pending judgments, leaves judged ones and other projects, and journals one run', () => {
    const j1 = pendingIn(p, 'one');
    const j2 = pendingIn(p, 'two');
    const judged = pendingIn(p, 'three');
    relations.judge(judged, { relation: 'not_conflict', actor: 'agent', kind: 'agent' });
    const other = pendingIn(q, 'other');

    projects.archive(p);

    expect(projects.getById(p)!.archivedAt).not.toBeNull();
    for (const j of [j1, j2]) {
      expect(rel(j).status).toBe('orphaned');
      expect(rel(j).markedByKind).toBe('consolidator');
      const op = opFor(j);
      expect(op.opType).toBe('orphan_promote');
      expect(op.reasoning?.startsWith(PROJECT_ARCHIVE_ORPHANING_PREFIX)).toBe(true);
      expect(op.affectedIds).toEqual([rel(j).sourceId, rel(j).targetId]);
    }
    expect(rel(judged).status).toBe('judged');
    expect(rel(other).status).toBe('pending');
    const [run] = archiveRuns();
    expect(archiveRuns()).toHaveLength(1);
    expect(summaryOf(run!.summary)).toEqual({
      kind: 'project_archive_orphan',
      projectId: p,
      origin: 'archive',
      orphaned: 2,
    });
    expect(allOps().filter((o) => o.runId === run!.id)).toHaveLength(2);
  });

  it('writes no run when the project has no pending judgment', () => {
    save(p, 'lonely');
    projects.archive(p);
    expect(archiveRuns()).toHaveLength(0);
  });

  it('a refused archive touches no judgment', () => {
    const j = pendingIn(p, 'one');
    projects.archive(p);
    const before = stateHash();
    expect(() => projects.archive(p)).toThrow(/already archived/);
    expect(stateHash()).toBe(before);
    expect(rel(j).status).toBe('orphaned');

    const def = projects.getDefault();
    const dj = pendingIn(def.id, 'default');
    const beforeDefault = stateHash();
    expect(() => projects.archive(def.id)).toThrow(/default project/);
    expect(stateHash()).toBe(beforeDefault);
    expect(rel(dj).status).toBe('pending');
  });

  it('a failure while journaling rolls back the archive and every orphaning', () => {
    const j1 = pendingIn(p, 'one');
    const j2 = pendingIn(p, 'two');
    let inserts = 0;
    const failing: Repositories = {
      ...repos,
      consolidation: Object.assign(Object.create(repos.consolidation) as object, {
        insertOp: (values: Parameters<Repositories['consolidation']['insertOp']>[0]) => {
          inserts += 1;
          if (inserts === 2) throw new Error('journal write failed');
          repos.consolidation.insertOp(values);
        },
      }) as Repositories['consolidation'],
    };
    const svc = new ProjectsService(failing, clock.now, db.handle.db);

    expect(() => svc.archive(p)).toThrow(/journal write failed/);

    expect(projects.getById(p)!.archivedAt).toBeNull();
    expect(rel(j1).status).toBe('pending');
    expect(rel(j2).status).toBe('pending');
    expect(allOps()).toHaveLength(0);
    expect(archiveRuns()).toHaveLength(0);
  });
});

describe('the archive reason is distinct from every other orphaning reason', () => {
  it('pins five distinct prefixes and the archive op carries its own', () => {
    const reasons = [
      'unjudged after',
      DRAIN_RULES_REASON,
      DRAIN_RETIRED_REASON,
      RETIREMENT_ORPHAN_REASON,
      PROJECT_ARCHIVE_ORPHAN_REASON,
    ];
    expect(new Set(reasons).size).toBe(5);
    for (const other of reasons.slice(0, 4)) {
      expect(PROJECT_ARCHIVE_ORPHAN_REASON.startsWith(other)).toBe(false);
      expect(other.startsWith(PROJECT_ARCHIVE_ORPHAN_REASON)).toBe(false);
    }
    const j = pendingIn(p, 'one');
    projects.archive(p);
    expect(opFor(j).reasoning).toBe(`orphaned: ${PROJECT_ARCHIVE_ORPHAN_REASON}`);
    expect(rel(j).reason).toBe(PROJECT_ARCHIVE_ORPHAN_REASON);
  });
});

describe('unarchiving a project restores what its archiving closed', () => {
  it('archive then unarchive leaves the queue as it was and reverts the ops', () => {
    const j1 = pendingIn(p, 'one');
    const j2 = pendingIn(p, 'two');
    projects.archive(p);
    projects.unarchive(p);

    expect(projects.getById(p)!.archivedAt).toBeNull();
    expect(rel(j1).status).toBe('pending');
    expect(rel(j2).status).toBe('pending');
    expect(opFor(j1).revertedAt).not.toBeNull();
    expect(opFor(j2).revertedAt).not.toBeNull();
  });

  it('keeps a verdict written after the orphaning', () => {
    const j = pendingIn(p, 'one');
    projects.archive(p);
    clock.advance(1_000);
    repos.relations.markJudgedFromOrphaned(rel(j).id, {
      relation: 'not_conflict',
      markedByKind: 'agent',
      judgedAt: new Date(opFor(j).appliedAt.getTime() + 1_000),
    } as Parameters<Repositories['relations']['markJudgedFromOrphaned']>[1]);

    projects.unarchive(p);

    expect(rel(j).status).toBe('judged');
    expect(rel(j).relation).toBe('not_conflict');
  });

  it('keeps a judgment orphaned when an endpoint was retired while archived', () => {
    const kept = pendingIn(p, 'kept');
    const restored = pendingIn(p, 'restored');
    projects.archive(p);
    repos.memory.archiveOne(rel(kept).sourceId);

    projects.unarchive(p);

    expect(rel(kept).status).toBe('orphaned');
    expect(opFor(kept).revertedAt).toBeNull();
    expect(rel(restored).status).toBe('pending');
    expect(opFor(restored).revertedAt).not.toBeNull();
  });

  it('a second archive cycle only orphans what is pending at that moment', () => {
    const j1 = pendingIn(p, 'one');
    const j2 = pendingIn(p, 'two');
    projects.archive(p);
    projects.unarchive(p);
    relations.judge(j1, { relation: 'not_conflict', actor: 'agent', kind: 'agent' });

    projects.archive(p);

    expect(rel(j1).status).toBe('judged');
    expect(rel(j2).status).toBe('orphaned');
    const latest = archiveRuns().at(-1)!;
    expect(archiveRuns()).toHaveLength(2);
    expect(summaryOf(latest.summary).orphaned).toBe(1);
  });

  it('succeeds and restores nothing when nothing was closed', () => {
    const j = pendingIn(q, 'other');
    projects.archive(p);
    const before = stateHash();
    expect(projects.unarchive(p).archivedAt).toBeNull();
    expect(stateHash()).toBe(before);
    expect(rel(j).status).toBe('pending');
  });

  it('restores only from archive runs, not from another maintenance run naming the project', () => {
    const j = pendingIn(p, 'foreign');
    projects.archive(p);
    const archiveOp = opFor(j);
    const foreignRun = 'foreign-run';
    repos.consolidation.insertRun({
      id: foreignRun,
      startedAt: new Date(),
      finishedAt: new Date(),
      scope: 'maintenance',
      summary: JSON.stringify({ kind: 'some_other_kind', projectId: p }),
    });
    db.handle.raw
      .prepare('UPDATE consolidation_ops SET run_id = ? WHERE id = ?')
      .run(foreignRun, archiveOp.id);

    projects.unarchive(p);

    expect(rel(j).status).toBe('orphaned');
    expect(opFor(j).revertedAt).toBeNull();
  });

  it('only restores the unarchived project', () => {
    const jp = pendingIn(p, 'p');
    const jq = pendingIn(q, 'q');
    projects.archive(p);
    projects.archive(q);
    projects.unarchive(p);
    expect(rel(jp).status).toBe('pending');
    expect(rel(jq).status).toBe('orphaned');
  });
});

describe('an archive orphaning cannot be undone while its project is archived', () => {
  it('refuses a single-op undo and a run undo, changing nothing', () => {
    const j = pendingIn(p, 'one');
    pendingIn(p, 'two');
    projects.archive(p);
    const op = opFor(j);
    const before = stateHash();

    expect(() => undoOp(repos, db.handle.db, op.id)).toThrow(DomainError);
    expect(() => undoOp(repos, db.handle.db, op.id)).toThrow(/unarchive/);
    expect(() => undoRun(repos, db.handle.db, op.runId)).toThrow(DomainError);
    expect(stateHash()).toBe(before);
  });

  it('refuses undoing a deadline orphaning once its project is archived', () => {
    const j = pendingIn(p, 'aged');
    const atClock = (msAgo: number) => clock.now().getTime() - msAgo;
    db.handle.raw
      .prepare('UPDATE memory_relations SET created_at = ?')
      .run(atClock(DEADLINE + DAY));
    runner({ decayThresholdMs: 365 * 10 * DAY }).runAll({ force: true });
    expect(rel(j).status).toBe('orphaned');
    const deadlineOp = opFor(j);
    expect(deadlineOp.reasoning).toMatch(/unjudged after/);
    projects.archive(p);
    const before = stateHash();

    expect(() => undoOp(repos, db.handle.db, deadlineOp.id)).toThrow(/unarchive/);
    expect(stateHash()).toBe(before);

    projects.unarchive(p);
    undoOp(repos, db.handle.db, deadlineOp.id);
    expect(rel(j).status).toBe('pending');
  });

  it('refuses undoing a memory retirement that would re-open a judgment of an archived project', () => {
    const j = pendingIn(p, 'retired');
    const scope: Scope = projectScope(p);
    memory.archive(rel(j).sourceId, scope);
    expect(rel(j).status).toBe('orphaned');
    const retirementOp = allOps().find((o) => o.opType === 'agent_memory_archive')!;
    projects.archive(p);
    const before = stateHash();

    expect(() => undoOp(repos, db.handle.db, retirementOp.id)).toThrow(/unarchive/);
    expect(() => undoRun(repos, db.handle.db, retirementOp.runId)).toThrow(/unarchive/);
    expect(stateHash()).toBe(before);
    expect(rel(j).status).toBe('orphaned');
  });

  it('allows the undo once the project is active again', () => {
    const kept = pendingIn(p, 'kept');
    projects.archive(p);
    repos.memory.archiveOne(rel(kept).sourceId);
    projects.unarchive(p);
    expect(rel(kept).status).toBe('orphaned');

    undoOp(repos, db.handle.db, opFor(kept).id);

    expect(rel(kept).status).toBe('pending');
  });
});

describe('the sweep skips archived projects', () => {
  it('a forced sweep leaves an archived project untouched and still sweeps active ones', () => {
    const activeMemory = save(q, 'active stale');
    const activePending = pendingIn(q, 'active pending');
    const frozenMemory = save(p, 'frozen stale');
    const frozenPending = pendingIn(p, 'frozen pending');
    archivedWithoutClosing(p);
    backdate('memory', 'last_seen_at', 2 * DAY);
    backdate('memory_relations', 'created_at', DEADLINE + DAY);

    const summary = runner().runAll({ force: true });

    expect(repos.memory.unsafeGetById(activeMemory)!.status).toBe('archived');
    expect(rel(activePending).status).toBe('orphaned');
    expect(repos.memory.unsafeGetById(frozenMemory)!.status).toBe('active');
    expect(rel(frozenPending).status).toBe('pending');
    expect(projectRuns(p)).toHaveLength(0);
    expect(summary.runs.map((r) => r.scope.projectId)).not.toContain(p);
    expect(summary.purgedSessionIds).toEqual(['purged']);
  });

  it('a session-start sweep for an archived project sweeps only the default project', () => {
    archivedWithoutClosing(p);
    const summary = runner().sweepFor(p);
    expect(summary.runs.map((r) => r.scope.projectId)).toEqual([projects.getDefault().id]);
    expect(projectRuns(p)).toHaveLength(0);
  });

  it('an unarchived project is swept again', () => {
    projects.archive(p);
    projects.unarchive(p);
    runner().runAll({ force: true });
    expect(projectRuns(p)).toHaveLength(1);
  });
});

describe('the process-start reconciliation', () => {
  it('closes an archived project’s backlog in batches, one run each, and unarchive restores it', async () => {
    const backlog = Array.from({ length: 5 }, (_, i) => pendingIn(p, `b${i}`));
    const active = pendingIn(q, 'active');
    archivedWithoutClosing(p);

    const result = await reconcileArchivedProjectJudgments(repos, db.handle.db, { batchSize: 2 });

    expect(result).toEqual({ closed: 5, projects: 1 });
    for (const j of backlog) expect(rel(j).status).toBe('orphaned');
    expect(rel(active).status).toBe('pending');
    const summaries = archiveRuns().map((r) => summaryOf(r.summary));
    expect(summaries.map((s) => s.orphaned)).toEqual([2, 2, 1]);
    for (const s of summaries) {
      expect(s).toMatchObject({
        kind: 'project_archive_orphan',
        projectId: p,
        origin: 'reconcile',
      });
    }

    projects.unarchive(p);
    for (const j of backlog) expect(rel(j).status).toBe('pending');
  });

  it('stops closing a project that is unarchived between batches', async () => {
    const backlog = Array.from({ length: 7 }, (_, i) => pendingIn(p, `race${i}`));
    archivedWithoutClosing(p);

    const reconciling = reconcileArchivedProjectJudgments(repos, db.handle.db, { batchSize: 3 });
    setImmediate(() => projects.unarchive(p));
    await reconciling;

    expect(projects.getById(p)!.archivedAt).toBeNull();
    for (const j of backlog) expect(rel(j).status).toBe('pending');
  });

  it('writes nothing on a converged store', async () => {
    pendingIn(p, 'one');
    projects.archive(p);
    const before = stateHash();
    const runCount = runs().length;

    const result = await reconcileArchivedProjectJudgments(repos, db.handle.db, { batchSize: 2 });

    expect(result).toEqual({ closed: 0, projects: 0 });
    expect(stateHash()).toBe(before);
    expect(runs()).toHaveLength(runCount);
  });
});

describe('a restored judgment’s deadline counts from its restore', () => {
  it('stays pending after a restore and is orphaned once the fresh window passes', () => {
    const j = pendingIn(p, 'old');
    const atClock = (msAgo: number) => clock.now().getTime() - msAgo;
    db.handle.raw.prepare('UPDATE memory_relations SET created_at = ?').run(atClock(40 * DAY));
    projects.archive(p);
    projects.unarchive(p);
    const deadlineOnly = () => runner({ decayThresholdMs: 365 * 10 * DAY });

    deadlineOnly().runAll({ force: true });
    expect(rel(j).status).toBe('pending');

    db.handle.raw
      .prepare('UPDATE consolidation_ops SET reverted_at = ? WHERE created_id = ?')
      .run(atClock(15 * DAY), j);

    deadlineOnly().runAll({ force: true });
    expect(rel(j).status).toBe('orphaned');
    expect(opFor(j).revertedAt).not.toBeNull();
    expect(
      allOps().some(
        (o) =>
          o.createdId === j && o.revertedAt === null && o.reasoning?.includes('unjudged after'),
      ),
    ).toBe(true);
  });
});
