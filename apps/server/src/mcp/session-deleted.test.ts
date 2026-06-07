import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { tokens as tokensSchema, type Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { PromptsService } from '../services/prompts.js';
import { TokensService, type TokenScope } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { buildSessionsHandlers } from './sessions-tools.js';

/**
 * 4.3 — Session-lifecycle MCP tools reject soft-deleted target rows
 * with `code='session_deleted'`. Cross-token requests on a deleted row
 * still receive the existing `session_not_found` mask.
 */

const MCP_SESSION_ID = 'mcp-sess-test';
const SCOPE: TokenScope = '*';

let db: TestDb;
let projects: ProjectsService;
let memory: MemoryService;
let router: SessionRouter;
let agentSessions: AgentSessionsService;
let prompts: PromptsService;
let tokens: TokensService;
let adminToken: Token;
let otherToken: Token;
let handlers: ReturnType<typeof buildSessionsHandlers>;

function makeContext(token: Token, overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    token,
    scope: SCOPE,
    project: null,
    requestedSlug: null,
    mcpSessionId: MCP_SESSION_ID,
    ...overrides,
  };
}

interface McpResp {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function decode(resp: unknown): { isError: boolean; payload: Record<string, unknown> } {
  const r = resp as McpResp;
  const text = r.content[0]?.text ?? '';
  return { isError: r.isError === true, payload: JSON.parse(text) as Record<string, unknown> };
}

beforeEach(() => {
  db = createTestDb();
  projects = new ProjectsService(db.handle.db);
  memory = new MemoryService(createRepositories(db.handle.db), db.handle.db);
  router = new SessionRouter();
  agentSessions = new AgentSessionsService(createRepositories(db.handle.db), db.handle.db);
  prompts = new PromptsService(createRepositories(db.handle.db), db.handle.db);
  tokens = new TokensService(db.handle.db);
  tokens.bootstrapAdmin('session-deleted-test-admin-zzz');
  adminToken = db.handle.db
    .select()
    .from(tokensSchema)
    .where(eq(tokensSchema.name, 'admin'))
    .get()!;
  const created = tokens.create({ name: 'other', scope: SCOPE });
  otherToken = created.token;
  handlers = buildSessionsHandlers({
    db: db.handle.db,
    agentSessions,
    memory,
    projects,
    prompts,
    router,
    doctor: () => ({
      db: { open: true, journalMode: 'wal', integrity: 'ok', sizeBytes: 0 },
      llm: { reachable: false, lastPingAt: null },
      embeddings: { model: 'fake-test-embedder', backlog: 0 },
      consolidation: { lastRunAt: null, lastRunOps: {} },
      sessions: { active: 0 },
      warnings: [],
    }),
  });
});

afterEach(() => db.cleanup());

describe('memory.session_end / .session_summary — session_deleted gate', () => {
  it('session_end on a soft-deleted row returns session_deleted', async () => {
    const sess = agentSessions.start({ tokenId: adminToken.id, projectId: null, agent: 'a' });
    agentSessions.softDelete(sess.id, { adminBypass: true });
    const r = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(handlers.sessionEnd({ sessionId: sess.id })),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('session_deleted');
  });

  it('session_summary on a soft-deleted row returns session_deleted', async () => {
    const sess = agentSessions.start({ tokenId: adminToken.id, projectId: null, agent: 'a' });
    agentSessions.softDelete(sess.id, { adminBypass: true });
    const r = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(handlers.sessionSummary({ sessionId: sess.id, summary: 'late summary' })),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('session_deleted');

    // Confirm no column was mutated.
    const after = agentSessions.getById(sess.id);
    expect(after?.summary).toBeNull();
  });

  it('cross-token call still gets session_not_found (not session_deleted)', async () => {
    const sess = agentSessions.start({ tokenId: adminToken.id, projectId: null, agent: 'a' });
    agentSessions.softDelete(sess.id, { adminBypass: true });
    const r = await runWithContext(makeContext(otherToken), () =>
      Promise.resolve(handlers.sessionEnd({ sessionId: sess.id })),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('session_not_found');
  });

  it('memory.session_start opens a fresh row even when other sessions are deleted', async () => {
    const old = agentSessions.start({ tokenId: adminToken.id, projectId: null, agent: 'old' });
    agentSessions.softDelete(old.id, { adminBypass: true });
    const r = await runWithContext(makeContext(adminToken), () =>
      handlers.sessionStart({ agent: 'new' }),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(payload.sessionId).toBeDefined();
    expect(payload.sessionId).not.toBe(old.id);
  });
});
