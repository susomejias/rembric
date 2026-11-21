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
import { and, eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildSessionHandlers } from '@rembric/mcp';

import { createTestDb, defaultProject, type TestDb } from './test-support/index.js';
import { logInternalError } from './test-support/test-logger.js';

const SCOPE: TokenScope = '*';

let db: TestDb;
let projects: ProjectsService;
let agentSessions: AgentSessionsService;
let tokens: TokensService;
let adminToken: Token;
let handlers: ReturnType<typeof buildSessionHandlers>;
let defaultProjectId: string;

function makeContext(): RequestContext {
  return {
    token: adminToken,
    scope: SCOPE,
    memberProjectIds: [],
    project: null,
    requestedSlug: null,
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
  tokens.bootstrapAdmin('session-tools-test-admin-zzz');
  adminToken = db.handle.db
    .select()
    .from(tokensSchema)
    .where(eq(tokensSchema.name, 'admin'))
    .get()!;
  handlers = buildSessionHandlers({ logInternalError, agentSessions, projects });
});

afterEach(() => db.cleanup());
/** The default-project session every test in this file starts from. */
function startSession(agent = 'a') {
  return agentSessions.start({ tokenId: adminToken.id, projectId: defaultProjectId, agent });
}

function backdate(id: string, minutesAgo: number) {
  const past = Date.now() - minutesAgo * 60_000;
  db.handle.raw
    .prepare('UPDATE sessions SET started_at = ?, last_activity_at = ? WHERE id = ?')
    .run(past, past, id);
}

function rowsForPair() {
  return db.handle.db
    .select()
    .from(agentSessionsTable)
    .where(
      and(
        eq(agentSessionsTable.tokenId, adminToken.id),
        eq(agentSessionsTable.projectId, defaultProjectId),
      ),
    )
    .all();
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

  it('adopts the sole active row even when it is idle past TRANSPORT_STALENESS_MS (no first ghost)', async () => {
    const s = startSession('pi');
    backdate(s.id, 89);

    const r = await runWithContext(makeContext(), () => handlers.sessionStart({}));
    const out = parseText<{ sessionId: string; reused: boolean }>(r);
    expect(out.reused).toBe(true);
    expect(out.sessionId).toBe(s.id);
    expect(rowsForPair()).toHaveLength(1);
  });

  it('still mints with two stale live rows: the no-guess rule is not widened into adoption', async () => {
    const a = startSession('a');
    const b = startSession('b');
    backdate(a.id, 90);
    backdate(b.id, 120);

    const r = await runWithContext(makeContext(), () => handlers.sessionStart({}));
    const out = parseText<{ sessionId: string; reused: boolean }>(r);
    expect(out.reused).toBe(false);
    expect(out.sessionId).not.toBe(a.id);
    expect(out.sessionId).not.toBe(b.id);
    expect(rowsForPair()).toHaveLength(3);
  });

  it('a resumed row binds nothing: session_start adopts the fresher live row, not the resumed one', async () => {
    const ctx = makeContext();
    const stale = startSession('pi');
    backdate(stale.id, 89);
    const other = startSession('other');
    await runWithContext(ctx, () => handlers.sessionResume({ sessionId: stale.id }));

    const r = await runWithContext(ctx, () => handlers.sessionStart({}));
    const out = parseText<{ sessionId: string; reused: boolean }>(r);
    expect(out.reused).toBe(true);
    expect(out.sessionId).toBe(other.id);
    expect(rowsForPair()).toHaveLength(2);
  });

  it('a row resumed and then ended is not adopted by a later session_start', async () => {
    const ctx = makeContext();
    const ended = startSession('ended');
    await runWithContext(ctx, () => handlers.sessionResume({ sessionId: ended.id }));
    agentSessions.end(ended.id, { tokenId: adminToken.id });

    const r = await runWithContext(ctx, () => handlers.sessionStart({}));
    const out = parseText<{ sessionId: string; reused: boolean }>(r);
    expect(out.sessionId).not.toBe(ended.id);
    expect(out.reused).toBe(false);
  });

  it('a soft-deleted resumed row is not adopted', async () => {
    const ctx = makeContext();
    const s = startSession('deleted');
    await runWithContext(ctx, () => handlers.sessionResume({ sessionId: s.id }));
    agentSessions.softDelete(s.id, { adminBypass: true });

    const r = await runWithContext(ctx, () => handlers.sessionStart({}));
    const out = parseText<{ sessionId: string; reused: boolean }>(r);
    expect(out.sessionId).not.toBe(s.id);
    expect(out.reused).toBe(false);
  });
});

