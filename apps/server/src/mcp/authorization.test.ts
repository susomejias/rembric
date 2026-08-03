import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import type { Project } from '../db/schema/projects.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { PromptsService } from '../services/prompts.js';
import { RelationsService } from '../services/relations.js';
import { pinnedProjectId, TokensService, type TokenScope } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { buildMemoryHandlers } from './memory-tools.js';
import { buildObservabilityHandlers } from './observability-tools.js';
import { buildProjectHandlers } from './project-tools.js';
import { buildPromptHandlers } from './prompt-tools.js';
import { buildRelationsHandlers } from './relations-tools.js';
import { buildSessionHandlers } from './session-tools.js';

/**
 * Cross-cutting authorization matrix — every tool handler must go through
 * the shared gate (`_shared.ts::assertAuthorized` / `requireScope`)
 * regardless of which tool-domain module it lives in. Pins the scenarios
 * from the `enforce-mcp-authorization` design (D4 classification table).
 */

const MCP_SESSION_ID = 'mcp-sess-authz-test';

let db: TestDb;
let repos: Repositories;
let projects: ProjectsService;
let memory: MemoryService;
let router: SessionRouter;
let agentSessions: AgentSessionsService;
let prompts: PromptsService;
let relations: RelationsService;
let tokens: TokensService;
let projectA: Project;
let projectB: Project;
let tokenByScope: Map<TokenScope, Token>;

let memoryHandlers: ReturnType<typeof buildMemoryHandlers>;
let observabilityHandlers: ReturnType<typeof buildObservabilityHandlers>;
let promptHandlers: ReturnType<typeof buildPromptHandlers>;
let sessionHandlers: ReturnType<typeof buildSessionHandlers>;
let projectHandlers: ReturnType<typeof buildProjectHandlers>;
let relationsHandlers: ReturnType<typeof buildRelationsHandlers>;

/** Real, persisted token per scope — some handlers (session_start/get) FK-reference `tokens.id`. */
function tokenFor(scope: TokenScope): Token {
  const existing = tokenByScope.get(scope);
  if (existing) return existing;
  const name = `token-${tokenByScope.size}`;
  const pinned = pinnedProjectId(scope);
  const project = [projectA, projectB].find((p) => p.id === pinned);
  let token: Token;
  if (project) {
    token = tokens.create({
      name,
      project,
      access: scope.startsWith('read:') ? 'read' : 'write',
    }).token;
  } else if (scope === '*' || scope === 'read:*') {
    token = tokens.create({ name, scope }).token;
  } else {
    throw new Error(`tokenFor: scope '${scope}' names no project this suite created`);
  }
  tokenByScope.set(scope, token);
  return token;
}

function ctxFor(scope: TokenScope, overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    token: tokenFor(scope),
    scope,
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
  repos = createRepositories(db.handle.db);
  projects = new ProjectsService(repos);
  memory = new MemoryService(repos, db.handle.db);
  router = new SessionRouter();
  agentSessions = new AgentSessionsService(repos, db.handle.db);
  prompts = new PromptsService(repos, db.handle.db);
  relations = new RelationsService(repos, db.handle.db);
  tokens = new TokensService(repos);
  tokenByScope = new Map();
  projectA = projects.create({ slug: 'authz-proj-a' });
  projectB = projects.create({ slug: 'authz-proj-b' });

  const doctor = () => ({
    db: { open: true, journalMode: 'wal', integrity: 'ok', sizeBytes: 0 },
    embeddings: { model: 'fake-test-embedder', backlog: 0 },
    entities: { backlog: 0 },
    consolidation: { lastRunAt: null, lastRunOps: {} },
    sessions: { active: 0 },
    review: { needsReview: 0, pendingJudgments: 0 },
    warnings: [],
  });

  const sharedDeps = { repos, agentSessions, memory, projects, prompts, router, relations, doctor };
  memoryHandlers = buildMemoryHandlers(sharedDeps);
  observabilityHandlers = buildObservabilityHandlers(sharedDeps);
  promptHandlers = buildPromptHandlers(sharedDeps);
  sessionHandlers = buildSessionHandlers(sharedDeps);
  projectHandlers = buildProjectHandlers(sharedDeps);
  relationsHandlers = buildRelationsHandlers(sharedDeps);
});

