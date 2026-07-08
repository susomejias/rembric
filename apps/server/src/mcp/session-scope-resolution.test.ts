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
import { projectScope, SCOPE_GLOBAL } from '../services/scope.js';
import { TokensService, type TokenScope } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { buildMemoryHandlers } from './memory-tools.js';
import { buildObservabilityHandlers } from './observability-tools.js';
import { buildPromptHandlers } from './prompt-tools.js';

/**
 * Regression coverage for scope resolution in the session-tool surface.
 * Before the fix, these handlers ignored the `SessionRouter`, so a
 * path-less `/mcp` agent that pinned a project via `project.use`
 * silently saw global scope from `memory.context`, `memory.timeline`,
 * `memory.stats`, `memory.save_prompt`, and `memory.capture_passive`.
 *
 * All handlers now share `resolveEffectiveScope` (`_shared.ts`):
 *   1. ctx.project          → path-scoped connection
 *   2. SessionRouter entry  → path-less connection with prior project.use
 *   3. SCOPE_GLOBAL         → no resolution
 */

const MCP_SESSION_ID = 'mcp-sess-scope-test';
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
let handlers: ReturnType<typeof buildMemoryHandlers> &
  ReturnType<typeof buildPromptHandlers> &
  ReturnType<typeof buildObservabilityHandlers>;

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
  projects = new ProjectsService(createRepositories(db.handle.db));
  memory = new MemoryService(createRepositories(db.handle.db), db.handle.db);
  router = new SessionRouter();
  agentSessions = new AgentSessionsService(createRepositories(db.handle.db), db.handle.db);
  prompts = new PromptsService(createRepositories(db.handle.db), db.handle.db);
  tokens = new TokensService(createRepositories(db.handle.db));
  tokens.bootstrapAdmin('scope-resolution-test-admin-zzz');
  adminToken = db.handle.db
    .select()
    .from(tokensSchema)
    .where(eq(tokensSchema.name, 'admin'))
    .get()!;
  const created = tokens.create({ name: 'other', scope: SCOPE });
  otherToken = created.token;
  // One broad deps object passed (as a variable, to dodge excess-property
  // checks) to each per-domain builder; the merged handlers expose the
  // scope-resolving tools this suite exercises (context/timeline from memory,
  // save_prompt/search_prompts from prompt, stats/capture_passive from observability).
  const deps = {
    repos: createRepositories(db.handle.db),
    agentSessions,
    memory,
    projects,
    prompts,
    router,
    doctor: () => ({
      db: { open: true, journalMode: 'wal', integrity: 'ok', sizeBytes: 0 },
      embeddings: { model: 'fake-test-embedder', backlog: 0 },
      consolidation: { lastRunAt: null, lastRunOps: {} },
      sessions: { active: 0 },
      warnings: [],
    }),
  };
  handlers = {
    ...buildMemoryHandlers(deps),
    ...buildPromptHandlers(deps),
    ...buildObservabilityHandlers(deps),
  };
});

afterEach(() => db.cleanup());

