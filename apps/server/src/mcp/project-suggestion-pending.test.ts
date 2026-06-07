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
import { buildHandlers } from './tools.js';

/**
 * 3.6 — End-to-end handler tests for the `project_suggestion_pending`
 * gate. We bypass the HTTP transport and drive the handlers via the
 * standard `runWithContext` pattern (same as `tools.test.ts`), seeding
 * the SessionRouter with the suggestion list that roots-discovery would
 * produce in production.
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
let saveHandlers: ReturnType<typeof buildHandlers>;
let sessionHandlers: ReturnType<typeof buildSessionsHandlers>;

function makeContext(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    token: adminToken,
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
  projects = new ProjectsService(createRepositories(db.handle.db));
  memory = new MemoryService(createRepositories(db.handle.db), db.handle.db);
  router = new SessionRouter();
  agentSessions = new AgentSessionsService(createRepositories(db.handle.db), db.handle.db);
  prompts = new PromptsService(createRepositories(db.handle.db), db.handle.db);
  tokens = new TokensService(createRepositories(db.handle.db));
  tokens.bootstrapAdmin('project-suggestion-pending-test-admin-zzz');
  adminToken = db.handle.db
    .select()
    .from(tokensSchema)
    .where(eq(tokensSchema.name, 'admin'))
    .get()!;
  saveHandlers = buildHandlers({
    memory,
    repos: createRepositories(db.handle.db),
    router,
    projects,
  });
  sessionHandlers = buildSessionsHandlers({
    repos: createRepositories(db.handle.db),
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

describe('memory.save — project_suggestion_pending gate', () => {
  it('fires when scope defaults to project, no project pinned, and a suggestion is unminted', async () => {
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['acme-research']);
    const r = await runWithContext(makeContext(), () =>
      Promise.resolve(saveHandlers.save({ scope: 'project', type: 'project', content: 'x' })),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('project_suggestion_pending');
    expect(payload.suggestedSlugs).toEqual(['acme-research']);
  });

  it("does NOT fire when the agent passes scope:'global' explicitly", async () => {
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['acme-research']);
    const r = await runWithContext(makeContext(), () =>
      Promise.resolve(saveHandlers.save({ scope: 'global', type: 'project', content: 'global-x' })),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(payload.id).toMatch(/^[0-9A-Z]+$/);
  });

  it('does NOT fire when every suggested slug already exists as a project', async () => {
    projects.create({ slug: 'acme-research' });
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['acme-research']);
    const r = await runWithContext(makeContext(), () =>
      Promise.resolve(saveHandlers.save({ scope: 'project', type: 'project', content: 'x' })),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    // Falls through to project_required because no project is pinned and
    // suggestions all already resolve (gate is a no-op).
    expect(payload.code).toBe('project_required');
  });

  it('does NOT fire on path-scoped connections (path-scope short-circuits first)', async () => {
    const proj = projects.create({ slug: 'path-proj' });
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['unrelated-suggestion']);
    const r = await runWithContext(makeContext({ project: proj, requestedSlug: 'path-proj' }), () =>
      Promise.resolve(saveHandlers.save({ scope: 'project', type: 'project', content: 'x' })),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(payload.id).toMatch(/^[0-9A-Z]+$/);
  });
});

describe('memory.session_start — project_suggestion_pending gate', () => {
  it('fires when args.project is absent, no project pinned, and a suggestion is unminted', async () => {
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['acme-research']);
    const r = await runWithContext(makeContext(), () => sessionHandlers.sessionStart({}));
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('project_suggestion_pending');
    expect(payload.suggestedSlugs).toEqual(['acme-research']);
  });

  it('does NOT fire when the agent passes an explicit project arg', async () => {
    projects.create({ slug: 'explicit-proj' });
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['acme-research']);
    const r = await runWithContext(makeContext(), () =>
      sessionHandlers.sessionStart({ project: 'explicit-proj' }),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(payload.sessionId).toBeDefined();
  });

  it('does NOT fire when the suggestion already exists as a project', async () => {
    projects.create({ slug: 'acme-research' });
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['acme-research']);
    const r = await runWithContext(makeContext(), () => sessionHandlers.sessionStart({}));
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(payload.sessionId).toBeDefined();
    // The session falls through to global since no project is pinned;
    // that's the v0.5 behavior — the gate only fires for *unminted*
    // suggestions.
    expect(payload.scope).toBe('global');
  });

  it('autocreate + session_start no longer triggers the gate (suggestion now resolves)', async () => {
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['acme-research']);

    // Simulate `project.use({slug, autocreate:true})` minting the project.
    const proj = projects.create({ slug: 'acme-research' });
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, proj.id, 'tool-explicit');

    const r = await runWithContext(makeContext(), () => sessionHandlers.sessionStart({}));
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(payload.scope).toBe('project');
    expect(payload.projectId).toBe(proj.id);
  });
});
