import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import type { Project } from '../db/schema/projects.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { SCOPE_GLOBAL, projectScope } from '../services/scope.js';
import type { TokenScope } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { buildMemoryHandlers } from './memory-tools.js';

/**
 * Strict path-scoping contract — see src/services/memory.ts and
 * src/services/scope.ts for the application-level RLS pattern this
 * encodes.
 */

let db: TestDb;
let projects: ProjectsService;
let memory: MemoryService;
let handlers: ReturnType<typeof buildMemoryHandlers>;
let projectA: Project;
let projectB: Project;

const ADMIN_TOKEN_SCOPE: TokenScope = '*';

function fakeContext(project: Project | null): RequestContext {
  const token: Token = {
    id: 'tk_test',
    name: 'test-token',
    hash: 'hash',
    scope: ADMIN_TOKEN_SCOPE,
    projectId: null,
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
  };
  return {
    token,
    scope: ADMIN_TOKEN_SCOPE,
    project,
    requestedSlug: project?.slug ?? null,
    mcpSessionId: null,
  };
}

interface McpTextResponse {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

function parseText<T = unknown>(resp: unknown): T {
  const r = resp as McpTextResponse;
  const text = r.content[0]?.text ?? '';
  return JSON.parse(text) as T;
}

function isErrorResponse(resp: unknown): boolean {
  return (resp as McpTextResponse).isError === true;
}

beforeEach(() => {
  db = createTestDb();
  projects = new ProjectsService(createRepositories(db.handle.db));
  memory = new MemoryService(createRepositories(db.handle.db), db.handle.db);
  handlers = buildMemoryHandlers({ memory });
  projectA = projects.create({ slug: 'test-rembric' });
  projectB = projects.create({ slug: 'other-project' });
});

afterEach(() => {
  db.cleanup();
});

describe('memory.save — strict path scoping', () => {
  it("rejects scope='global' on a path-scoped connection with code 'scope_locked'", async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        handlers.save({
          scope: 'global',
          type: 'user',
          title: 'developer of full-stack',
          content: 'developer of full-stack',
        }),
      ),
    );
    expect(isErrorResponse(r)).toBe(true);
    const payload = parseText<{ code: string; message: string }>(r);
    expect(payload.code).toBe('scope_locked');
    expect(payload.message).toContain('test-rembric');
  });

  it("rejects scope='project' on an unscoped connection with code 'project_required'", async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(handlers.save({ scope: 'project', type: 'user', title: 'x', content: 'x' })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('project_required');
  });

  it('saves under the bound project regardless of the input scope', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        handlers.save({
          scope: 'project',
          type: 'user',
          title: 'prefers pnpm',
          content: 'prefers pnpm',
          tags: [],
        }),
      ),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.scope).toBe('project');
    expect(persisted?.projectId).toBe(projectA.id);
  });

  it('on unscoped connections still saves globals normally', async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(
        handlers.save({ scope: 'global', type: 'user', title: 'dark mode', content: 'dark mode' }),
      ),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.scope).toBe('global');
    expect(persisted?.projectId).toBeNull();
  });

  it('rejects an empty title with code invalid_input', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        handlers.save({ scope: 'project', type: 'user', title: '', content: 'has content' }),
      ),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('invalid_input');
  });
});

describe('memory.title — read payloads expose the saved title', () => {
  it('memory.search returns rows whose title equals what was saved', async () => {
    memory.save(
      { type: 'user', title: 'pnpm is the package manager', content: 'we use pnpm here' },
      projectScope(projectA.id),
    );
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.search({})),
    );
    const { memories } = parseText<{ memories: { title: string; content: string }[] }>(r);
    const row = memories.find((m) => m.content === 'we use pnpm here');
    expect(row?.title).toBe('pnpm is the package manager');
  });

  it('memory.get returns memory.title and head.title for a saved memory', async () => {
    const saved = memory.save(
      { type: 'user', title: 'prefers dark mode', content: 'always dark theme' },
      projectScope(projectA.id),
    );
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.get({ id: saved.id })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const payload = parseText<{ memory: { title: string }; head: { title: string } }>(r);
    expect(payload.memory.title).toBe('prefers dark mode');
    expect(payload.head.title).toBe('prefers dark mode');
  });
});