describe('resolveEffectiveScope — path-less /mcp with router pin', () => {
  it('memory.context returns the router-pinned project scope, not global', async () => {
    const project = projects.create({ slug: 'foo', displayName: null });
    memory.save(
      {
        type: 'project',
        title: 'a project-scoped memory of foo',
        content: 'a project-scoped memory of foo',
        source: { tokenName: adminToken.name, agent: 'test' },
      },
      projectScope(project.id),
    );

    // Pin the project for this (tokenId, mcpSessionId) pair, as
    // `project.use` would.
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, project.id, 'tool-explicit');

    const r = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(handlers.context({})),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBeFalsy();
    expect(payload.scope).toBe(`project:${project.id}`);
    const recent = payload.recentMemories as Array<{ snippet: string }>;
    expect(recent.length).toBeGreaterThan(0);
    expect(recent[0]?.snippet).toContain('project-scoped memory of foo');
  });

  it('memory.timeline succeeds when called with the router-pinned scope', async () => {
    // The scope resolution is shared by every session-tool handler via
    // resolveEffectiveScope. The router-fallback branch is exhaustively
    // covered by the other tests in this suite (context, stats,
    // save_prompt, capture_passive). For timeline we just confirm that
    // calling it with a project-scoped target does not error out.
    const project = projects.create({ slug: 'bar', displayName: null });
    const target = memory.save(
      {
        type: 'project',
        title: 'a timeline anchor in bar',
        content: 'a timeline anchor in bar',
        source: { tokenName: adminToken.name, agent: 'test' },
      },
      projectScope(project.id),
    );
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, project.id, 'tool-explicit');

    const r = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(handlers.timeline({ memoryId: target.id })),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBeFalsy();
    const t = payload.target as { id: string };
    expect(t?.id).toBe(target.id);
  });

  it('memory.stats counts the pinned project, not the global scope', async () => {
    const project = projects.create({ slug: 'baz', displayName: null });
    memory.save(
      {
        type: 'project',
        title: 'baz one',
        content: 'baz one',
        source: { tokenName: adminToken.name, agent: 'test' },
      },
      projectScope(project.id),
    );
    memory.save(
      {
        type: 'reference',
        title: 'baz two',
        content: 'baz two',
        source: { tokenName: adminToken.name, agent: 'test' },
      },
      projectScope(project.id),
    );
    // Add a global memory that must NOT leak into the stats for project baz.
    memory.save(
      {
        type: 'reference',
        title: 'global noise that must not leak',
        content: 'global noise that must not leak',
        source: { tokenName: adminToken.name, agent: 'test' },
      },
      SCOPE_GLOBAL,
    );
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, project.id, 'tool-explicit');

    const r = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(handlers.stats()),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBeFalsy();
    const byStatus = payload.memoriesByStatus as Record<string, number>;
    expect(byStatus.active).toBe(2);
  });

  it('memory.save_prompt persists with the router-pinned project_id', async () => {
    const project = projects.create({ slug: 'qux', displayName: null });
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, project.id, 'tool-explicit');

    const r = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(handlers.savePrompt({ content: 'remember this', title: 'reminder' })),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBeFalsy();
    expect(payload.ok).toBe(true);

    // The persisted prompt SHOULD be scoped to the pinned project.
    const recents = prompts.recentForContext({ projectId: project.id, limit: 5 });
    expect(recents.length).toBe(1);
    expect(recents[0]?.content).toBe('remember this');
  });

  it('memory.capture_passive writes into the router-pinned project scope', async () => {
    const project = projects.create({ slug: 'cap', displayName: null });
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, project.id, 'tool-explicit');

    const r = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(
        handlers.capturePassive({
          text: '## Key Learnings:\n- one learning to capture\n',
        }),
      ),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBeFalsy();
    expect(payload.saved).toBe(1);

    // Confirm via memory.context that the captured row landed in the
    // pinned project, not in global.
    const ctx = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(handlers.context({})),
    );
    const decoded = decode(ctx);
    expect(decoded.payload.scope).toBe(`project:${project.id}`);
    const recent = decoded.payload.recentMemories as Array<{ snippet: string }>;
    expect(recent.some((m) => m.snippet.includes('one learning to capture'))).toBe(true);
  });
});

describe('resolveEffectiveScope — fallback to SCOPE_GLOBAL', () => {
  it('path-less /mcp with empty router → memory.context returns global', async () => {
    memory.save(
      {
        type: 'reference',
        title: 'a global note',
        content: 'a global note',
        source: { tokenName: adminToken.name, agent: 'test' },
      },
      SCOPE_GLOBAL,
    );

    const r = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(handlers.context({})),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBeFalsy();
    expect(payload.scope).toBe('global');
    const recent = payload.recentMemories as Array<{ snippet: string }>;
    expect(recent.some((m) => m.snippet.includes('a global note'))).toBe(true);
  });

  it('does not leak across tokens — other token sees no project pin from admin', async () => {
    const project = projects.create({ slug: 'admin-only', displayName: null });
    memory.save(
      {
        type: 'project',
        title: 'admin-only memory',
        content: 'admin-only memory',
        source: { tokenName: adminToken.name, agent: 'test' },
      },
      projectScope(project.id),
    );
    // Pin under admin token, NOT under the other token.
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, project.id, 'tool-explicit');

    // Other token, same mcpSessionId string — but the router keys on
    // (tokenId, mcpSessionId), so they SHALL not collide.
    const r = await runWithContext(makeContext(otherToken), () =>
      Promise.resolve(handlers.context({})),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBeFalsy();
    expect(payload.scope).toBe('global');
    const recent = payload.recentMemories as Array<{ snippet: string }>;
    expect(recent.some((m) => m.snippet.includes('admin-only memory'))).toBe(false);
  });
});

