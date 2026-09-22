import { AgentSessionsService } from '@rembric/core';
import { MemoryService } from '@rembric/core';
import { ProjectsService } from '@rembric/core';
import { PromptsService } from '@rembric/core';
import { TokensService, type TokenScope } from '@rembric/core';
import { runWithContext, type RequestContext } from '@rembric/core';
import { SessionRouter } from '@rembric/core';
import { createRepositories, tokens as tokensSchema, type Token } from '@rembric/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSessionHandlers } from '@rembric/mcp';

import { createTestDb, defaultProject, type TestDb } from './test-support/index.js';
import { logInternalError } from './test-support/test-logger.js';

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
let defaultProjectId: string;
let handlers: ReturnType<typeof buildSessionHandlers>;

function makeContext(token: Token, overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    token,
    scope: SCOPE,
    memberProjectIds: [],
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
  projects = new ProjectsService(createRepositories(db.handle.db));
  memory = new MemoryService(createRepositories(db.handle.db), db.handle.db);
  router = new SessionRouter();
  agentSessions = new AgentSessionsService(createRepositories(db.handle.db), db.handle.db);
  prompts = new PromptsService(createRepositories(db.handle.db), db.handle.db);
  tokens = new TokensService(createRepositories(db.handle.db), db.handle.db);
  tokens.bootstrapAdmin('session-deleted-test-admin-zzz');
  adminToken = db.handle.db
    .select()
    .from(tokensSchema)
    .where(eq(tokensSchema.name, 'admin'))
    .get()!;
  const created = tokens.create({ name: 'other', scope: SCOPE });
  otherToken = created.token;
  defaultProjectId = defaultProject(db.handle).id;
  const deps = {
    repos: createRepositories(db.handle.db),
    logInternalError,
    agentSessions,
    memory,
    projects,
    prompts,
    router,
    doctor: () => ({
      db: { journalMode: 'wal', integrity: 'ok', sizeBytes: 0 },
      embeddings: { model: 'fake-test-embedder', backlog: 0 },
      consolidation: { lastRunAt: null, lastRunOps: {} },
      sessions: { active: 0 },
      warnings: [],
    }),
  };
  handlers = buildSessionHandlers(deps);
});

afterEach(() => db.cleanup());
/** The default-project session every test in this file starts from. */
function startSession(agent = 'a') {
  return agentSessions.start({ tokenId: adminToken.id, projectId: defaultProjectId, agent });
}

describe('memory.session_end / .session_summary — session_deleted gate', () => {
  it('session_end on a soft-deleted row returns session_deleted', async () => {
    const sess = startSession();
    agentSessions.softDelete(sess.id, { adminBypass: true });
    const r = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(handlers.sessionEnd({ sessionId: sess.id })),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('session_deleted');
  });

  it('session_summary on a soft-deleted row returns session_deleted', async () => {
    const sess = startSession();
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
    const sess = startSession();
    agentSessions.softDelete(sess.id, { adminBypass: true });
    const r = await runWithContext(makeContext(otherToken), () =>
      Promise.resolve(handlers.sessionEnd({ sessionId: sess.id })),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('session_not_found');
  });

  it('memory.session_start opens a fresh row even when other sessions are deleted', async () => {
    const old = startSession('old');
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