describe('memory.search — strict path scoping', () => {
  beforeEach(() => {
    memory.save(
      { type: 'user', title: 'global preference one', content: 'global preference one' },
      SCOPE_GLOBAL,
    );
    memory.save(
      { type: 'user', title: 'project-A specific', content: 'project-A specific' },
      projectScope(projectA.id),
    );
    memory.save(
      { type: 'user', title: 'project-B specific', content: 'project-B specific' },
      projectScope(projectB.id),
    );
  });

  it('path-scoped: returns only memories in the bound project — no globals leak', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.search({})),
    );
    const { memories } = parseText<{ memories: { scope: string; projectId: string | null }[] }>(r);
    expect(memories.every((m) => m.scope === 'project' && m.projectId === projectA.id)).toBe(true);
    expect(memories.some((m) => m.scope === 'global')).toBe(false);
  });

  it('path-scoped: never returns memories of a sibling project', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.search({})),
    );
    const { memories } = parseText<{ memories: { projectId: string | null }[] }>(r);
    expect(memories.every((m) => m.projectId === projectA.id)).toBe(true);
  });

  it('unscoped: returns globals only', async () => {
    const r = await runWithContext(fakeContext(null), () => Promise.resolve(handlers.search({})));
    const { memories } = parseText<{ memories: { scope: string }[] }>(r);
    expect(memories.length).toBeGreaterThan(0);
    expect(memories.every((m) => m.scope === 'global')).toBe(true);
  });
});