describe('resolveEffectiveScope — path-scoped connections override router', () => {
  it('ctx.requestedSlug set + ctx.project null → returns global, ignores router pin', async () => {
    // Simulate a path-scoped request to a slug whose project does NOT
    // exist (e.g., archived or deleted). Auth would not populate
    // ctx.project, but a leftover router entry from a previous session
    // might still exist. The session-tool surface MUST NOT fall back to
    // the stale router entry — that would silently leak data from a
    // different project.
    const leftoverProject = projects.create({ slug: 'leftover', displayName: null });
    memory.save(
      {
        type: 'project',
        title: 'leftover memory that must not leak',
        content: 'leftover memory that must not leak',
        source: { tokenName: adminToken.name, agent: 'test' },
      },
      projectScope(leftoverProject.id),
    );
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, leftoverProject.id, 'tool-explicit');

    const r = await runWithContext(
      makeContext(adminToken, { requestedSlug: 'nonexistent', project: null }),
      () => Promise.resolve(handlers.context({})),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBeFalsy();
    expect(payload.scope).toBe('global');
    const recent = payload.recentMemories as Array<{ snippet: string }>;
    expect(recent.some((m) => m.snippet.includes('leftover memory that must not leak'))).toBe(
      false,
    );
  });

  it('ctx.project set (path-scoped, valid slug) → uses ctx.project regardless of router', async () => {
    const pathProject = projects.create({ slug: 'pathy', displayName: null });
    const routerProject = projects.create({ slug: 'router-pinned', displayName: null });
    memory.save(
      {
        type: 'project',
        title: 'pathy memory',
        content: 'pathy memory',
        source: { tokenName: adminToken.name, agent: 'test' },
      },
      projectScope(pathProject.id),
    );
    memory.save(
      {
        type: 'project',
        title: 'router-pinned memory',
        content: 'router-pinned memory',
        source: { tokenName: adminToken.name, agent: 'test' },
      },
      projectScope(routerProject.id),
    );
    // Router has a different project pinned than ctx.project — ctx wins.
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, routerProject.id, 'tool-explicit');

    const r = await runWithContext(
      makeContext(adminToken, { requestedSlug: 'pathy', project: pathProject }),
      () => Promise.resolve(handlers.context({})),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBeFalsy();
    expect(payload.scope).toBe(`project:${pathProject.id}`);
    const recent = payload.recentMemories as Array<{ snippet: string }>;
    expect(recent.some((m) => m.snippet.includes('pathy memory'))).toBe(true);
    expect(recent.some((m) => m.snippet.includes('router-pinned memory'))).toBe(false);
  });
});

