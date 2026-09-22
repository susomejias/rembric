import { AgentSessionsService } from '@rembric/core';
import { ProjectsService } from '@rembric/core';
import { TokensService, type TokenScope } from '@rembric/core';
import { runWithContext, type RequestContext } from '@rembric/core';
import { SessionRouter } from '@rembric/core';
import {
  agentSessions as agentSessionsTable,
  createRepositories,
  tokens as tokensSchema,
  type Token,
} from '@rembric/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSessionHandlers } from '@rembric/mcp';

import { createTestDb, defaultProject, type TestDb } from './test-support/index.js';
import { logInternalError } from './test-support/test-logger.js';

// REGRESSION coverage for fix-pi-ghost-sessions (issue #377): one long-lived
// agent conversation must not accumulate session rows. The resolution order
// under test is binding → fresh-unique → sole-active-any-staleness → mint.
// The post-sweep mint (zero active rows after the 24h abandonment sweep) and
// the no-guess mint under ≥2 live rows are by-design controls, kept here so a
// widening of the adoption path fails loudly.

const SCOPE: TokenScope = '*';
const PI_SESSION_ID = '9f0e1d2c-3b4a-5f6e-7d8c-9a0b1c2d3e4f';
const OC_SESSION_ID = 'aa11bb22-cc33-4d44-8e55-ff66778899aa';
const MIN = 60_000;
const ABANDON_AFTER = 24 * 60 * MIN; // SESSION_ABANDON_AFTER_MS default

