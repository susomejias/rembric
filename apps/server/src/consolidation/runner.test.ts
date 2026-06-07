import { desc } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { consolidationRuns } from '../db/schema/consolidation.js';
import { ProjectsService } from '../services/projects.js';
import { RelationsService } from '../services/relations.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { ConsolidationRunner } from './runner.js';

/**
 * Sweep basics for the deterministic consolidator
 * (change `remove-llm-consolidation`): run rows, throttle behavior,
 * and the session-start entry point. Deadline-orphaning correctness
 * lives in `consolidation/orphan-promotion.test.ts`.
 */

let db: TestDb;
let runner: ConsolidationRunner;
let projects: ProjectsService;

beforeEach(() => {
  db = createTestDb();
  projects = new ProjectsService(createRepositories(db.handle.db));
  runner = new ConsolidationRunner({
    repos: createRepositories(db.handle.db),
    tx: db.handle.db,
    relations: new RelationsService(createRepositories(db.handle.db), db.handle.db),
  });
});

afterEach(() => db.cleanup());

describe('ConsolidationRunner sweep', () => {
  it('produces zero ops against an empty database', () => {
    const summary = runner.runAll({ force: true });
    expect(summary.runs.length).toBeGreaterThan(0);
    for (const r of summary.runs) {
      expect(r.ops.archives).toBe(0);
      expect(r.ops.orphaned).toBe(0);
    }
  });

  it('records one consolidation_runs row per scope with null llm columns', () => {
    projects.create({ slug: 'proj-a' });
    const summary = runner.runAll({ force: true });
    expect(summary.runs.length).toBe(2); // global + proj-a

    const rows = db.handle.db
      .select()
      .from(consolidationRuns)
      .orderBy(desc(consolidationRuns.startedAt))
      .all();
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.llmProvider).toBeNull();
      expect(row.llmModel).toBeNull();
      expect(row.finishedAt).not.toBeNull();
    }
  });

  it('throttles repeat sweeps within the interval and force bypasses it', () => {
    const first = runner.runAll();
    expect(first.runs.length).toBeGreaterThan(0);
    expect(first.skipped.length).toBe(0);

    const second = runner.runAll();
    expect(second.runs.length).toBe(0);
    expect(second.skipped.length).toBe(first.runs.length);

    const forced = runner.runAll({ force: true });
    expect(forced.runs.length).toBe(first.runs.length);
    expect(forced.skipped.length).toBe(0);
  });

  it('sweepFor covers the session scope plus global', () => {
    const p = projects.create({ slug: 'proj-b' });
    const summary = runner.sweepFor(p.id);
    const scopes = summary.runs.map((r) => r.scope);
    expect(scopes).toContainEqual({ scope: 'global', projectId: null });
    expect(scopes).toContainEqual({ scope: 'project', projectId: p.id });
  });

  it('a maintenance-scoped journal row does not suppress scope sweeps', () => {
    db.handle.raw
      .prepare(`INSERT INTO consolidation_runs (id, started_at, scope) VALUES (?, ?, ?)`)
      .run('01MAINTENANCE0000000000000', Date.now(), 'maintenance');
    const summary = runner.runAll();
    expect(summary.runs.length).toBeGreaterThan(0);
  });
});