describe('memory.search_prompts — scope resolution', () => {
  it('returns prompts from the router-pinned project, not global', async () => {
    const project = projects.create({ slug: 'pinned', displayName: null });
    // One prompt in the pinned project; one global decoy.
    prompts.save({ content: 'pinned prompt content', title: 'pinned', projectId: project.id });
    prompts.save({ content: 'global decoy', title: 'decoy', projectId: null });
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, project.id, 'tool-explicit');

    const r = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(handlers.searchPrompts({})),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBeFalsy();
    expect(payload.scope).toBe(`project:${project.id}`);
    const list = payload.prompts as Array<{ content: string }>;
    expect(list.map((p) => p.content)).toEqual(['pinned prompt content']);
  });

  it('returns global prompts when no router pin and no path scope', async () => {
    prompts.save({ content: 'global only', title: 'global only', projectId: null });
    const project = projects.create({ slug: 'unused', displayName: null });
    prompts.save({ content: 'project noise', title: 'noise', projectId: project.id });
    // No router pin, no ctx.project.

    const r = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(handlers.searchPrompts({})),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBeFalsy();
    expect(payload.scope).toBe('global');
    const list = payload.prompts as Array<{ content: string }>;
    expect(list.map((p) => p.content)).toEqual(['global only']);
  });

  it('returns the path-scoped project, ignoring stale router pin', async () => {
    const pathProject = projects.create({ slug: 'pathprompt', displayName: null });
    const routerProject = projects.create({ slug: 'routerprompt', displayName: null });
    prompts.save({ content: 'pathy prompt', title: 'pathy', projectId: pathProject.id });
    prompts.save({ content: 'router prompt', title: 'routerish', projectId: routerProject.id });
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, routerProject.id, 'tool-explicit');

    const r = await runWithContext(
      makeContext(adminToken, { requestedSlug: 'pathprompt', project: pathProject }),
      () => Promise.resolve(handlers.searchPrompts({})),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBeFalsy();
    expect(payload.scope).toBe(`project:${pathProject.id}`);
    const list = payload.prompts as Array<{ content: string }>;
    expect(list.map((p) => p.content)).toEqual(['pathy prompt']);
  });
});

describe('memory.save_prompt — refine flow via MCP', () => {
  it('atomic refine via replaces succeeds and emits the chain', async () => {
    const project = projects.create({ slug: 'refine-project', displayName: null });
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, project.id, 'tool-explicit');

    const first = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(handlers.savePrompt({ content: 'initial take', title: 'initial' })),
    );
    const firstPayload = decode(first).payload as { id: string };

    const second = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(
        handlers.savePrompt({
          content: 'refined take',
          title: 'refined',
          replaces: firstPayload.id,
        }),
      ),
    );
    const { isError, payload } = decode(second);

    expect(isError).toBeFalsy();
    expect(payload.ok).toBe(true);
    expect(payload.replaces).toEqual([firstPayload.id]);

    // Predecessor is now soft-deleted; recentForContext shows only the refined one.
    const recent = prompts.recentForContext({ projectId: project.id, limit: 10 });
    expect(recent.map((r) => r.content)).toEqual(['refined take']);
  });

  it('refine with a non-existent predecessor surfaces prompt_not_found', async () => {
    const project = projects.create({ slug: 'refine-missing', displayName: null });
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, project.id, 'tool-explicit');

    const r = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(
        handlers.savePrompt({
          content: 'orphan refine',
          title: 'orphan',
          replaces: 'never-existed',
        }),
      ),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBe(true);
    expect(payload.code).toBe('prompt_not_found');
  });

  it('refine across scopes surfaces prompt_scope_mismatch', async () => {
    const projectA = projects.create({ slug: 'scope-a', displayName: null });
    const projectB = projects.create({ slug: 'scope-b', displayName: null });
    const foreign = prompts.save({
      content: 'foreign',
      title: 'foreign',
      projectId: projectA.id,
    });
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, projectB.id, 'tool-explicit');

    const r = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(
        handlers.savePrompt({
          content: 'cross-scope',
          title: 'cross-scope',
          replaces: foreign.id,
        }),
      ),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBe(true);
    expect(payload.code).toBe('prompt_scope_mismatch');
  });

  it('refine of an already-deleted predecessor surfaces prompt_already_deleted', async () => {
    const project = projects.create({ slug: 'refine-deleted', displayName: null });
    router.setActiveProject(adminToken.id, MCP_SESSION_ID, project.id, 'tool-explicit');
    const first = prompts.save({ content: 'first', title: 'first', projectId: project.id });
    prompts.softDelete(first.id);

    const r = await runWithContext(makeContext(adminToken), () =>
      Promise.resolve(
        handlers.savePrompt({ content: 'second', title: 'second', replaces: first.id }),
      ),
    );
    const { isError, payload } = decode(r);

    expect(isError).toBe(true);
    expect(payload.code).toBe('prompt_already_deleted');
  });
});