interface McpTextResponse {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

let db: TestDb;
let agentSessions: AgentSessionsService;
let adminToken: Token;
let handlers: ReturnType<typeof buildSessionHandlers>;
let defaultProjectId: string;
let nowMs: number;

function makeContext(mcpSessionId: string | null = null): RequestContext {
  return {
    token: adminToken,
    scope: SCOPE,
    memberProjectIds: [],
    project: null,
    requestedSlug: null,
    mcpSessionId,
  };
}

/** The model calling memory.session_start (no args) on the given transport. */
async function modelSessionStart(mcpSessionId: string | null = null) {
  const r = await runWithContext(makeContext(mcpSessionId), () => handlers.sessionStart({}));
  const parsed = JSON.parse((r as McpTextResponse).content[0]?.text ?? '{}') as {
    sessionId: string;
    reused: boolean;
    isError?: boolean;
  };
  return parsed;
}

function rowCount(): number {
  return db.handle.db.select().from(agentSessionsTable).all().length;
}

function rows() {
  return db.handle.db
    .select()
    .from(agentSessionsTable)
    .all()
    .map((r) => ({
      id: r.id.slice(0, 12),
      agent: r.agent,
      status: r.status,
      startedAt: r.startedAt.toISOString().slice(5, 16),
    }));
}

function ensureHostRow(id: string, agent: string) {
  agentSessions.ensure({
    id,
    tokenId: adminToken.id,
    projectId: defaultProjectId,
    agent,
    cwd: '/root/experimentor',
  });
}

beforeEach(() => {
  db = createTestDb();
  defaultProjectId = defaultProject(db.handle).id;
  nowMs = Date.parse('2026-08-01T09:00:00Z');
  agentSessions = new AgentSessionsService(
    createRepositories(db.handle.db),
    db.handle.db,
    () => new Date(nowMs),
  );
  const projects = new ProjectsService(createRepositories(db.handle.db));
  const tokens = new TokensService(createRepositories(db.handle.db), db.handle.db);
  tokens.bootstrapAdmin('ghost-regression-admin-zzz');
  adminToken = db.handle.db
    .select()
    .from(tokensSchema)
    .where(eq(tokensSchema.name, 'admin'))
    .get()!;
  handlers = buildSessionHandlers({
    logInternalError,
    agentSessions,
    projects,
    router: new SessionRouter(),
    sweep: () => {
      agentSessions.abandonStale({ olderThanMs: ABANDON_AFTER });
    },
  });
});

afterEach(() => db.cleanup());

describe('session_start resolution order: binding → fresh-unique → sole-active → mint', () => {
  it('CONTROL: fresh unique active row is reused (probe sanity)', async () => {
    ensureHostRow(PI_SESSION_ID, 'pi');
    const r = await modelSessionStart();
    expect(r.reused).toBe(true);
    expect(r.sessionId).toBe(PI_SESSION_ID);
    expect(rowCount()).toBe(1);
  });

  it('bound transport: zero ghosts before the sweep, one by-design mint after it, snowball dead', async () => {
    const T = 'repro-transport';

    // Day 1, 09:00 — the plugin registers the host uuid over HTTP.
    ensureHostRow(PI_SESSION_ID, 'pi');
    const first = await modelSessionStart(T);
    expect(first.reused).toBe(true);
    expect(first.sessionId).toBe(PI_SESSION_ID);

    // 10:29 — 89 minutes idle, then the model calls again: the pin answers.
    nowMs += 89 * MIN;
    const afterIdle = await modelSessionStart(T);
    expect(afterIdle.reused).toBe(true);
    expect(afterIdle.sessionId).toBe(PI_SESSION_ID);
    expect(rowCount()).toBe(1);

    // Day 3 — the periodic sweep (bootstrap + interval, outside any call)
    // abandoned R1 while it idled >24h; the pin's guards then fail and the
    // call mints once, by design.
    nowMs = Date.parse('2026-08-03T09:00:00Z');
    agentSessions.abandonStale({ olderThanMs: ABANDON_AFTER });
    const postSweep = await modelSessionStart(T);
    expect(postSweep.reused).toBe(false);
    expect(rowCount()).toBe(2);
    const ghostId = postSweep.sessionId;

    // The user reopens the same Pi conversation: ensure (idempotent) + /resume.
    ensureHostRow(PI_SESSION_ID, 'pi');
    agentSessions.resume(PI_SESSION_ID, { tokenId: adminToken.id });

    // Every later call on the bound transport reuses the bound row: the row
    // count stops growing even though two live rows coexist (the snowball case).
    const reusedIds: string[] = [];
    for (let i = 0; i < 5; i++) {
      nowMs += 2 * MIN;
      const r = await modelSessionStart(T);
      reusedIds.push(`${r.sessionId.slice(0, 8)}(reused=${r.reused})`);
      expect(r.reused).toBe(true);
      expect(r.sessionId).toBe(ghostId);
    }
    expect(rowCount()).toBe(2);

    // Quit: the plugin ends only its own row.
    agentSessions.end(PI_SESSION_ID, { tokenId: adminToken.id });

    const final = rows();

    expect(final).toHaveLength(2);
    expect(final.filter((r) => r.agent === 'pi')).toHaveLength(1);
    expect(final.find((r) => r.id === PI_SESSION_ID.slice(0, 12))?.status).toBe('ended');
    // The single 'unknown' row is the accepted post-sweep mint — never a
    // mid-conversation ghost.
    expect(final.filter((r) => r.agent === 'unknown')).toHaveLength(1);
  });

  it('binding-less transport: sole-active adoption kills the idle-gap ghosts; ≥2 live rows still mint', async () => {
    ensureHostRow(PI_SESSION_ID, 'pi');
    const first = await modelSessionStart();
    expect(first.reused).toBe(true);

    nowMs += 89 * MIN;
    const second = await modelSessionStart();
    expect(second.reused).toBe(true);
    expect(second.sessionId).toBe(PI_SESSION_ID);
    expect(rowCount()).toBe(1);

    nowMs += 56 * MIN;
    const third = await modelSessionStart();
    expect(third.reused).toBe(true);
    expect(third.sessionId).toBe(PI_SESSION_ID);
    expect(rowCount()).toBe(1);

    // Weekend: the periodic sweep abandons R1 while it idles; zero active rows
    // at the next call → one mint, by design.
    nowMs = Date.parse('2026-08-03T09:00:00Z');
    agentSessions.abandonStale({ olderThanMs: ABANDON_AFTER });
    const postSweep = await modelSessionStart();
    expect(postSweep.reused).toBe(false);
    expect(rowCount()).toBe(2);

    // Reopen: two live rows, no binding → the no-guess mint persists per call.
    ensureHostRow(PI_SESSION_ID, 'pi');
    agentSessions.resume(PI_SESSION_ID, { tokenId: adminToken.id });
    const mints: string[] = [];
    for (let i = 0; i < 3; i++) {
      nowMs += 2 * MIN;
      const r = await modelSessionStart();
      mints.push(`reused=${r.reused}`);
      expect(r.reused).toBe(false);
    }

    agentSessions.end(PI_SESSION_ID, { tokenId: adminToken.id });
    const final = rows();

    // The control: without a declared binding the no-guess mint is the whole
    // story for concurrent live rows — B must not widen into adoption.
    expect(final.filter((r) => r.agent === 'unknown').length).toBeGreaterThanOrEqual(3);
  });

  it('opencode cadence: sole-active adoption at every idle gap; zero unknown rows', async () => {
    ensureHostRow(OC_SESSION_ID, 'opencode');
    agentSessions.resume(OC_SESSION_ID, { tokenId: adminToken.id });
    agentSessions.reportTurn(OC_SESSION_ID, { tokenId: adminToken.id, usedTools: false });

    nowMs += 89 * MIN;
    const first = await modelSessionStart();
    expect(first.reused).toBe(true);
    expect(first.sessionId).toBe(OC_SESSION_ID);
    expect(rowCount()).toBe(1);

    // Turn 2 ends: /turn touches the real row.
    agentSessions.reportTurn(OC_SESSION_ID, { tokenId: adminToken.id, usedTools: true });

    nowMs += 120 * MIN;
    const second = await modelSessionStart();
    expect(second.reused).toBe(true);
    expect(second.sessionId).toBe(OC_SESSION_ID);
    expect(rowCount()).toBe(1);

    const final = rows();
    expect(final.filter((r) => r.agent === 'opencode')).toHaveLength(1);
    expect(final.filter((r) => r.agent === 'unknown')).toHaveLength(0);
  });
});