describe('memory.session_start({project}) asserts the connection project', () => {
  const sessionCount = (): number => db.handle.db.select().from(agentSessionsTable).all().length;

  it.each([
    ['an existing other project', 'other-existing'],
    ['an unknown slug', 'no-such-slug'],
  ])('path-less: naming %s is scope_locked, naming the default slug', async (_label, slug) => {
    projects.create({ slug: 'other-existing' });
    const defaultSlug = projects.getDefault().slug;
    const before = projects.list(true).length;

    const r = await runWithContext(makeContext(), () =>
      handlers.sessionStart({ agent: 'probe', project: slug }),
    );
    const out = parseText<{ code: string; message: string }>(r);
    expect(out.code).toBe('scope_locked');
    expect(out.message).toBe(
      `connection resolves to the default project '${defaultSlug}'; cannot start a session for project '${slug}'`,
    );
    expect(sessionCount()).toBe(0);
    expect(projects.list(true)).toHaveLength(before);
  });

  it('path-scoped: naming another project is scope_locked, naming the bound slug', async () => {
    const foo = projects.create({ slug: 'foo' });
    projects.create({ slug: 'bar' });
    const ctx: RequestContext = { ...makeContext(), project: foo, requestedSlug: 'foo' };

    const r = await runWithContext(ctx, () => handlers.sessionStart({ project: 'bar' }));
    const out = parseText<{ code: string; message: string }>(r);
    expect(out.code).toBe('scope_locked');
    expect(out.message).toBe(
      "connection is path-scoped to 'foo'; cannot start a session for project 'bar'",
    );
    expect(sessionCount()).toBe(0);
  });

  it('control: naming the resolved project starts the session exactly as omitting it', async () => {
    const foo = projects.create({ slug: 'foo' });
    const atFoo: RequestContext = { ...makeContext(), project: foo, requestedSlug: 'foo' };
    const scoped = parseText<{ projectId: string; reused: boolean }>(
      await runWithContext(atFoo, () => handlers.sessionStart({ agent: 'a', project: 'foo' })),
    );
    expect(scoped).toMatchObject({ projectId: foo.id, reused: false });

    const defaultSlug = projects.getDefault().slug;
    const pathless = parseText<{ projectId: string; reused: boolean }>(
      await runWithContext(makeContext(), () =>
        handlers.sessionStart({ agent: 'a', project: defaultSlug }),
      ),
    );
    expect(pathless).toMatchObject({ projectId: defaultProjectId, reused: false });
    expect(sessionCount()).toBe(2);
  });

  it('activates nothing: a later call without project still resolves to the default project', async () => {
    projects.create({ slug: 'other-existing' });
    await runWithContext(makeContext(), () => handlers.sessionStart({ project: 'other-existing' }));
    const out = parseText<{ projectId: string }>(
      await runWithContext(makeContext(), () => handlers.sessionStart({})),
    );
    expect(out.projectId).toBe(defaultProjectId);
  });
});

