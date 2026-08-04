import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { tokens as tokensSchema, type Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { ProjectsService } from '../services/projects.js';
import { TokensService, type TokenScope } from '../services/tokens.js';
import { createTestDb, defaultProject, type TestDb } from '../test/index.js';

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
let defaultProjectId: string;
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
  defaultProjectId = defaultProject(db.handle).id;
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
/** The default-project session every test in this file starts from. */
function startSession(agent = 'a') {
  return agentSessions.start({ tokenId: adminToken.id, projectId: defaultProjectId, agent });
}

describe('memory.session_start — reuse vs. mint under (tokenId, projectId) ambiguity', () => {
  it('reuses the sole existing active session for the pair', async () => {
    const existing = startSession();

    const r = await runWithContext(makeContext(), () => handlers.sessionStart({}));
    const out = parseText<{ sessionId: string; reused: boolean }>(r);
    expect(out.reused).toBe(true);
    expect(out.sessionId).toBe(existing.id);
  });

  it('mints a fresh session instead of adopting one of two ambiguous active sessions', async () => {
    const a = startSession();
    const b = startSession('b');

    const r = await runWithContext(makeContext(), () => handlers.sessionStart({}));
    const out = parseText<{ sessionId: string; reused: boolean }>(r);
    expect(out.reused).toBe(false);
    expect(out.sessionId).not.toBe(a.id);
    expect(out.sessionId).not.toBe(b.id);
  });
});

describe('memory.session_summary on a session the sweep already abandoned', () => {
  it('succeeds with an explicit sessionId and leaves the lifecycle columns alone', async () => {
    const s = startSession();
    agentSessions.markAbandoned(s.id, { adminBypass: true });
    const before = agentSessions.getById(s.id);

    const r = await runWithContext(makeContext(), () =>
      handlers.sessionSummary({
        sessionId: s.id,
        summary: '## Goal\ncurated handoff',
        title: 'Fix the reaper',
      }),
    );
    const out = parseText<{ ok: boolean; summary: string; summaryFinal: boolean }>(r);
    expect(out.ok).toBe(true);
    expect(out.summary).toBe('## Goal\ncurated handoff');
    expect(out.summaryFinal).toBe(true);

    const after = agentSessions.getById(s.id);
    expect(after?.status).toBe('abandoned');
    expect(after?.endedAt?.getTime()).toBe(before?.endedAt?.getTime());
    expect(after?.lastActivityAt?.getTime()).toBe(before?.lastActivityAt?.getTime());
  });

  // `end()` used to throw on an abandoned row, so `clearSession` was
  // unreachable and the binding survived. Widening `end()` made it reachable;
  // clearing it would drop every later save on this transport to session_id NULL.
  it('session_end on an abandoned row keeps the transport binding', async () => {
    const ctx: RequestContext = { ...makeContext(), mcpSessionId: 'transport-1' };
    const s = startSession();
    router.setActiveSession(adminToken.id, 'transport-1', s.id);
    agentSessions.markAbandoned(s.id, { adminBypass: true });

    const r = await runWithContext(ctx, () => handlers.sessionEnd({ sessionId: s.id }));
    expect(parseText<{ ok: boolean }>(r).ok).toBe(true);
    expect(router.get(adminToken.id, 'transport-1')?.rembricSessionId).toBe(s.id);
    expect(agentSessions.getById(s.id)?.status).toBe('abandoned');
  });

  it('session_end on an active row still clears the binding', async () => {
    const ctx: RequestContext = { ...makeContext(), mcpSessionId: 'transport-2' };
    const s = startSession();
    router.setActiveSession(adminToken.id, 'transport-2', s.id);

    await runWithContext(ctx, () => handlers.sessionEnd({ sessionId: s.id }));
    expect(router.get(adminToken.id, 'transport-2')?.rembricSessionId).toBeNull();
    expect(agentSessions.getById(s.id)?.status).toBe('ended');
  });

  // The rest of this file runs on the default project's context, so the project
  // mask is never exercised there. Late writes widened the reachable set from "my one
  // live session" to "every terminal session this token created", which is what
  // makes the mask load-bearing rather than decorative.
  it('masks a terminal session belonging to another project as session_not_found', async () => {
    const mine = projects.create({ slug: 'mine' });
    const theirs = projects.create({ slug: 'theirs' });
    const s = agentSessions.start({ tokenId: adminToken.id, projectId: theirs.id, agent: 'x' });
    agentSessions.markAbandoned(s.id, { adminBypass: true });

    const ctx: RequestContext = { ...makeContext(), project: mine, requestedSlug: 'mine' };
    const r = await runWithContext(ctx, () =>
      handlers.sessionSummary({ sessionId: s.id, summary: 'cross-project write' }),
    );
    expect(parseText<{ code: string }>(r).code).toBe('session_not_found');
    expect(agentSessions.getById(s.id)?.summary).toBeNull();
  });

  it('still writes when the terminal session belongs to the scoped project', async () => {
    const mine = projects.findBySlug('mine') ?? projects.create({ slug: 'mine' });
    const s = agentSessions.start({ tokenId: adminToken.id, projectId: mine.id, agent: 'x' });
    agentSessions.markAbandoned(s.id, { adminBypass: true });

    const ctx: RequestContext = { ...makeContext(), project: mine, requestedSlug: 'mine' };
    const r = await runWithContext(ctx, () =>
      handlers.sessionSummary({ sessionId: s.id, summary: 'same-project late write' }),
    );
    expect(parseText<{ ok: boolean }>(r).ok).toBe(true);
    expect(agentSessions.getById(s.id)?.summary).toBe('same-project late write');
  });

  it('still reports session_not_found (never attaches) when the only candidate is abandoned and no id was passed', async () => {
    const s = startSession();
    agentSessions.markAbandoned(s.id, { adminBypass: true });

    const r = await runWithContext(makeContext(), () =>
      handlers.sessionSummary({ summary: 'no id, no router entry' }),
    );
    const out = parseText<{ ok: boolean; code: string }>(r);
    expect(out.code).toBe('session_not_found');
    expect(agentSessions.getById(s.id)?.summary).toBeNull();
  });
});
