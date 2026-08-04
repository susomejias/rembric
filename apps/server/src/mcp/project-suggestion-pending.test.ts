import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { tokens as tokensSchema, type Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { TokensService, type TokenScope } from '../services/tokens.js';
import { createTestDb, defaultProject, type TestDb } from '../test/index.js';

import { buildMemoryHandlers } from './memory-tools.js';
import { buildProjectHandlers } from './project-tools.js';
import { buildSessionHandlers } from './session-tools.js';

/**
 * The `project_suggestion_pending` gate is retired: its precondition was "no
 * project is active", which a path-less connection resolving to the default
 * project can no longer satisfy. These tests pin that it stays retired — a write
 * with unminted roots suggestions pending succeeds into the default project.
 *
 * The handlers are driven via `runWithContext` with the SessionRouter seeded
 * with the suggestion list roots discovery would produce in production.
 */

const MCP_SESSION_ID = 'mcp-sess-test';
const SCOPE: TokenScope = '*';

let db: TestDb;
let projects: ProjectsService;
let memory: MemoryService;
let router: SessionRouter;
let agentSessions: AgentSessionsService;
let tokens: TokensService;
let adminToken: Token;
let saveHandlers: ReturnType<typeof buildMemoryHandlers>;
let sessionHandlers: ReturnType<typeof buildSessionHandlers>;
let projectHandlers: ReturnType<typeof buildProjectHandlers>;
let defaultProjectId: string;

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
  defaultProjectId = defaultProject(db.handle).id;
  projects = new ProjectsService(createRepositories(db.handle.db));
  memory = new MemoryService(createRepositories(db.handle.db), db.handle.db);
  router = new SessionRouter();
  agentSessions = new AgentSessionsService(createRepositories(db.handle.db), db.handle.db);
  tokens = new TokensService(createRepositories(db.handle.db));
  tokens.bootstrapAdmin('project-suggestion-pending-test-admin-zzz');
  adminToken = db.handle.db
    .select()
    .from(tokensSchema)
    .where(eq(tokensSchema.name, 'admin'))
    .get()!;
  saveHandlers = buildMemoryHandlers({
    memory,
    repos: createRepositories(db.handle.db),
    router,
    projects,
  });
  sessionHandlers = buildSessionHandlers({
    agentSessions,
    projects,
    router,
  });
  projectHandlers = buildProjectHandlers({
    repos: createRepositories(db.handle.db),
    projects,
    agentSessions,
    router,
  });
});

afterEach(() => db.cleanup());

describe('memory.save — the retired project_suggestion_pending gate', () => {
  it('saves into the default project while an unminted suggestion is pending', async () => {
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['acme-research']);
    const r = await runWithContext(makeContext(), () =>
      Promise.resolve(
        saveHandlers.save({ scope: 'project', type: 'project', title: 'x', content: 'x' }),
      ),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(payload.code).toBeUndefined();
    expect(memory.unsafeGetById(payload.id as string)?.projectId).toBe(defaultProjectId);
  });

  it('saves into the default project when every suggested slug already exists', async () => {
    projects.create({ slug: 'acme-research' });
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['acme-research']);
    const r = await runWithContext(makeContext(), () =>
      Promise.resolve(
        saveHandlers.save({ scope: 'project', type: 'project', title: 'x', content: 'x' }),
      ),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(memory.unsafeGetById(payload.id as string)?.projectId).toBe(defaultProjectId);
  });

  it('saves into the bound project on a path-scoped connection', async () => {
    const proj = projects.create({ slug: 'path-proj' });
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['unrelated-suggestion']);
    const r = await runWithContext(makeContext({ project: proj, requestedSlug: 'path-proj' }), () =>
      Promise.resolve(
        saveHandlers.save({ scope: 'project', type: 'project', title: 'x', content: 'x' }),
      ),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(memory.unsafeGetById(payload.id as string)?.projectId).toBe(proj.id);
  });
});

describe('memory.session_start — the retired project_suggestion_pending gate', () => {
  it('opens a session in the default project while an unminted suggestion is pending', async () => {
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['acme-research']);
    const r = await runWithContext(makeContext(), () => sessionHandlers.sessionStart({}));
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(payload.code).toBeUndefined();
    expect(payload.projectId).toBe(defaultProjectId);
  });

  it('honours an explicit project arg', async () => {
    const proj = projects.create({ slug: 'explicit-proj' });
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['acme-research']);
    const r = await runWithContext(makeContext(), () =>
      sessionHandlers.sessionStart({ project: 'explicit-proj' }),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(payload.sessionId).toBeDefined();
    expect(payload.projectId).toBe(proj.id);
  });

  it('opens a session in the default project when the suggestion already exists unpinned', async () => {
    projects.create({ slug: 'acme-research' });
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['acme-research']);
    const r = await runWithContext(makeContext(), () => sessionHandlers.sessionStart({}));
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(payload.sessionId).toBeDefined();
    expect(payload.projectId).toBe(defaultProjectId);
  });

  it('follows the router pin once the suggestion has been minted and activated', async () => {
    router.setSuggestedSlugs(adminToken.id, MCP_SESSION_ID, ['acme-research']);

    const use = await runWithContext(makeContext(), () =>
      Promise.resolve(projectHandlers.use({ slug: 'acme-research', autocreate: true })),
    );
    expect(decode(use).isError).toBe(false);

    const r = await runWithContext(makeContext(), () => sessionHandlers.sessionStart({}));
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(payload.scope).toBe('project');
    expect(payload.projectId).toBe(projects.findBySlug('acme-research')?.id);
  });

  it('lets the agent mint and pin a project AFTER the session is open', async () => {
    const started = await runWithContext(makeContext(), () => sessionHandlers.sessionStart({}));
    expect(decode(started).payload.projectId).toBe(defaultProjectId);

    const use = await runWithContext(makeContext(), () =>
      Promise.resolve(projectHandlers.use({ slug: 'acme-research', autocreate: true })),
    );
    const { isError, payload } = decode(use);
    expect(isError).toBe(false);
    expect(payload).toMatchObject({ slug: 'acme-research', created: true, switched: false });
    // A default-project resolution is not a project the agent was in, so there
    // is nothing it switched away from (`mcp-api/spec.md:1045`).
    expect(payload.previousSlug).toBeNull();
  });
});
