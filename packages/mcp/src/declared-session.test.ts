import { AgentSessionsService } from '@rembric/core';
import { MemoryService } from '@rembric/core';
import { ProjectsService } from '@rembric/core';
import { PromptsService } from '@rembric/core';
import { TokensService } from '@rembric/core';
import { runWithContext, type RequestContext } from '@rembric/core';
import { createRepositories, projectScope, tokens as tokensSchema, type Token } from '@rembric/db';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildMemoryHandlers } from '@rembric/mcp';
import { buildObservabilityHandlers } from '@rembric/mcp';
import { buildPromptHandlers } from '@rembric/mcp';
import { buildSessionHandlers } from '@rembric/mcp';

import { seedProject } from './test-support/default-project.js';
import { createTestDb, defaultProject, type TestDb } from './test-support/index.js';
import { logInternalError } from './test-support/test-logger.js';

let db: TestDb;
let agentSessions: AgentSessionsService;
let memory: MemoryService;
let adminToken: Token;
let otherToken: Token;
let defaultProjectId: string;
let handlers: ReturnType<typeof buildMemoryHandlers> &
  ReturnType<typeof buildPromptHandlers> &
  ReturnType<typeof buildObservabilityHandlers> &
  ReturnType<typeof buildSessionHandlers>;

const OTHER_PROJECT_ID = 'p-declared-other';

function ctx(declaredSessionId?: string): RequestContext {
  return {
    token: adminToken,
    scope: '*',
    memberProjectIds: [],
    project: null,
    requestedSlug: null,
    ...(declaredSessionId === undefined ? {} : { declaredSessionId }),
  };
}

