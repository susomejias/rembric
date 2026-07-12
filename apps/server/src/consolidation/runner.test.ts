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
import { createTestDb, type TestDb } from '../test/index.js';

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
      expect(row.scope).not.toBeNull();
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

  it('purges a noise session (fails sessionHasContent, past the age floor) on the next sweep and journals it', () => {
    const projectId = projects.create({ slug: 'sweep-purge-test' }).id;
    const s = sessions.start({ tokenId, projectId, agent: 'noise' });
    sessions.end(s.id, { tokenId });
    db.handle.raw
      .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
      .run(Date.now() - 2 * 60 * 60 * 1000, s.id);

    const summary = runner.runAll({ force: true });
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

  it('skips the purge step when the global scope is throttled (not this call)', () => {
    runner.runAll(); // primes the global scope's throttle
    const projectId = projects.create({ slug: 'sweep-purge-throttled' }).id;
    const s = sessions.start({ tokenId, projectId, agent: 'noise' });
    sessions.end(s.id, { tokenId });
    db.handle.raw
      .prepare('UPDATE sessions SET ended_at = ? WHERE id = ?')
      .run(Date.now() - 2 * 60 * 60 * 1000, s.id);

    const summary = runner.runAll(); // unforced — global is within the throttle window
    expect(summary.purgedSessionIds).toBeUndefined();
    expect(sessions.getById(s.id)).toBeDefined();
  });
});

function decayRow(id: string, type: MemoryType, lastSeenAt: Date): NewMemory {
  return {
    id,
    title: deriveTitle(`${type} ${id}`),
    content: `${type} ${id}`,
    scope: 'global',
    projectId: null,
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
      agentSessions: { purgeEmpty: () => ({ deletedIds: [] }) },
      decay,
    });
  }

  it('archives only rows past their per-type threshold; reference is exempt', () => {
    const old = new Date(Date.now() - 60_000);
    db.handle.db
      .insert(memory)
      .values([
        decayRow('PROJ', 'project', old),
        decayRow('REF', 'reference', old),
        decayRow('USERD', 'user', old), // no explicit entry → defaultThresholdMs
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

  it('is idempotent: a second forced sweep archives nothing new', () => {
    db.handle.db
      .insert(memory)
      .values([decayRow('A', 'project', new Date(Date.now() - 60_000))])
      .run();
    const r = buildRunner(SHORT_DECAY);
    expect(r.runAll({ force: true }).runs.reduce((n, x) => n + x.ops.archives, 0)).toBe(1);
    expect(r.runAll({ force: true }).runs.reduce((n, x) => n + x.ops.archives, 0)).toBe(0);
  });
});
