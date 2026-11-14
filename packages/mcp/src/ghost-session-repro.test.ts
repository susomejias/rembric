import { AgentSessionsService } from '@rembric/core';
import { ProjectsService } from '@rembric/core';
import { TokensService, type TokenScope } from '@rembric/core';
import { runWithContext, type RequestContext } from '@rembric/core';
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

function makeContext(): RequestContext {
  return {
    token: adminToken,
    scope: SCOPE,
    memberProjectIds: [],
    project: null,
    requestedSlug: null,
  };
}

async function modelSessionStart() {
  const r = await runWithContext(makeContext(), () => handlers.sessionStart({}));
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
    sweep: () => {
      agentSessions.abandonStale({ olderThanMs: ABANDON_AFTER });
    },
  });
});

afterEach(() => db.cleanup());

describe('session_start resolution order: fresh-unique → sole-active → mint', () => {
  it('CONTROL: fresh unique active row is reused (probe sanity)', async () => {
    ensureHostRow(PI_SESSION_ID, 'pi');
    const r = await modelSessionStart();
    expect(r.reused).toBe(true);
    expect(r.sessionId).toBe(PI_SESSION_ID);
    expect(rowCount()).toBe(1);
  });

  it('sole-active adoption kills the idle-gap ghosts; ≥2 live rows still mint', async () => {
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
