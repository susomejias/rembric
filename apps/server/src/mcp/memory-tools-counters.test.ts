import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import type { Project } from '../db/schema/projects.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { PromptsService } from '../services/prompts.js';
import { RelationsService } from '../services/relations.js';
import type { TokenScope } from '../services/tokens.js';
import { UsageCounters } from '../services/usage-counters.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { buildMemoryHandlers } from './memory-tools.js';

/**
 * Usage counters ride the SUCCESSFUL call (proactive-entity-recall, tasks
 * 4.1/4.2/4.4): the increment lives in the `counted` composition wrapper in
 * memory-tools.ts, so the test asserts through the real handler surface —
 * MCP-result shape included — rather than against the wrapper directly.
 */

let db: TestDb;
let projects: ProjectsService;
let memory: MemoryService;
let counters: UsageCounters;
let handlers: ReturnType<typeof buildMemoryHandlers>;
let projectA: Project;

const ADMIN_TOKEN_SCOPE: TokenScope = '*';
const READ_ONLY_ADMIN_SCOPE: TokenScope = 'read:*';

function fakeContext(scope: TokenScope): RequestContext {
  const token: Token = {
    id: 'tk_counter_test',
    name: 'counter-test-token',
    hash: 'hash',
    scope,
    projectId: null,
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
  };
  return {
    token,
    scope,
    memberProjectIds: [],
    project: projectA,
    requestedSlug: projectA?.slug ?? null,
    mcpSessionId: null,
  };
}

beforeEach(() => {
  db = createTestDb();
  const repos = createRepositories(db.handle.db);
  projects = new ProjectsService(repos);
  memory = new MemoryService(repos, db.handle.db);
  counters = new UsageCounters();
  // `memory.context` reads sessions/prompts/relations, so the build mirrors
  // the full composition `createMcpServer` uses — a half-wired build would
  // make the context assertion about deps, not about counting.
  handlers = buildMemoryHandlers({
    memory,
    projects,
    repos,
    agentSessions: new AgentSessionsService(repos, db.handle.db),
    prompts: new PromptsService(repos, db.handle.db),
    relations: new RelationsService(repos, db.handle.db),
    router: new SessionRouter(),
    usageCounters: counters,
  });
  projectA = projects.create({ slug: 'counter-test' });
});

afterEach(() => {
  db.cleanup();
});

describe('usage counters increment on successful tool calls only', () => {
  it('counts search, context and save per token', async () => {
    const ctx = fakeContext(ADMIN_TOKEN_SCOPE);

    await runWithContext(ctx, () =>
      handlers.save({ type: 'user', title: 'note one', content: 'first note', tags: [] }),
    );
    expect(counters.get(ctx.token.id, 'memory.save'), 'save must count').toBe(1);

    await runWithContext(ctx, () => handlers.search({ query: 'note' }));
    await runWithContext(ctx, () => handlers.search({ query: 'note again' }));
    expect(counters.get(ctx.token.id, 'memory.search')).toBe(2);

    await runWithContext(ctx, () => handlers.context({}));
    expect(counters.get(ctx.token.id, 'memory.context')).toBe(1);

    // The debug-endpoint view, end to end.
    expect(counters.snapshot()).toEqual({
      [ctx.token.id]: { 'memory.save': 1, 'memory.search': 2, 'memory.context': 1 },
    });
  });

  it('does NOT count a call that failed (isError result)', async () => {
    // Read-only reach: the write guard inside handleSave turns this into an
    // errToMcp result, which must leave the save counter at zero.
    const ctx = fakeContext(READ_ONLY_ADMIN_SCOPE);
    const r = (await runWithContext(ctx, () =>
      handlers.save({ type: 'project', title: 'nope', content: 'denied' }),
    )) as { isError?: boolean };
    expect(r.isError).toBe(true);
    expect(counters.get(ctx.token.id, 'memory.save')).toBe(0);
    expect(counters.snapshot()).toEqual({});
  });

  it('a restart (new UsageCounters instance) starts every token at zero', async () => {
    const ctx = fakeContext(ADMIN_TOKEN_SCOPE);
    await runWithContext(ctx, () => handlers.search({ query: 'anything' }));
    expect(counters.get(ctx.token.id, 'memory.search')).toBe(1);

    // Process restart: services are reconstructed; the MCP handlers built
    // against the fresh instance must observe nothing from the old one.
    const restarted = new UsageCounters();
    const rebuilt = buildMemoryHandlers({ memory, projects, usageCounters: restarted });
    await runWithContext(ctx, () => rebuilt.search({ query: 'anything' }));
    expect(restarted.get(ctx.token.id, 'memory.search')).toBe(1);
    expect(Object.values(restarted.snapshot())[0]?.['memory.save']).toBeUndefined();
  });

  it('handlers built without counters behave exactly as before', async () => {
    const plain = buildMemoryHandlers({ memory, projects });
    const ctx = fakeContext(ADMIN_TOKEN_SCOPE);
    const r = await runWithContext(ctx, () => plain.search({ query: 'anything' }));
    expect((r as { isError?: boolean }).isError).toBeFalsy();
  });
});