interface McpResp {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function decode(resp: unknown): { isError: boolean; payload: Record<string, unknown> } {
  const r = resp as McpResp;
  return {
    isError: r.isError === true,
    payload: JSON.parse(r.content[0]?.text ?? '') as Record<string, unknown>,
  };
}

async function call(context: RequestContext, fn: () => unknown) {
  return decode(await runWithContext(context, () => Promise.resolve(fn())));
}

function start(agent = 'a', tokenId = adminToken.id, projectId: string = defaultProjectId) {
  return agentSessions.start({ tokenId, projectId, agent });
}

function column(table: string, col: string, id: string): unknown {
  const row = db.handle.raw.prepare(`SELECT ${col} AS v FROM ${table} WHERE id = ?`).get(id) as
    | { v: unknown }
    | undefined;
  return row?.v;
}

function sessionCount(): number {
  return (db.handle.raw.prepare('SELECT COUNT(*) AS n FROM sessions').get() as { n: number }).n;
}

const SAVE = { type: 'project' as const, title: 'declared save', content: 'declared save body' };

async function savedSessionId(
  context: RequestContext,
  extra: { sessionId?: string } = {},
): Promise<unknown> {
  const { isError, payload } = await call(context, () => handlers.save({ ...SAVE, ...extra }));
  expect(isError, JSON.stringify(payload)).toBe(false);
  return column('memory', 'session_id', payload['id'] as string);
}

beforeEach(() => {
  db = createTestDb();
  seedProject(db.handle, OTHER_PROJECT_ID, 'declared-other');
  defaultProjectId = defaultProject(db.handle).id;
  const repos = createRepositories(db.handle.db);
  const projects = new ProjectsService(repos);
  memory = new MemoryService(repos, db.handle.db);
  agentSessions = new AgentSessionsService(repos, db.handle.db);
  const prompts = new PromptsService(repos, db.handle.db);
  const tokens = new TokensService(repos, db.handle.db);
  tokens.bootstrapAdmin('declared-session-test-admin-zzz');
  adminToken = db.handle.db
    .select()
    .from(tokensSchema)
    .where(eq(tokensSchema.name, 'admin'))
    .get()!;
  otherToken = tokens.create({ name: 'declared-other', scope: '*' }).token;
  const deps = {
    repos,
    logInternalError,
    agentSessions,
    memory,
    projects,
    prompts,
    doctor: () => ({
      db: { journalMode: 'wal', integrity: 'ok', sizeBytes: 0 },
      embeddings: { model: 'fake-test-embedder', backlog: 0 },
      entities: { backlog: 0 },
      consolidation: { lastRunAt: null, lastRunOps: {} },
      sessions: { active: 0 },
      review: { needsReview: 0, pendingJudgments: 0 },
      warnings: [],
    }),
  };
  handlers = {
    ...buildMemoryHandlers(deps),
    ...buildPromptHandlers(deps),
    ...buildObservabilityHandlers(deps),
    ...buildSessionHandlers(deps),
  };
});

afterEach(() => db.cleanup());

describe('an honoured declared session wins over the model', () => {
  it('memory.save attaches to the declared session, not a different explicit sessionId', async () => {
    const declared = start('host');
    const explicit = start('model');
    expect(await savedSessionId(ctx(declared.id), { sessionId: explicit.id })).toBe(declared.id);
  });

  it('memory.save ignores an explicit sessionId it would otherwise refuse', async () => {
    const declared = start('host');
    expect(await savedSessionId(ctx(declared.id), { sessionId: 'no-such-session' })).toBe(
      declared.id,
    );
  });

  it('memory.save resolves the declared session where the sole-active lookup has no answer', async () => {
    const declared = start('host');
    start('other-terminal');
    expect(await savedSessionId(ctx())).toBeNull();
    expect(await savedSessionId(ctx(declared.id))).toBe(declared.id);
  });

  it('memory.session_summary writes the declared session, not a different explicit one', async () => {
    const declared = start('host');
    const explicit = start('model');
    const { isError, payload } = await call(ctx(declared.id), () =>
      handlers.sessionSummary({ sessionId: explicit.id, summary: 'declared summary' }),
    );
    expect(isError).toBe(false);
    expect(payload['sessionId']).toBe(declared.id);
    expect(column('sessions', 'summary', declared.id)).toBe('declared summary');
    expect(column('sessions', 'summary', explicit.id)).toBeNull();
  });

  it('memory.session_summary without sessionId under ambiguity resolves the declared session', async () => {
    const declared = start('host');
    start('other-terminal');
    const { isError, payload } = await call(ctx(declared.id), () =>
      handlers.sessionSummary({ summary: 'declared summary' }),
    );
    expect(isError).toBe(false);
    expect(payload['sessionId']).toBe(declared.id);
  });

  it('memory.session_end ends the declared session, not a different explicit one', async () => {
    const declared = start('host');
    const explicit = start('model');
    const { payload } = await call(ctx(declared.id), () =>
      handlers.sessionEnd({ sessionId: explicit.id }),
    );
    expect(payload).toMatchObject({ sessionId: declared.id, applied: true });
    expect(column('sessions', 'status', declared.id)).toBe('ended');
    expect(column('sessions', 'status', explicit.id)).toBe('active');
  });

  it('memory.confirm records the declared session on the confirmation', async () => {
    const declared = start('host');
    const explicit = start('model');
    const target = memory.save(
      { type: 'project', title: 'to confirm', content: 'to confirm' },
      projectScope(defaultProjectId),
    );
    const { isError } = await call(ctx(declared.id), () =>
      handlers.confirm({ ids: [target.id], sessionId: explicit.id }),
    );
    expect(isError).toBe(false);
    const row = db.handle.raw
      .prepare('SELECT session_id AS v FROM confirmations WHERE memory_id = ?')
      .get(target.id) as { v: string | null };
    expect(row.v).toBe(declared.id);
  });

  it('memory.merge attaches the merged memory to the declared session', async () => {
    const declared = start('host');
    const explicit = start('model');
    const scope = projectScope(defaultProjectId);
    const ids = [
      memory.save({ type: 'project', title: 'merge one', content: 'merge one body' }, scope).id,
      memory.save({ type: 'project', title: 'merge two', content: 'merge two body' }, scope).id,
    ];
    const args = { ids, type: 'project' as const, title: 'merged', content: 'merged', tags: ['m'] };
    const preview = await call(ctx(declared.id), () => handlers.merge(args));
    const { isError, payload } = await call(ctx(declared.id), () =>
      handlers.merge({
        ...args,
        sessionId: explicit.id,
        fingerprint: preview.payload['fingerprint'] as string,
      }),
    );
    expect(isError, JSON.stringify(payload)).toBe(false);
    expect(column('memory', 'session_id', payload['id'] as string)).toBe(declared.id);
  });

  it('memory.save_prompt attaches the prompt to the declared session', async () => {
    const declared = start('host');
    const explicit = start('model');
    const { isError, payload } = await call(ctx(declared.id), () =>
      handlers.savePrompt({ content: 'a prompt', title: 'p', sessionId: explicit.id }),
    );
    expect(isError).toBe(false);
    expect(column('prompts', 'session_id', payload['id'] as string)).toBe(declared.id);
  });

  it('memory.capture_passive attaches captured learnings to the declared session', async () => {
    const declared = start('host');
    const explicit = start('model');
    const { payload } = await call(ctx(declared.id), () =>
      handlers.capturePassive({
        text: '## Key Learnings:\n\n1. the declared session owns passive captures too',
        sessionId: explicit.id,
      }),
    );
    const ids = payload['ids'] as string[];
    expect(ids).toHaveLength(1);
    expect(column('memory', 'session_id', ids[0]!)).toBe(declared.id);
  });

  it('memory.context seeds its focus from the declared session title', async () => {
    const scope = projectScope(defaultProjectId);
    const answer = memory.save(
      { type: 'project', title: 'Zephyrquartz rollout', content: 'zephyrquartz rollout steps' },
      scope,
    );
    for (let i = 0; i < 6; i += 1) {
      memory.save({ type: 'project', title: `Ledger ${i}`, content: `ledger entry ${i}` }, scope);
    }
    const declared = start('host');
    start('other-terminal');
    agentSessions.writeSummary(declared.id, {
      tokenId: adminToken.id,
      summary: 's',
      title: 'zephyrquartz rollout',
      final: true,
    });
    const relevant = async (context: RequestContext) =>
      (
        (await call(context, () => handlers.context({}))).payload['relevantMemories'] as {
          id: string;
        }[]
      ).map((m) => m.id);
    expect(await relevant(ctx())).not.toContain(answer.id);
    expect(await relevant(ctx(declared.id))).toContain(answer.id);
  });

  it('memory.session_start adopts the declared session and reports reused', async () => {
    const declared = start('claude-code');
    start('other-terminal');
    const before = sessionCount();
    const { payload } = await call(ctx(declared.id), () => handlers.sessionStart({ agent: 'pi' }));
    expect(payload).toMatchObject({ sessionId: declared.id, reused: true, agent: 'claude-code' });
    expect(sessionCount()).toBe(before);
  });

  it('memory.session_resume keeps its explicit sessionId over the declaration', async () => {
    const declared = start('host');
    const ended = start('resumed');
    agentSessions.end(ended.id, { tokenId: adminToken.id });
    const { payload } = await call(ctx(declared.id), () =>
      handlers.sessionResume({ sessionId: ended.id }),
    );
    expect(payload).toMatchObject({ sessionId: ended.id, previousStatus: 'ended' });
    expect(column('sessions', 'status', ended.id)).toBe('active');
  });
});

describe('a declaration the server does not honour is ignored as if absent', () => {
  const unhonoured: [string, () => string][] = [
    ['owned by another token', () => start('foreign', otherToken.id).id],
    ['in another project', () => start('elsewhere', adminToken.id, OTHER_PROJECT_ID).id],
    [
      'ended',
      () => {
        const s = start('ended');
        agentSessions.end(s.id, { tokenId: adminToken.id });
        return s.id;
      },
    ],
    [
      'abandoned',
      () => {
        const s = start('abandoned');
        db.handle.raw
          .prepare("UPDATE sessions SET status = 'abandoned', ended_at = ? WHERE id = ?")
          .run(Date.now(), s.id);
        return s.id;
      },
    ],
    [
      'soft-deleted',
      () => {
        const s = start('deleted');
        agentSessions.softDelete(s.id, { adminBypass: true });
        return s.id;
      },
    ],
    ['unknown', () => 'unknown-session-id'],
  ];

  it.each(unhonoured)(
    'memory.save falls back to the sole active session when %s',
    async (_, make) => {
      const sole = start('sole');
      const declared = make();
      expect(await savedSessionId(ctx(declared))).toBe(sole.id);
    },
  );

  it.each(unhonoured)(
    'memory.session_summary falls back to the explicit sessionId when %s',
    async (_, make) => {
      const explicit = start('explicit');
      start('other-terminal');
      const declared = make();
      const { payload } = await call(ctx(declared), () =>
        handlers.sessionSummary({ sessionId: explicit.id, summary: 'fallback summary' }),
      );
      expect(payload['sessionId']).toBe(explicit.id);
      expect(column('sessions', 'summary', explicit.id)).toBe('fallback summary');
    },
  );

  it.each(unhonoured)(
    'memory.session_start mints when %s and nothing is active',
    async (_, make) => {
      const declared = make();
      const before = sessionCount();
      const { payload } = await call(ctx(declared), () => handlers.sessionStart({ agent: 'pi' }));
      expect(payload).toMatchObject({ reused: false, agent: 'pi' });
      expect(payload['sessionId']).not.toBe(declared);
      expect(sessionCount()).toBe(before + 1);
    },
  );

  it('an unhonoured declaration still lets the explicit sessionId be ownership-checked', async () => {
    const foreign = start('foreign', otherToken.id);
    const { isError, payload } = await call(ctx('unknown-session-id'), () =>
      handlers.save({ ...SAVE, sessionId: foreign.id }),
    );
    expect(isError).toBe(true);
    expect(payload['code']).toBe('session_not_found');
  });
});

describe('without a declaration, resolution is unchanged', () => {
  it('memory.save uses the explicit sessionId, then the sole active session', async () => {
    const first = start('first');
    expect(await savedSessionId(ctx())).toBe(first.id);
    const second = start('second');
    expect(await savedSessionId(ctx(), { sessionId: first.id })).toBe(first.id);
    expect(await savedSessionId(ctx(), { sessionId: second.id })).toBe(second.id);
    expect(await savedSessionId(ctx())).toBeNull();
  });

  it('memory.session_summary under ambiguity is still refused as session_ambiguous', async () => {
    start('a');
    start('b');
    const { isError, payload } = await call(ctx(), () => handlers.sessionSummary({ summary: 's' }));
    expect(isError).toBe(true);
    expect(payload['code']).toBe('session_ambiguous');
  });

  it('memory.save_prompt refuses a foreign explicit sessionId', async () => {
    const foreign = start('foreign', otherToken.id);
    const { isError, payload } = await call(ctx(), () =>
      handlers.savePrompt({ content: 'a prompt', title: 'p', sessionId: foreign.id }),
    );
    expect(isError).toBe(true);
    expect(payload['code']).toBe('session_not_found');
  });
});
