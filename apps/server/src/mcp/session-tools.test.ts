import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { agentSessions as agentSessionsTable } from '../db/schema/agent-sessions.js';
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
    memberProjectIds: [],
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
  tokens = new TokensService(createRepositories(db.handle.db), db.handle.db);
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

  it('reports the adopted session’s own agent, not the caller’s argument', async () => {
    const existing = startSession('claude-code');

    const r = await runWithContext(makeContext(), () => handlers.sessionStart({ agent: 'pi' }));
    const out = parseText<{ sessionId: string; reused: boolean; agent: string }>(r);
    expect(out.reused).toBe(true);
    expect(out.agent).toBe('claude-code');

    const rows = db.handle.db
      .select()
      .from(agentSessionsTable)
      .where(
        and(
          eq(agentSessionsTable.tokenId, adminToken.id),
          eq(agentSessionsTable.projectId, defaultProjectId),
        ),
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.agent).toBe('claude-code');
    expect(out.sessionId).toBe(existing.id);
  });

  it('control: a fresh mint reports the agent it was passed', async () => {
    const r = await runWithContext(makeContext(), () => handlers.sessionStart({ agent: 'pi' }));
    const out = parseText<{ reused: boolean; agent: string }>(r);
    expect(out.reused).toBe(false);
    expect(out.agent).toBe('pi');
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

describe('memory.session_resume', () => {
  interface ResumeResponse {
    ok: boolean;
    sessionId: string;
    status: string;
    startedAt: string;
    resumedAt: string;
    previousStatus: string;
    previousEndedAt: string | null;
    title: string | null;
    code?: string;
  }

  it('returns an ended session to active and reports what it discarded', async () => {
    const s = startSession();
    const ended = agentSessions.end(s.id, { tokenId: adminToken.id });

    const r = await runWithContext(makeContext(), () =>
      handlers.sessionResume({ sessionId: s.id }),
    );
    const out = parseText<ResumeResponse>(r);

    expect(out.ok).toBe(true);
    expect(out.sessionId).toBe(s.id);
    expect(out.status).toBe('active');
    expect(out.previousStatus).toBe('ended');
    expect(out.previousEndedAt).toBe(ended.endedAt?.toISOString());
    expect(out.startedAt).toBe(s.startedAt.toISOString());
    expect(out.title).toBe(s.title);

    const row = agentSessions.getById(s.id);
    expect(row?.status).toBe('active');
    expect(row?.endedAt).toBeNull();
  });

  it('reports previousStatus abandoned for a swept row', async () => {
    const s = startSession();
    const abandoned = agentSessions.markAbandoned(s.id, { adminBypass: true });

    const r = await runWithContext(makeContext(), () =>
      handlers.sessionResume({ sessionId: s.id }),
    );
    const out = parseText<ResumeResponse>(r);

    expect(out.previousStatus).toBe('abandoned');
    expect(out.previousEndedAt).toBe(abandoned.endedAt?.toISOString());
    expect(out.status).toBe('active');
  });

  // The pin, not the sole-active fallback, is what carries attribution: a
  // second live session for the same (token, project) makes that fallback
  // refuse to resolve, so this is the only arrangement where the two differ.
  it('pins the transport binding even with a second active session in the same scope', async () => {
    const ctx: RequestContext = { ...makeContext(), mcpSessionId: 'transport-resume' };
    const s = startSession();
    agentSessions.end(s.id, { tokenId: adminToken.id });
    const concurrent = startSession('concurrent');
    const transport = { tokenId: adminToken.id, projectId: defaultProjectId };
    expect(router.get(adminToken.id, 'transport-resume')?.rembricSessionId).toBeUndefined();
    expect(agentSessions.findActiveForTransport(transport)?.id).toBe(concurrent.id);

    await runWithContext(ctx, () => handlers.sessionResume({ sessionId: s.id }));

    expect(agentSessions.findActiveForTransport(transport)).toBeNull();
    expect(router.get(adminToken.id, 'transport-resume')?.rembricSessionId).toBe(s.id);
  });

  it('re-pins an already-active session without mutating the row', async () => {
    const ctx: RequestContext = { ...makeContext(), mcpSessionId: 'transport-noop' };
    const s = startSession();
    const before = agentSessions.getById(s.id);

    const r = await runWithContext(ctx, () => handlers.sessionResume({ sessionId: s.id }));
    const out = parseText<ResumeResponse>(r);

    expect(out.ok).toBe(true);
    expect(out.previousStatus).toBe('active');
    expect(out.previousEndedAt).toBeNull();
    expect(router.get(adminToken.id, 'transport-noop')?.rembricSessionId).toBe(s.id);
    expect(agentSessions.getById(s.id)?.lastActivityAt?.getTime()).toBe(
      before?.lastActivityAt?.getTime(),
    );
  });

  it('masks a session in another project as session_not_found and pins nothing', async () => {
    const mine = projects.create({ slug: 'resume-mine' });
    const theirs = projects.create({ slug: 'resume-theirs' });
    const s = agentSessions.start({ tokenId: adminToken.id, projectId: theirs.id, agent: 'x' });
    agentSessions.markAbandoned(s.id, { adminBypass: true });

    const ctx: RequestContext = {
      ...makeContext(),
      project: mine,
      requestedSlug: 'resume-mine',
      mcpSessionId: 'transport-cross',
    };
    const r = await runWithContext(ctx, () => handlers.sessionResume({ sessionId: s.id }));

    expect(parseText<ResumeResponse>(r).code).toBe('session_not_found');
    expect(agentSessions.getById(s.id)?.status).toBe('abandoned');
    expect(router.get(adminToken.id, 'transport-cross')?.rembricSessionId).toBeUndefined();
  });

  it('refuses a soft-deleted session and pins nothing', async () => {
    const ctx: RequestContext = { ...makeContext(), mcpSessionId: 'transport-deleted' };
    const s = startSession();
    agentSessions.end(s.id, { tokenId: adminToken.id });
    agentSessions.softDelete(s.id, { adminBypass: true });
    const before = agentSessions.getById(s.id);

    const r = await runWithContext(ctx, () => handlers.sessionResume({ sessionId: s.id }));

    expect(parseText<ResumeResponse>(r).code).toBe('session_deleted');
    const after = agentSessions.getById(s.id);
    expect(after?.status).toBe('ended');
    expect(after?.endedAt?.getTime()).toBe(before?.endedAt?.getTime());
    expect(after?.lastActivityAt?.getTime()).toBe(before?.lastActivityAt?.getTime());
    expect(after?.deletedAt?.getTime()).toBe(before?.deletedAt?.getTime());
    expect(router.get(adminToken.id, 'transport-deleted')?.rembricSessionId).toBeUndefined();
  });

  it('masks another token’s session as session_not_found', async () => {
    const { token: other } = tokens.create({ name: 'other-agent', scope: SCOPE });
    const s = agentSessions.start({
      tokenId: other.id,
      projectId: defaultProjectId,
      agent: 'theirs',
    });
    agentSessions.end(s.id, { tokenId: other.id });

    const r = await runWithContext(makeContext(), () =>
      handlers.sessionResume({ sessionId: s.id }),
    );

    expect(parseText<ResumeResponse>(r).code).toBe('session_not_found');
    expect(agentSessions.getById(s.id)?.status).toBe('ended');
  });
});

/**
 * A resumed row is `active` again, so the three lifecycle tools must take
 * their active branch on it — the branch the row's previous terminal state
 * had made unreachable.
 */
describe('session tools acting on a resumed session', () => {
  interface SummaryResponse {
    ok: boolean;
    sessionId: string;
    summary: string;
    title: string | null;
    summaryFinal: boolean;
    titleFinal: boolean;
  }

  function sessionRowIds(tokenId: string, projectId: string): string[] {
    return db.handle.db
      .select({ id: agentSessionsTable.id })
      .from(agentSessionsTable)
      .where(
        and(eq(agentSessionsTable.tokenId, tokenId), eq(agentSessionsTable.projectId, projectId)),
      )
      .all()
      .map((r) => r.id);
  }

  it('memory.session_start adopts the resumed row instead of minting a second one', async () => {
    const s = startSession();
    agentSessions.end(s.id, { tokenId: adminToken.id });
    await runWithContext(makeContext(), () => handlers.sessionResume({ sessionId: s.id }));
    expect(sessionRowIds(adminToken.id, defaultProjectId)).toEqual([s.id]);

    const r = await runWithContext(makeContext(), () => handlers.sessionStart({}));
    const out = parseText<{ sessionId: string; reused: boolean }>(r);

    expect(out.reused).toBe(true);
    expect(out.sessionId).toBe(s.id);
    // The control: `reused: true` describes adoption only if the row count is
    // unmoved — matching ids alone would also hold if a second row existed.
    expect(sessionRowIds(adminToken.id, defaultProjectId)).toEqual([s.id]);
  });

  it('memory.session_end writes a fresh ended_at on a resumed row and clears the binding', async () => {
    // Injected clock: two `end()` calls can land in the same millisecond, which
    // makes a fresh `ended_at` indistinguishable from the discarded one.
    const ticks = [
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-01T01:00:00.000Z'),
      new Date('2026-01-01T02:00:00.000Z'),
      new Date('2026-01-01T03:00:00.000Z'),
    ];
    let tick = 0;
    const sessions = new AgentSessionsService(
      createRepositories(db.handle.db),
      db.handle.db,
      () => ticks[tick]!,
    );
    const clocked = buildSessionHandlers({ agentSessions: sessions, projects, router });
    const ctx: RequestContext = { ...makeContext(), mcpSessionId: 'transport-resume-end' };

    const s = sessions.start({ tokenId: adminToken.id, projectId: defaultProjectId, agent: 'a' });
    tick = 1;
    const firstEnd = sessions.end(s.id, { tokenId: adminToken.id });
    expect(firstEnd.endedAt?.getTime()).toBe(ticks[1]!.getTime());
    tick = 2;
    await runWithContext(ctx, () => clocked.sessionResume({ sessionId: s.id }));
    expect(router.get(adminToken.id, 'transport-resume-end')?.rembricSessionId).toBe(s.id);

    tick = 3;
    const r = await runWithContext(ctx, () => clocked.sessionEnd({ sessionId: s.id }));
    const out = parseText<{ ok: boolean; endedAt: string }>(r);

    expect(out.ok).toBe(true);
    expect(out.endedAt).toBe(ticks[3]!.toISOString());
    expect(out.endedAt).not.toBe(firstEnd.endedAt?.toISOString());
    const after = sessions.getById(s.id);
    expect(after?.status).toBe('ended');
    expect(after?.endedAt?.getTime()).toBe(ticks[3]!.getTime());
    expect(router.get(adminToken.id, 'transport-resume-end')?.rembricSessionId).toBeNull();
  });

  it('memory.session_summary replaces a final summary once the row is resumed, and not before', async () => {
    const s = startSession();
    agentSessions.end(s.id, { tokenId: adminToken.id });

    const first = await runWithContext(makeContext(), () =>
      handlers.sessionSummary({ sessionId: s.id, summary: 'A', title: 'first' }),
    );
    expect(parseText<SummaryResponse>(first).summary).toBe('A');

    // The control: while the row is still terminal, first-final-wins refuses
    // the second write. Without this arm the post-resume replacement below
    // could just be a property the write always had.
    const refused = await runWithContext(makeContext(), () =>
      handlers.sessionSummary({ sessionId: s.id, summary: 'B', title: 'second' }),
    );
    const refusedOut = parseText<SummaryResponse>(refused);
    expect(refusedOut.summary).toBe('A');
    expect(refusedOut.title).toBe('first');
    expect(agentSessions.getById(s.id)?.summary).toBe('A');

    await runWithContext(makeContext(), () => handlers.sessionResume({ sessionId: s.id }));

    const replaced = await runWithContext(makeContext(), () =>
      handlers.sessionSummary({ sessionId: s.id, summary: 'C', title: 'third' }),
    );
    const out = parseText<SummaryResponse>(replaced);
    expect(out.summary).toBe('C');
    expect(out.title).toBe('third');
    expect(out.summaryFinal).toBe(true);
    expect(out.titleFinal).toBe(true);

    const row = agentSessions.getById(s.id);
    expect(row?.summary).toBe('C');
    expect(row?.title).toBe('third');
    expect(row?.status).toBe('active');
    expect(row?.endedAt).toBeNull();
  });
});