describe('memory.get / memory.confirm — strict path scoping', () => {
  let globalId: string;
  let projectAId: string;
  let projectBId: string;

  beforeEach(() => {
    globalId = memory.save({ type: 'user', title: 'global', content: 'global' }, SCOPE_GLOBAL).id;
    projectAId = memory.save(
      { type: 'user', title: 'A', content: 'A' },
      projectScope(projectA.id),
    ).id;
    projectBId = memory.save(
      { type: 'user', title: 'B', content: 'B' },
      projectScope(projectB.id),
    ).id;
  });

  it('path-scoped: get(global id) → not_found', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.get({ id: globalId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('not_found');
  });

  it('path-scoped: get(other-project id) → not_found', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.get({ id: projectBId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('not_found');
  });

  it('path-scoped: get(own-project id) → ok', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.get({ id: projectAId })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const payload = parseText<{ memory: { id: string } }>(r);
    expect(payload.memory.id).toBe(projectAId);
  });

  it('unscoped /mcp: get(project id) → not_found  (the previously-leaky path is now closed)', async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(handlers.get({ id: projectAId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('not_found');
  });

  it('unscoped /mcp: get(global id) → ok', async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(handlers.get({ id: globalId })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
  });

  it('path-scoped: confirm(global id) → not_found', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.confirm({ id: globalId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('not_found');
  });

  it('path-scoped: confirm(other-project id) → not_found', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.confirm({ id: projectBId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('not_found');
  });

  it('unscoped /mcp: confirm(project id) → not_found  (was leaky, now closed)', async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(handlers.confirm({ id: projectAId })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('not_found');
  });

  it('path-scoped: confirm(own-project id) → ok', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.confirm({ id: projectAId })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
  });
});

describe('memory.* — router-activated project on an unscoped /mcp connection', () => {
  // Reproduces the bug where calling `project.use({slug})` on a path-less
  // /mcp connection correctly updates the SessionRouter and is reported by
  // `project.current`, yet subsequent `memory.save({scope:'project'})`
  // calls still returned `project_required` because the memory handlers
  // only consulted `ctx.project` (URL-derived) and never the router.

  const MCP_SESSION = 'mcp-sess-1';

  function unscopedContextWithSession(): RequestContext {
    const token: Token = {
      id: 'tk_test',
      name: 'test-token',
      hash: 'hash',
      scope: ADMIN_TOKEN_SCOPE,
      projectId: null,
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: null,
    };
    return {
      token,
      scope: ADMIN_TOKEN_SCOPE,
      project: null,
      requestedSlug: null,
      mcpSessionId: MCP_SESSION,
    };
  }

  let router: SessionRouter;
  let routerHandlers: ReturnType<typeof buildMemoryHandlers>;

  beforeEach(() => {
    router = new SessionRouter();
    routerHandlers = buildMemoryHandlers({ memory, router, projects });
  });

  it('memory.save({scope:project}) succeeds after project.use activates a project', async () => {
    router.setActiveProject('tk_test', MCP_SESSION, projectA.id, 'tool-explicit');
    const r = await runWithContext(unscopedContextWithSession(), () =>
      Promise.resolve(
        routerHandlers.save({
          scope: 'project',
          type: 'user',
          title: 'router-activated save',
          content: 'router-activated save',
        }),
      ),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.scope).toBe('project');
    expect(persisted?.projectId).toBe(projectA.id);
  });

  it('memory.save without router activation still returns project_required', async () => {
    const r = await runWithContext(unscopedContextWithSession(), () =>
      Promise.resolve(
        routerHandlers.save({
          scope: 'project',
          type: 'user',
          title: 'no project',
          content: 'no project',
        }),
      ),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('project_required');
  });

  it('memory.search returns the router-activated project memories, not globals', async () => {
    memory.save({ type: 'user', title: 'global only', content: 'global only' }, SCOPE_GLOBAL);
    const saved = memory.save(
      { type: 'user', title: 'in project A', content: 'in project A' },
      projectScope(projectA.id),
    );
    router.setActiveProject('tk_test', MCP_SESSION, projectA.id, 'tool-explicit');
    const r = await runWithContext(unscopedContextWithSession(), () =>
      Promise.resolve(routerHandlers.search({})),
    );
    const { memories } = parseText<{
      memories: { id: string; scope: string; projectId: string | null }[];
    }>(r);
    expect(memories.some((m) => m.id === saved.id)).toBe(true);
    expect(memories.every((m) => m.scope === 'project' && m.projectId === projectA.id)).toBe(true);
  });

  it('memory.get on a project id resolves once the router has activated that project', async () => {
    const saved = memory.save(
      { type: 'user', title: 'gettable', content: 'gettable' },
      projectScope(projectA.id),
    );
    router.setActiveProject('tk_test', MCP_SESSION, projectA.id, 'tool-explicit');
    const r = await runWithContext(unscopedContextWithSession(), () =>
      Promise.resolve(routerHandlers.get({ id: saved.id })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const payload = parseText<{ memory: { id: string } }>(r);
    expect(payload.memory.id).toBe(saved.id);
  });
});

describe('memory.save — eager roots discovery race (option B fix)', () => {
  // Reproduces the bug where the very first scope-aware call on a fresh
  // transport (e.g. `memory.save({scope:'project'})`) returned
  // `project_required` because roots discovery had not run yet — it was
  // only wired into `project.current` / `memory.session_start`. The fix:
  // `createMcpServer` fires discovery eagerly from `oninitialized` and
  // stashes the in-flight Promise on the router so any tool handler
  // that resolves project scope awaits the same promise (single-flight)
  // instead of falling through to `project_required`.

  const MCP_SESSION = 'mcp-sess-eager';

  function unscopedContextWithSession(): RequestContext {
    const token: Token = {
      id: 'tk_test',
      name: 'test-token',
      hash: 'hash',
      scope: ADMIN_TOKEN_SCOPE,
      projectId: null,
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: null,
    };
    return {
      token,
      scope: ADMIN_TOKEN_SCOPE,
      project: null,
      requestedSlug: null,
      mcpSessionId: MCP_SESSION,
    };
  }

  // Minimal stand-in for the McpServer that the handler's `getServer`
  // factory returns. `resolveEffectiveProject` only forwards it to
  // `ensureRootsDiscoveryRun`, which short-circuits when there is an
  // in-flight promise on the router — so the stub is never dereferenced.
  const fakeServer = {} as unknown as Parameters<
    typeof buildMemoryHandlers
  >[0]['getServer'] extends (() => infer S) | undefined
    ? S
    : never;

  let router: SessionRouter;
  let routerHandlers: ReturnType<typeof buildMemoryHandlers>;

  beforeEach(() => {
    router = new SessionRouter();
    routerHandlers = buildMemoryHandlers({
      memory,
      router,
      projects,
      getServer: () => fakeServer,
    });
  });

  it('memory.save awaits an in-flight discovery promise and resolves the activated project', async () => {
    // Simulate the state created by `server.oninitialized`: discovery
    // is in flight; its resolution will activate `projectA` on this
    // transport (mirrors what `maybeDiscoverViaRoots`'s
    // `applyDerivedSlug` does once `listRoots` returns).
    let resolveDiscovery: () => void = () => undefined;
    const discoveryPromise = new Promise<void>((resolve) => {
      resolveDiscovery = resolve;
    }).then(() => {
      router.setActiveProject('tk_test', MCP_SESSION, projectA.id, 'roots');
    });
    router.setDiscoveryPromise('tk_test', MCP_SESSION, discoveryPromise);

    // Kick off the save BEFORE discovery settles. With the fix in place
    // the save awaits the in-flight promise; without it the save would
    // return `project_required` immediately.
    const pending = runWithContext(unscopedContextWithSession(), async () =>
      routerHandlers.save({
        scope: 'project',
        type: 'project',
        title: 'eager-discovery save',
        content: 'eager-discovery save',
      }),
    );
    resolveDiscovery();
    const r = await pending;

    expect(isErrorResponse(r)).toBeFalsy();
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.scope).toBe('project');
    expect(persisted?.projectId).toBe(projectA.id);
  });

  it('memory.search awaits the same in-flight discovery promise', async () => {
    const saved = memory.save(
      {
        type: 'user',
        title: 'visible only with project scope',
        content: 'visible only with project scope',
      },
      projectScope(projectA.id),
    );

    let resolveDiscovery: () => void = () => undefined;
    const discoveryPromise = new Promise<void>((resolve) => {
      resolveDiscovery = resolve;
    }).then(() => {
      router.setActiveProject('tk_test', MCP_SESSION, projectA.id, 'roots');
    });
    router.setDiscoveryPromise('tk_test', MCP_SESSION, discoveryPromise);

    const pending = runWithContext(unscopedContextWithSession(), async () =>
      routerHandlers.search({}),
    );
    resolveDiscovery();
    const r = await pending;

    const { memories } = parseText<{ memories: { id: string; projectId: string | null }[] }>(r);
    expect(memories.some((m) => m.id === saved.id)).toBe(true);
    expect(memories.every((m) => m.projectId === projectA.id)).toBe(true);
  });
});

describe('memory.save — session attachment via HTTP-created sessions', () => {
  // Verifies the bridge that makes `POST /api/<slug>/sessions` (hook) and
  // subsequent `memory.save` (MCP) cohere: when no SessionRouter entry
  // exists, the save attaches to the most-recently-active session for
  // `(tokenId, projectId)`.

  let agentSessions: AgentSessionsService;
  let fallbackHandlers: ReturnType<typeof buildMemoryHandlers>;
  let realTokenId: string;
  let ctxWithRealToken: (project: Project | null) => RequestContext;

  beforeEach(async () => {
    const { AgentSessionsService } = await import('../services/agent-sessions.js');
    const { TokensService } = await import('../services/tokens.js');
    const { tokens: tokensSchema } = await import('../db/schema/tokens.js');
    const { eq } = await import('drizzle-orm');

    agentSessions = new AgentSessionsService(createRepositories(db.handle.db), db.handle.db);
    const tokens = new TokensService(createRepositories(db.handle.db));
    tokens.bootstrapAdmin('attachment-test-token-with-enough-entropy');
    const admin = db.handle.db
      .select()
      .from(tokensSchema)
      .where(eq(tokensSchema.name, 'admin'))
      .get();
    realTokenId = admin!.id;
    ctxWithRealToken = (project) => ({
      ...fakeContext(project),
      token: { ...fakeContext(project).token, id: realTokenId },
    });
    fallbackHandlers = buildMemoryHandlers({ memory, projects, agentSessions });
  });

  it('attaches a memory to the session created via agentSessions.ensure', async () => {
    agentSessions.ensure({
      id: 'sess-http-created-1',
      tokenId: realTokenId,
      projectId: projectA.id,
      agent: 'plugin-hook',
    });

    const r = await runWithContext(ctxWithRealToken(projectA), () =>
      fallbackHandlers.save({
        scope: 'project',
        type: 'project',
        title: 'memory saved after HTTP session create',
        content: 'memory saved after HTTP session create',
      }),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.sessionId).toBe('sess-http-created-1');
  });

  it('attaches to the MOST recent active session when multiple exist', async () => {
    agentSessions.ensure({
      id: 'sess-older',
      tokenId: realTokenId,
      projectId: projectA.id,
      agent: 'older',
    });
    // Force a later started_at by waiting a tick (clock granularity is ms).
    await new Promise((res) => setTimeout(res, 5));
    agentSessions.ensure({
      id: 'sess-newer',
      tokenId: realTokenId,
      projectId: projectA.id,
      agent: 'newer',
    });

    const r = await runWithContext(ctxWithRealToken(projectA), () =>
      fallbackHandlers.save({
        scope: 'project',
        type: 'project',
        title: 'attaches to newer',
        content: 'attaches to newer',
      }),
    );
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.sessionId).toBe('sess-newer');
  });

  it('saves with session_id=null when no active session exists', async () => {
    const r = await runWithContext(ctxWithRealToken(projectA), () =>
      fallbackHandlers.save({
        scope: 'project',
        type: 'project',
        title: 'no session active',
        content: 'no session active',
      }),
    );
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.sessionId).toBeNull();
  });

  it('SessionRouter entry takes precedence over the DB fallback', async () => {
    const router = new SessionRouter();
    const MCP_SESSION = 'mcp-sess-precedence';
    // DB has a session for the (token, project).
    agentSessions.ensure({
      id: 'sess-db-fallback',
      tokenId: realTokenId,
      projectId: projectA.id,
      agent: 'db',
    });
    // Router explicitly points at a different session.
    agentSessions.ensure({
      id: 'sess-router-explicit',
      tokenId: realTokenId,
      projectId: projectA.id,
      agent: 'router',
    });
    router.setActiveSession(realTokenId, MCP_SESSION, 'sess-router-explicit');

    const handlersWithRouter = buildMemoryHandlers({ memory, projects, agentSessions, router });
    const ctxWithSession: RequestContext = {
      ...ctxWithRealToken(projectA),
      mcpSessionId: MCP_SESSION,
    };
    const r = await runWithContext(ctxWithSession, () =>
      handlersWithRouter.save({
        scope: 'project',
        type: 'project',
        title: 'router precedence',
        content: 'router precedence',
      }),
    );
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.sessionId).toBe('sess-router-explicit');
  });
});