afterEach(() => db.cleanup());

describe('read-restricted token cannot invoke a write-classified tool', () => {
  it('memory.capture_passive rejects a read:* token with forbidden; nothing is saved', async () => {
    const r = await runWithContext(ctxFor('read:*'), () =>
      observabilityHandlers.capturePassive({
        text: '## Key Learnings:\n- should not be saved\n',
      }),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('forbidden');
    await expect(memory.search({}, { kind: 'global' })).resolves.toHaveLength(0);
  });

  it('memory.save_prompt rejects a read:project:<id> token with forbidden; nothing is saved', async () => {
    const r = await runWithContext(ctxFor(`read:project:${projectA.id}`), () =>
      promptHandlers.savePrompt({ content: 'should not persist', title: 'blocked' }),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('forbidden');
    expect(prompts.recentForContext({ projectId: null, limit: 10 })).toHaveLength(0);
  });

  it('memory.session_start rejects a read:* token with forbidden', async () => {
    const r = await runWithContext(ctxFor('read:*'), () => sessionHandlers.sessionStart({}));
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('forbidden');
  });

  it('memory.judge rejects a read:* token with forbidden; the relation stays pending', async () => {
    const source = memory.save(
      { type: 'project', title: 'src', content: 'src' },
      { kind: 'project', projectId: projectA.id },
    );
    const target = memory.save(
      { type: 'project', title: 'tgt', content: 'tgt' },
      { kind: 'project', projectId: projectA.id },
    );
    const pending = relations.createPending({ sourceId: source.id, targetId: target.id });

    const r = await runWithContext(
      ctxFor('read:*', { project: projectA, requestedSlug: projectA.slug }),
      () => relationsHandlers.judge({ judgmentId: pending.judgmentId, relation: 'related' }),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('forbidden');
    expect(repos.relations.findByJudgmentId(pending.judgmentId)?.status).toBe('pending');
  });

  it('memory.compare rejects a read:* token with forbidden; no relation is written and no status flips', async () => {
    const a = memory.save(
      { type: 'project', title: 'a', content: 'a', topicKey: 'k' },
      { kind: 'project', projectId: projectA.id },
    );
    const b = memory.save(
      { type: 'project', title: 'b', content: 'b' },
      { kind: 'project', projectId: projectA.id },
    );

    const r = await runWithContext(
      ctxFor('read:*', { project: projectA, requestedSlug: projectA.slug }),
      () =>
        relationsHandlers.compare({
          memoryIdA: a.id,
          memoryIdB: b.id,
          relation: 'supersedes',
          confidence: 1,
        }),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('forbidden');
    expect(memory.get(b.id, { kind: 'project', projectId: projectA.id })?.memory.status).toBe(
      'active',
    );
  });

  it('memory.compare succeeds for a write-capable token (records a judged relation)', async () => {
    const a = memory.save(
      { type: 'project', title: 'a2', content: 'a2' },
      { kind: 'project', projectId: projectA.id },
    );
    const b = memory.save(
      { type: 'project', title: 'b2', content: 'b2' },
      { kind: 'project', projectId: projectA.id },
    );
    const r = await runWithContext(
      ctxFor('*', { project: projectA, requestedSlug: projectA.slug }),
      () =>
        relationsHandlers.compare({
          memoryIdA: a.id,
          memoryIdB: b.id,
          relation: 'related',
          confidence: 0.9,
        }),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(false);
    expect(payload.status).toBe('judged');
  });
});

describe('project-restricted token cannot read or write outside its project', () => {
  it('memory.context: project:A token on a connection resolved to project B → forbidden', async () => {
    router.setActiveProject(
      tokenFor(`project:${projectA.id}`).id,
      MCP_SESSION_ID,
      projectB.id,
      'tool-explicit',
    );
    const r = await runWithContext(ctxFor(`project:${projectA.id}`), () =>
      memoryHandlers.context({}),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('forbidden');
  });

  it('memory.timeline: project:A token on a connection resolved to project B → forbidden', async () => {
    const tokenId = tokenFor(`project:${projectA.id}`).id;
    const target = memory.save(
      { type: 'project', title: 'in b', content: 'in b' },
      { kind: 'project', projectId: projectB.id },
    );
    router.setActiveProject(tokenId, MCP_SESSION_ID, projectB.id, 'tool-explicit');
    const r = await runWithContext(ctxFor(`project:${projectA.id}`), () =>
      memoryHandlers.timeline({ memoryId: target.id }),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('forbidden');
  });

  it('memory.stats: read:project:A token resolved to project B → forbidden', async () => {
    const tokenId = tokenFor(`read:project:${projectA.id}`).id;
    router.setActiveProject(tokenId, MCP_SESSION_ID, projectB.id, 'tool-explicit');
    const r = await runWithContext(ctxFor(`read:project:${projectA.id}`), () =>
      observabilityHandlers.stats(),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('forbidden');
  });

  it('memory.search_prompts: read:project:A token resolved to project B → forbidden', async () => {
    const tokenId = tokenFor(`read:project:${projectA.id}`).id;
    router.setActiveProject(tokenId, MCP_SESSION_ID, projectB.id, 'tool-explicit');
    const r = await runWithContext(ctxFor(`read:project:${projectA.id}`), () =>
      promptHandlers.searchPrompts({}),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('forbidden');
  });

  it('memory.session_get: project:A token resolved to project B → forbidden', async () => {
    const tokenId = tokenFor(`project:${projectA.id}`).id;
    const sess = agentSessions.start({ tokenId, projectId: projectB.id, agent: 'x' });
    router.setActiveProject(tokenId, MCP_SESSION_ID, projectB.id, 'tool-explicit');
    const r = await runWithContext(ctxFor(`project:${projectA.id}`), () =>
      sessionHandlers.sessionGet({ sessionId: sess.id }),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('forbidden');
  });
});

describe('project-restricted token on an unscoped connection resolving global scope', () => {
  it('memory.context is forbidden while unscoped, then succeeds against project A after project.use', async () => {
    const ctxScope: TokenScope = `read:project:${projectA.id}`;
    memory.save(
      { type: 'project', title: 'in a', content: 'in a' },
      { kind: 'project', projectId: projectA.id },
    );

    const rejected = await runWithContext(ctxFor(ctxScope), () => memoryHandlers.context({}));
    const rejectedDecoded = decode(rejected);
    expect(rejectedDecoded.isError).toBe(true);
    expect(rejectedDecoded.payload.code).toBe('forbidden');

    const used = await runWithContext(ctxFor(ctxScope), () =>
      Promise.resolve(projectHandlers.use({ slug: projectA.slug })),
    );
    expect(decode(used).isError).toBeFalsy();

    const succeeded = await runWithContext(ctxFor(ctxScope), () => memoryHandlers.context({}));
    const succeededDecoded = decode(succeeded);
    expect(succeededDecoded.isError).toBeFalsy();
    expect(succeededDecoded.payload.scope).toBe(`project:${projectA.id}`);
  });
});

describe('full-access token is never rejected by authorization', () => {
  it('a `*` token succeeds on read and write tools across scopes', async () => {
    const ctx = ctxFor('*');

    const write = await runWithContext(ctx, () =>
      memoryHandlers.save({ scope: 'global', type: 'user', title: 'admin note', content: 'x' }),
    );
    expect(decode(write).isError).toBeFalsy();

    const read = await runWithContext(ctx, () => memoryHandlers.context({}));
    expect(decode(read).isError).toBeFalsy();

    router.setActiveProject(tokenFor('*').id, MCP_SESSION_ID, projectA.id, 'tool-explicit');
    const projectRead = await runWithContext(ctx, () => memoryHandlers.context({}));
    expect(decode(projectRead).isError).toBeFalsy();

    const list = await runWithContext(ctx, () => Promise.resolve(projectHandlers.list({})));
    expect(decode(list).isError).toBeFalsy();
  });
});

describe('project.list is filtered by token scope', () => {
  it('a `*` token sees every project', async () => {
    const r = await runWithContext(ctxFor('*'), () => Promise.resolve(projectHandlers.list({})));
    const { payload } = decode(r);
    const slugs = (payload.projects as { slug: string }[]).map((p) => p.slug).sort();
    expect(slugs).toEqual([projectA.slug, projectB.slug].sort());
  });

  it('a `read:*` token sees every project', async () => {
    const r = await runWithContext(ctxFor('read:*'), () =>
      Promise.resolve(projectHandlers.list({})),
    );
    const { payload } = decode(r);
    const slugs = (payload.projects as { slug: string }[]).map((p) => p.slug).sort();
    expect(slugs).toEqual([projectA.slug, projectB.slug].sort());
  });

  it('a `project:<id>` token sees only that project', async () => {
    const r = await runWithContext(ctxFor(`project:${projectA.id}`), () =>
      Promise.resolve(projectHandlers.list({})),
    );
    const { payload } = decode(r);
    const slugs = (payload.projects as { slug: string }[]).map((p) => p.slug);
    expect(slugs).toEqual([projectA.slug]);
  });

  it('a `read:project:<id>` token sees only that project', async () => {
    const r = await runWithContext(ctxFor(`read:project:${projectB.id}`), () =>
      Promise.resolve(projectHandlers.list({})),
    );
    const { payload } = decode(r);
    const slugs = (payload.projects as { slug: string }[]).map((p) => p.slug);
    expect(slugs).toEqual([projectB.slug]);
  });
});

describe('project.use({autocreate: true}) requires write authorization', () => {
  it('a `read:*` token cannot autocreate a new project', async () => {
    const r = await runWithContext(ctxFor('read:*'), () =>
      Promise.resolve(projectHandlers.use({ slug: 'brand-new-slug', autocreate: true })),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('forbidden');
    expect(projects.findBySlug('brand-new-slug')).toBeUndefined();
  });

  it('a `read:project:<id>` token cannot autocreate a new project', async () => {
    const r = await runWithContext(ctxFor(`read:project:${projectA.id}`), () =>
      Promise.resolve(projectHandlers.use({ slug: 'another-new-slug', autocreate: true })),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('forbidden');
    expect(projects.findBySlug('another-new-slug')).toBeUndefined();
  });

  it('a `project:<id>` token cannot autocreate a new project', async () => {
    const r = await runWithContext(ctxFor(`project:${projectA.id}`), () =>
      Promise.resolve(projectHandlers.use({ slug: 'yet-another-slug', autocreate: true })),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBe(true);
    expect(payload.code).toBe('forbidden');
    expect(projects.findBySlug('yet-another-slug')).toBeUndefined();
  });

  it('a `*` token can still autocreate a new project', async () => {
    const r = await runWithContext(ctxFor('*'), () =>
      Promise.resolve(projectHandlers.use({ slug: 'admin-created-slug', autocreate: true })),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(payload.created).toBe(true);
    expect(projects.findBySlug('admin-created-slug')).toBeDefined();
  });

  it('autocreate against an already-existing slug is unaffected by the write check', async () => {
    const r = await runWithContext(ctxFor(`read:project:${projectA.id}`), () =>
      Promise.resolve(projectHandlers.use({ slug: projectA.slug, autocreate: true })),
    );
    const { isError, payload } = decode(r);
    expect(isError).toBeFalsy();
    expect(payload.created).toBe(false);
  });
});
