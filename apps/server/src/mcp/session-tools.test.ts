import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { tokens as tokensSchema, type Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { ProjectsService } from '../services/projects.js';
import { TokensService, type TokenScope } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { buildSessionHandlers } from './session-tools.js';

/**
 * `memory.session_start`'s "reuse an existing session instead of minting a
 * new one" logic shares `AgentSessionsService.findActiveForTransport` with
 * the auto-attach fallback used by memory.save/confirm/session_summary.
 * Focused coverage for the reuse-under-ambiguity case this proposal fixes;
 * see agent-sessions.test.ts and memory-tools.test.ts for the rest of
 * findActiveForTransport's contract.
 */

const SCOPE: TokenScope = '*';

let db: TestDb;
let projects: ProjectsService;
let agentSessions: AgentSessionsService;
let tokens: TokensService;
let adminToken: Token;
let handlers: ReturnType<typeof buildSessionHandlers>;
let router: SessionRouter;

function makeContext(): RequestContext {
  return {
    token: adminToken,
    scope: SCOPE,
    project: null,
    requestedSlug: null,
    mcpSessionId: null,
  };
}

interface McpTextResponse {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function parseText<T = unknown>(resp: unknown): T {
  const r = resp as McpTextResponse;
  return JSON.parse(r.content[0]?.text ?? '') as T;
}

beforeEach(() => {
  db = createTestDb();
  projects = new ProjectsService(createRepositories(db.handle.db));
  agentSessions = new AgentSessionsService(createRepositories(db.handle.db), db.handle.db);
  tokens = new TokensService(createRepositories(db.handle.db));
  router = new SessionRouter();
  tokens.bootstrapAdmin('session-tools-test-admin-zzz');
  adminToken = db.handle.db
    .select()
    .from(tokensSchema)
    .where(eq(tokensSchema.name, 'admin'))
    .get()!;
  handlers = buildSessionHandlers({ agentSessions, projects, router });
});

afterEach(() => db.cleanup());

describe('memory.session_start — reuse vs. mint under (tokenId, projectId) ambiguity', () => {
  it('reuses the sole existing active session for the pair', async () => {
    const existing = agentSessions.start({
      tokenId: adminToken.id,
      projectId: null,
      agent: 'a',
    });

    const r = await runWithContext(makeContext(), () => handlers.sessionStart({}));
    const out = parseText<{ sessionId: string; reused: boolean }>(r);
    expect(out.reused).toBe(true);
    expect(out.sessionId).toBe(existing.id);
  });

  it('mints a fresh session instead of adopting one of two ambiguous active sessions', async () => {
    const a = agentSessions.start({ tokenId: adminToken.id, projectId: null, agent: 'a' });
    const b = agentSessions.start({ tokenId: adminToken.id, projectId: null, agent: 'b' });

    const r = await runWithContext(makeContext(), () => handlers.sessionStart({}));
    const out = parseText<{ sessionId: string; reused: boolean }>(r);
    expect(out.reused).toBe(false);
    expect(out.sessionId).not.toBe(a.id);
    expect(out.sessionId).not.toBe(b.id);
  });
});
