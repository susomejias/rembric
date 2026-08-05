import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { undoOp } from '../consolidation/operations.js';
import { ConsolidationRunner } from '../consolidation/runner.js';
import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { consolidationOps, consolidationRuns } from '../db/schema/consolidation.js';
import { memory } from '../db/schema/memory.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { RelationsService } from '../services/relations.js';

import { createTestDb, type TestDb } from './db.js';
import { defaultProjectScope, seedProject } from './default-project.js';

describe('runtime invariants — status FSM and scope discipline', () => {
  let testDb: TestDb;

  beforeAll(() => {
    testDb = createTestDb();
    seedProject(testDb.handle, 'p0', 'project-zero');
    const projects = new ProjectsService(createRepositories(testDb.handle.db));
    projects.create({ slug: 'proj-x' });
    projects.create({ slug: 'proj-y' });
  });
  afterAll(() => testDb.cleanup());

  /**
   * Seed a historical `merge` op (two superseded predecessors + an active
   * merged row + a journaled op) the way the removed LLM consolidator once did.
   * The producer is gone, but the spec requires such rows to stay undoable.
   */
  function seedHistoricalMerge(
    repos: Repositories,
    svc: MemoryService,
  ): { aId: string; bId: string; mergedId: string; opId: string } {
    const db = testDb.handle.db;
    const runId = ulid();
    db.insert(consolidationRuns)
      .values({ id: runId, startedAt: new Date(), scope: 'global' })
      .run();

    const a = svc.save(
      { type: 'feedback', title: `merge-A-${runId}`, content: `merge-A-${runId}` },
      defaultProjectScope(testDb.handle),
    );
    const b = svc.save(
      { type: 'feedback', title: `merge-B-${runId}`, content: `merge-B-${runId}` },
      defaultProjectScope(testDb.handle),
    );
    const mergedId = `merged-${runId}`;
    repos.memory.insert({
      id: mergedId,
      scope: 'project',
      projectId: 'p0',
      type: 'feedback',
      title: `merged-${runId}`,
      content: `merged-${runId}`,
      tags: [],
      status: 'active',
      replaces: [a.id, b.id],
      createdAt: new Date(),
      lastSeenAt: new Date(),
      source: { tokenName: 'consolidation' },
    });
    repos.memory.markSupersededMany([a.id, b.id]);
    const opId = `op-${runId}`;
    repos.consolidation.insertOp({
      id: opId,
      runId,
      opType: 'merge',
      affectedIds: [a.id, b.id],
      createdId: mergedId,
      reasoning: 'historical',
      appliedAt: new Date(),
    });
    return { aId: a.id, bId: b.id, mergedId, opId };
  }

  it('13.8 active → archived', () => {
    const svc = new MemoryService(createRepositories(testDb.handle.db), testDb.handle.db);
    const m = svc.save(
      { type: 'feedback', title: 'fsm-test-1', content: 'fsm-test-1' },
      defaultProjectScope(testDb.handle),
    );
    expect(m.status).toBe('active');

    svc.archive(m.id, defaultProjectScope(testDb.handle));
    expect(svc.unsafeGetById(m.id)!.status).toBe('archived');
  });

  it('13.8 superseded via a historical merge, then undo flips back to active', () => {
    const db = testDb.handle.db;
    const repos = createRepositories(db);
    const svc = new MemoryService(repos, db);

    const { aId, bId, mergedId, opId } = seedHistoricalMerge(repos, svc);

    expect(db.select().from(memory).where(eq(memory.id, aId)).get()!.status).toBe('superseded');
    expect(db.select().from(memory).where(eq(memory.id, bId)).get()!.status).toBe('superseded');
    expect(db.select().from(memory).where(eq(memory.id, mergedId)).get()!.status).toBe('active');

    undoOp(repos, db, opId);
    expect(db.select().from(memory).where(eq(memory.id, aId)).get()!.status).toBe('active');
    expect(db.select().from(memory).where(eq(memory.id, bId)).get()!.status).toBe('active');
    // Merged row is archived (not deleted) by undo; the table is append-only.
    expect(db.select().from(memory).where(eq(memory.id, mergedId)).get()!.status).toBe('archived');
  });

  it('every consolidation op records an affected_ids set with a single (scope, project) tuple', () => {
    // Walk every op row in the test DB and assert all of its affected
    // memories share scope + project_id. This is the surviving guarantee for
    // "consolidation never crosses scope" now that the producer-level scope
    // guards (applyMerge/applySupersede) are gone — the deterministic sweep
    // operates one (scope, project) tuple at a time.
    const db = testDb.handle.db;
    const repos = createRepositories(db);

    // The ops have to come from the real sweep in TWO projects, both holding
    // a decay-eligible row: with ops in one scope only, `keys.size <= 1`
    // holds by construction and the assertion below proves nothing.
    const x = repos.projects.findBySlug('proj-x')!.id;
    const y = repos.projects.findBySlug('proj-y')!.id;
    const stale = new Date(Date.now() - 60_000);
    for (const [id, projectId] of [
      ['decay-x', x],
      ['decay-y', y],
    ] as const) {
      repos.memory.insert({
        id,
        scope: 'project',
        projectId,
        type: 'project',
        title: id,
        content: `${id} body`,
        tags: [],
        status: 'active',
        replaces: [],
        createdAt: new Date(1_000),
        lastSeenAt: stale,
      });
    }
    const runner = new ConsolidationRunner({
      repos,
      tx: db,
      relations: new RelationsService(repos, db),
      projects: new ProjectsService(repos),
      agentSessions: { purgeEmpty: () => ({ deletedIds: [] }) },
      decay: { thresholdByType: {}, defaultThresholdMs: 1_000, confidenceFloor: 1 },
    });
    runner.runScope({ projectId: x });
    runner.runScope({ projectId: y });

    const ops = db.select().from(consolidationOps).all();
    const tupleOf = (r: { scope: string; projectId: string | null }) =>
      `${r.scope}:${r.projectId ?? '∅'}`;
    const spanned = new Set<string>();
    let inspected = 0;
    for (const op of ops) {
      if (op.affectedIds.length === 0) continue;
      const rows = op.affectedIds.map((id) =>
        db.select().from(memory).where(eq(memory.id, id)).get(),
      );
      const keys = new Set(
        rows.filter((r): r is NonNullable<typeof r> => !!r).map((r) => tupleOf(r)),
      );
      for (const k of keys) spanned.add(k);
      inspected += 1;
      expect(keys.size, `op ${op.id} spans multiple scopes`).toBeLessThanOrEqual(1);
    }
    // Non-vacuity: ops were inspected at all, and they cover both projects,
    // so a producer that ignored scope would have had a second project's row
    // to pull into the first project's op.
    expect(inspected).toBeGreaterThan(0);
    expect(spanned).toContain(`project:${x}`);
    expect(spanned).toContain(`project:${y}`);
  });
});
