import { desc, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { consolidationOps, consolidationRuns } from '../db/schema/consolidation.js';
import { memory, type MemoryType, type NewMemory } from '../db/schema/memory.js';
import { tokens as tokensSchema } from '../db/schema/tokens.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { deriveTitle } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { RelationsService } from '../services/relations.js';
import { TokensService } from '../services/tokens.js';
import { createTestDb, defaultProject, type TestDb } from '../test/index.js';

import { type DecayThresholds } from './decay.js';
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
let sessions: AgentSessionsService;
let tokens: TokensService;
let tokenId: string;

beforeEach(() => {
  db = createTestDb();
  projects = new ProjectsService(createRepositories(db.handle.db));
  sessions = new AgentSessionsService(createRepositories(db.handle.db), db.handle.db);
  tokens = new TokensService(createRepositories(db.handle.db));
  tokens.bootstrapAdmin('test-admin-token-with-enough-entropy');
  const admin = db.handle.db
    .select()
    .from(tokensSchema)
    .where(eq(tokensSchema.name, 'admin'))
    .get();
  tokenId = admin!.id;
  runner = new ConsolidationRunner({
    repos: createRepositories(db.handle.db),
    tx: db.handle.db,
    relations: new RelationsService(createRepositories(db.handle.db), db.handle.db),
    projects,
    agentSessions: sessions,
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
    const projA = projects.create({ slug: 'proj-a' });
    const summary = runner.runAll({ force: true });

    const rows = db.handle.db
      .select()
      .from(consolidationRuns)
      .orderBy(desc(consolidationRuns.startedAt))
      .all();
    // The SET, not the count: two rows cannot tell one scope swept twice with
    // another never swept from one row per scope.
    expect([...rows.map((r) => r.scope)].sort()).toEqual(
      [`project:${projA.id}`, `project:${defaultProject(db.handle).id}`].sort(),
    );
    expect(rows.length).toBe(summary.runs.length);
    for (const row of rows) {
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

  it('sweepFor covers the session project plus the default project', () => {
    const p = projects.create({ slug: 'proj-b' });
    const summary = runner.sweepFor(p.id);
    const scopes = summary.runs.map((r) => r.scope);
    expect(scopes).toContainEqual({
      scope: 'project',
      projectId: defaultProject(db.handle).id,
    });
    expect(scopes).toContainEqual({ scope: 'project', projectId: p.id });
  });

  it('sweepFor does not sweep the default project twice when it IS the session project', () => {
    const dflt = defaultProject(db.handle).id;
    const summary = runner.sweepFor(dflt);
    expect(summary.runs.map((r) => r.scope)).toEqual([{ scope: 'project', projectId: dflt }]);
    expect(summary.skipped).toEqual([]);
  });

  it('a maintenance-scoped journal row does not suppress scope sweeps', () => {
    db.handle.raw
      .prepare(`INSERT INTO consolidation_runs (id, started_at, scope) VALUES (?, ?, ?)`)
      .run('01MAINTENANCE0000000000000', Date.now(), 'maintenance');
    const summary = runner.runAll();
    expect(summary.runs.length).toBeGreaterThan(0);
  });

  it('purges a noise session (fails sessionHasContent, past the age floor) on the next sweep and journals it', () => {
    const projectId = projects.create({ slug: 'sweep-purge-test' }).id;
    const s = sessions.start({ tokenId, projectId, agent: 'noise' });
    sessions.end(s.id, { tokenId });
    db.handle.raw
      .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
      .run(Date.now() - 2 * 60 * 60 * 1000, s.id);

    const summary = runner.runAll({ force: true });
    // Non-zero, stated as a count: a purge assertion over a corpus with nothing
    // eligible passes without exercising anything.
    expect(summary.purgedSessionIds?.length ?? 0).toBeGreaterThan(0);
    expect(summary.purgedSessionIds).toContain(s.id);
    expect(sessions.getById(s.id)).toBeUndefined();

    const ops = db.handle.db
      .select()
      .from(consolidationOps)
      .where(eq(consolidationOps.opType, 'session_purge'))
      .all();
    expect(ops.length).toBe(1);
    expect(ops[0]!.affectedIds).toContain(s.id);
  });

  it("purges on the session-start path too, gated on the default project's run", () => {
    const projectId = projects.create({ slug: 'sweep-purge-lazy' }).id;
    const s = sessions.start({ tokenId, projectId: null, agent: 'noise' });
    sessions.end(s.id, { tokenId });
    db.handle.raw
      .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
      .run(Date.now() - 2 * 60 * 60 * 1000, s.id);

    const summary = runner.sweepFor(projectId);
    expect(summary.purgedSessionIds?.length ?? 0).toBeGreaterThan(0);
    expect(summary.purgedSessionIds).toContain(s.id);
    expect(sessions.getById(s.id)).toBeUndefined();
  });

  it('skips the purge step when the default project is throttled (not this call)', () => {
    runner.runAll(); // primes every scope's throttle, the default project included
    const projectId = projects.create({ slug: 'sweep-purge-throttled' }).id;
    const s = sessions.start({ tokenId, projectId, agent: 'noise' });
    sessions.end(s.id, { tokenId });
    db.handle.raw
      .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
      .run(Date.now() - 2 * 60 * 60 * 1000, s.id);

    const summary = runner.runAll(); // unforced — the default project is within the throttle window
    expect(summary.purgedSessionIds).toBeUndefined();
    expect(sessions.getById(s.id)).toBeDefined();
  });
});

function decayRow(id: string, type: MemoryType, lastSeenAt: Date, projectId: string): NewMemory {
  return {
    id,
    title: deriveTitle(`${type} ${id}`),
    content: `${type} ${id}`,
    scope: 'project',
    projectId,
    type,
    tags: [],
    status: 'active',
    replaces: [],
    createdAt: new Date(1_000),
    lastSeenAt,
  };
}

describe('ConsolidationRunner per-type decay', () => {
  // project/default decay after 1s; reference effectively never (1 day) on a
  // 60s-old clock.
  const SHORT_DECAY: DecayThresholds = {
    thresholdByType: { project: 1_000, reference: 86_400_000 },
    defaultThresholdMs: 1_000,
    confidenceFloor: 1,
  };

  function buildRunner(decay?: DecayThresholds): ConsolidationRunner {
    return new ConsolidationRunner({
      repos: createRepositories(db.handle.db),
      tx: db.handle.db,
      relations: new RelationsService(createRepositories(db.handle.db), db.handle.db),
      projects,
      agentSessions: { purgeEmpty: () => ({ deletedIds: [] }) },
      decay,
    });
  }

  it('archives only rows past their per-type threshold; reference is exempt', () => {
    const old = new Date(Date.now() - 60_000);
    const dflt = defaultProject(db.handle).id;
    db.handle.db
      .insert(memory)
      .values([
        decayRow('PROJ', 'project', old, dflt),
        decayRow('REF', 'reference', old, dflt),
        decayRow('USERD', 'user', old, dflt), // no explicit entry → defaultThresholdMs
      ])
      .run();

    const summary = buildRunner(SHORT_DECAY).runAll({ force: true });
    const archives = summary.runs.reduce((n, r) => n + r.ops.archives, 0);
    expect(archives).toBe(2);

    const statusOf = (id: string) =>
      db.handle.db.select().from(memory).where(eq(memory.id, id)).get()?.status;
    expect(statusOf('PROJ')).toBe('archived');
    expect(statusOf('USERD')).toBe('archived');
    expect(statusOf('REF')).toBe('active');
  });

  it('a session start in one project sweeps the default project too, and decays it', () => {
    const projA = projects.create({ slug: 'session-project' }).id;
    const dflt = defaultProject(db.handle).id;
    const old = new Date(Date.now() - 60_000);
    db.handle.db
      .insert(memory)
      .values([
        decayRow('DFLT-DECAY', 'project', old, dflt),
        decayRow('A-KEEP', 'reference', old, projA),
      ])
      .run();

    const summary = buildRunner(SHORT_DECAY).sweepFor(projA);

    // Both scopes swept, named by id rather than by any scope literal.
    expect(summary.runs.map((r) => r.scope.projectId).sort()).toEqual([projA, dflt].sort());
    const runScopes = db.handle.db
      .select()
      .from(consolidationRuns)
      .all()
      .map((r) => r.scope);
    expect(runScopes.sort()).toEqual([`project:${dflt}`, `project:${projA}`].sort());

    // The work itself, not just the run row: the default project's decayed row
    // is archived, and the exempt row in the session's project is untouched.
    const statusOf = (id: string) =>
      db.handle.db.select().from(memory).where(eq(memory.id, id)).get()?.status;
    expect(statusOf('DFLT-DECAY')).toBe('archived');
    expect(statusOf('A-KEEP')).toBe('active');
  });

  it('is idempotent: a second forced sweep archives nothing new', () => {
    db.handle.db
      .insert(memory)
      .values([
        decayRow('A', 'project', new Date(Date.now() - 60_000), defaultProject(db.handle).id),
      ])
      .run();
    const r = buildRunner(SHORT_DECAY);
    expect(r.runAll({ force: true }).runs.reduce((n, x) => n + x.ops.archives, 0)).toBe(1);
    expect(r.runAll({ force: true }).runs.reduce((n, x) => n + x.ops.archives, 0)).toBe(0);
  });
});