describe('memory.session_summary and memory.session_end without a sessionId under ambiguity', () => {
  const ambiguityMessage =
    'more than one session is active for this token and project; pass your sessionId explicitly. memory.session_start cannot resolve this: it would open another session';

  type Lifecycle = 'sessionSummary' | 'sessionEnd';
  const withoutId: Record<Lifecycle, () => Promise<unknown>> = {
    sessionSummary: () => handlers.sessionSummary({ summary: '## Goal\nunattributed', title: 't' }),
    sessionEnd: () => handlers.sessionEnd({}),
  };

  for (const tool of ['sessionSummary', 'sessionEnd'] as const) {
    it(`${tool}: two fresh active sessions are refused as session_ambiguous and no row changes`, async () => {
      startSession('a');
      startSession('b');
      const before = rowsForPair();

      const r = await runWithContext(makeContext(), withoutId[tool]);
      expect((r as McpTextResponse).isError).toBe(true);
      expect(parseText<{ ok: boolean; code: string; message: string }>(r)).toEqual({
        ok: false,
        code: 'session_ambiguous',
        message: ambiguityMessage,
      });
      expect(rowsForPair()).toEqual(before);
    });

    it(`${tool}: two active sessions idle past the window are also session_ambiguous`, async () => {
      const a = startSession('a');
      const b = startSession('b');
      backdate(a.id, 90);
      backdate(b.id, 120);
      const before = rowsForPair();

      const r = await runWithContext(makeContext(), withoutId[tool]);
      expect(parseText<{ code: string }>(r).code).toBe('session_ambiguous');
      expect(rowsForPair()).toEqual(before);
    });

    it(`${tool}: one fresh and one idle session still resolves to the fresh one`, async () => {
      const idle = startSession('idle');
      backdate(idle.id, 90);
      const fresh = startSession('fresh');

      const r = await runWithContext(makeContext(), withoutId[tool]);
      expect((r as McpTextResponse).isError).toBeUndefined();
      expect(parseText<{ sessionId: string }>(r).sessionId).toBe(fresh.id);
    });

    it(`${tool}: no active session keeps session_not_found and its message`, async () => {
      const r = await runWithContext(makeContext(), withoutId[tool]);
      expect(parseText<{ code: string; message: string }>(r)).toEqual({
        ok: false,
        code: 'session_not_found',
        message: 'no active session on this MCP transport and no sessionId was provided',
      });
    });

    it(`${tool}: a sole active session idle past the window keeps session_not_found`, async () => {
      const s = startSession('idle');
      backdate(s.id, 90);

      const r = await runWithContext(makeContext(), withoutId[tool]);
      expect(parseText<{ code: string }>(r).code).toBe('session_not_found');
    });
  }

  it('an explicit sessionId still writes under ambiguity', async () => {
    const mine = startSession('mine');
    startSession('other');

    const r = await runWithContext(makeContext(), () =>
      handlers.sessionSummary({ sessionId: mine.id, summary: '## Goal\nmine', title: 't' }),
    );
    expect(parseText<{ sessionId: string; applied: boolean }>(r)).toMatchObject({
      sessionId: mine.id,
      applied: true,
    });
    expect(agentSessions.getById(mine.id)?.summary).toBe('## Goal\nmine');
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

  it('session_end on an abandoned row succeeds and leaves it abandoned', async () => {
    const ctx = makeContext();
    const s = startSession();
    agentSessions.markAbandoned(s.id, { adminBypass: true });

    const r = await runWithContext(ctx, () => handlers.sessionEnd({ sessionId: s.id }));
    expect(parseText<{ ok: boolean }>(r).ok).toBe(true);
    expect(agentSessions.getById(s.id)?.status).toBe('abandoned');
  });

  it('session_end on an active row ends it', async () => {
    const ctx = makeContext();
    const s = startSession();

    await runWithContext(ctx, () => handlers.sessionEnd({ sessionId: s.id }));
    expect(agentSessions.getById(s.id)?.status).toBe('ended');
  });

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

  it('applied is false and discardReason is terminal_final on a terminal row with a prior curated summary', async () => {
    const s = startSession();
    // Write the first curated summary
    await runWithContext(makeContext(), () =>
      handlers.sessionSummary({
        sessionId: s.id,
        summary: '## Goal\nfirst curated',
      }),
    );
    // Mark as abandoned (terminal)
    agentSessions.markAbandoned(s.id, { adminBypass: true });

    // Second write on terminal row with summaryFinal=true should be discarded
    const r = await runWithContext(makeContext(), () =>
      handlers.sessionSummary({
        sessionId: s.id,
        summary: '## Goal\nsecond curated',
      }),
    );
    const out = parseText<{
      ok: boolean;
      summary: string;
      applied: boolean;
      discardReason?: string;
    }>(r);
    expect(out.ok).toBe(true);
    expect(out.summary).toBe('## Goal\nfirst curated');
    expect(out.applied).toBe(false);
    expect(out.discardReason).toBe('terminal_final');
  });

  it('applied is true on a terminal row without a prior curated summary', async () => {
    const s = startSession();
    agentSessions.markAbandoned(s.id, { adminBypass: true });
    // No prior summary write — summaryFinal is false, write should land
    const r = await runWithContext(makeContext(), () =>
      handlers.sessionSummary({
        sessionId: s.id,
        summary: '## Goal\nlate handoff',
      }),
    );
    const out = parseText<{ ok: boolean; summary: string; applied: boolean }>(r);
    expect(out.ok).toBe(true);
    expect(out.summary).toBe('## Goal\nlate handoff');
    expect(out.applied).toBe(true);
  });

  it('applied is true and discardReason is absent on an active row', async () => {
    const s = startSession();
    const r = await runWithContext(makeContext(), () =>
      handlers.sessionSummary({
        sessionId: s.id,
        summary: '## Goal\nactive write',
      }),
    );
    const out = parseText<{ ok: boolean; applied: boolean; discardReason?: string }>(r);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
    expect(out.discardReason).toBeUndefined();
  });

  it('session_end applied is true on an active row', async () => {
    const s = startSession();
    const r = await runWithContext(makeContext(), () => handlers.sessionEnd({ sessionId: s.id }));
    const out = parseText<{ ok: boolean; applied: boolean }>(r);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(true);
  });

  it('session_end applied is false on an already-terminal row', async () => {
    const s = startSession();
    agentSessions.end(s.id, { tokenId: adminToken.id });
    // Already terminal — should be no-op
    const r = await runWithContext(makeContext(), () => handlers.sessionEnd({ sessionId: s.id }));
    const out = parseText<{ ok: boolean; applied: boolean }>(r);
    expect(out.ok).toBe(true);
    expect(out.applied).toBe(false);
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
    const { row: ended } = agentSessions.end(s.id, { tokenId: adminToken.id });

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

  it('binds nothing to the connection: with a second active session, a write must name it', async () => {
    const ctx = makeContext();
    const s = startSession();
    agentSessions.end(s.id, { tokenId: adminToken.id });
    const concurrent = startSession('concurrent');
    const transport = { tokenId: adminToken.id, projectId: defaultProjectId };
    expect(agentSessions.findActiveForTransport(transport)?.id).toBe(concurrent.id);

    await runWithContext(ctx, () => handlers.sessionResume({ sessionId: s.id }));

    expect(agentSessions.findActiveForTransport(transport)).toBeNull();
    const unnamed = await runWithContext(ctx, () =>
      handlers.sessionSummary({ summary: 'unnamed', title: 'unnamed' }),
    );
    expect(parseText<{ code?: string }>(unnamed).code).toBe('session_ambiguous');
    const named = await runWithContext(ctx, () =>
      handlers.sessionSummary({ sessionId: s.id, summary: 'named', title: 'named' }),
    );
    expect(parseText<{ sessionId: string }>(named).sessionId).toBe(s.id);
  });

  it('resumes an already-active session without mutating the row', async () => {
    const ctx = makeContext();
    const s = startSession();
    const before = agentSessions.getById(s.id);

    const r = await runWithContext(ctx, () => handlers.sessionResume({ sessionId: s.id }));
    const out = parseText<ResumeResponse>(r);

    expect(out.ok).toBe(true);
    expect(out.previousStatus).toBe('active');
    expect(out.previousEndedAt).toBeNull();
    expect(agentSessions.getById(s.id)?.lastActivityAt?.getTime()).toBe(
      before?.lastActivityAt?.getTime(),
    );
  });

  it('masks a session in another project as session_not_found', async () => {
    const mine = projects.create({ slug: 'resume-mine' });
    const theirs = projects.create({ slug: 'resume-theirs' });
    const s = agentSessions.start({ tokenId: adminToken.id, projectId: theirs.id, agent: 'x' });
    agentSessions.markAbandoned(s.id, { adminBypass: true });

    const ctx: RequestContext = {
      ...makeContext(),
      project: mine,
      requestedSlug: 'resume-mine',
    };
    const r = await runWithContext(ctx, () => handlers.sessionResume({ sessionId: s.id }));

    expect(parseText<ResumeResponse>(r).code).toBe('session_not_found');
    expect(agentSessions.getById(s.id)?.status).toBe('abandoned');
  });

  it('refuses a soft-deleted session', async () => {
    const ctx = makeContext();
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
    expect(sessionRowIds(adminToken.id, defaultProjectId)).toEqual([s.id]);
  });

  it('memory.session_end writes a fresh ended_at on a resumed row', async () => {
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
    const clocked = buildSessionHandlers({
      logInternalError,
      agentSessions: sessions,
      projects,
    });
    const ctx = makeContext();

    const s = sessions.start({ tokenId: adminToken.id, projectId: defaultProjectId, agent: 'a' });
    tick = 1;
    const { row: firstEnd } = sessions.end(s.id, { tokenId: adminToken.id });
    expect(firstEnd.endedAt?.getTime()).toBe(ticks[1]!.getTime());
    tick = 2;
    await runWithContext(ctx, () => clocked.sessionResume({ sessionId: s.id }));

    tick = 3;
    const r = await runWithContext(ctx, () => clocked.sessionEnd({ sessionId: s.id }));
    const out = parseText<{ ok: boolean; endedAt: string }>(r);

    expect(out.ok).toBe(true);
    expect(out.endedAt).toBe(ticks[3]!.toISOString());
    expect(out.endedAt).not.toBe(firstEnd.endedAt?.toISOString());
    const after = sessions.getById(s.id);
    expect(after?.status).toBe('ended');
    expect(after?.endedAt?.getTime()).toBe(ticks[3]!.getTime());
  });

  it('memory.session_summary replaces a final summary once the row is resumed, and not before', async () => {
    const s = startSession();
    agentSessions.end(s.id, { tokenId: adminToken.id });

    const first = await runWithContext(makeContext(), () =>
      handlers.sessionSummary({ sessionId: s.id, summary: 'A', title: 'first' }),
    );
    expect(parseText<SummaryResponse>(first).summary).toBe('A');

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
