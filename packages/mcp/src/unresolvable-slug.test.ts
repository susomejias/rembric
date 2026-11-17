import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { AgentSessionsService } from '@rembric/core';
import { MemoryService } from '@rembric/core';
import { ProjectsService } from '@rembric/core';
import { PromptsService } from '@rembric/core';
import { RelationsService } from '@rembric/core';
import { RepositoryBindingsService } from '@rembric/core';
import { runWithContext, type RequestContext } from '@rembric/core';
import {
  createRepositories,
  memory as memoryTable,
  projectScope,
  prompts as promptsTable,
  type Project,
  type Repositories,
  type Token,
} from '@rembric/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildInstructions } from '@rembric/mcp';
import { buildMemoryHandlers } from '@rembric/mcp';
import { buildObservabilityHandlers, type DoctorReport } from '@rembric/mcp';
import { buildProjectHandlers } from '@rembric/mcp';
import { buildPromptHandlers } from '@rembric/mcp';
import { createMcpServer } from '@rembric/mcp';
import { buildSessionHandlers } from '@rembric/mcp';

import { createTestDb, defaultProject, mintTestToken, type TestDb } from './test-support/index.js';
import { logInternalError } from './test-support/test-logger.js';

const UNRESOLVABLE = 'no-such-project';
const ADMIN = '*' as const;

let db: TestDb;
let repos: Repositories;
let projects: ProjectsService;
let memory: MemoryService;
let agentSessions: AgentSessionsService;
let prompts: PromptsService;
let relations: RelationsService;
let adminToken: Token;
let realProject: Project;
let defaultProjectId: string;
/** A row a path-LESS connection would see, which this one must not fall back to. */
let defaultMemoryId: string;

const DOCTOR: DoctorReport = {
  db: { journalMode: 'wal', integrity: 'ok', sizeBytes: 0 },
  embeddings: { model: 'test', backlog: 0 },
  entities: { backlog: 0 },
  consolidation: { lastRunAt: null, lastRunOps: {} },
  sessions: { active: 0 },
  review: { needsReview: 0, pendingJudgments: 0 },
  warnings: [],
};

beforeEach(() => {
  db = createTestDb();
  repos = createRepositories(db.handle.db);
  projects = new ProjectsService(repos);
  memory = new MemoryService(repos, db.handle.db);
  agentSessions = new AgentSessionsService(repos, db.handle.db);
  prompts = new PromptsService(repos, db.handle.db);
  relations = new RelationsService(repos, db.handle.db);
  adminToken = mintTestToken(db.handle, { scope: ADMIN }).token;
  realProject = projects.create({ slug: 'rembric' });
  defaultProjectId = defaultProject(db.handle).id;
  defaultMemoryId = memory.save(
    { type: 'user', title: 'default-project row', content: 'default-project row about tabs' },
    projectScope(defaultProjectId),
  ).id;
});

afterEach(() => db.cleanup());

function ctxFor(overrides: Partial<RequestContext> = {}): RequestContext {
  return {
    token: adminToken,
    scope: ADMIN,
    memberProjectIds: [],
    project: null,
    requestedSlug: UNRESOLVABLE,
    ...overrides,
  };
}

interface McpResp {
  content?: { type: string; text?: string }[];
  isError?: boolean;
}

function decode(resp: unknown): { isError: boolean; body: Record<string, unknown> } {
  const r = resp as McpResp;
  const text = r.content?.[0]?.text ?? '{}';
  return { isError: r.isError === true, body: JSON.parse(text) as Record<string, unknown> };
}

function memoryHandlers() {
  return buildMemoryHandlers({
    logInternalError,
    memory,
    relations,
    repos,
    projects,
    agentSessions,
    prompts,
  });
}

function countRows(): { memories: number; prompts: number } {
  return {
    memories: db.handle.db.select().from(memoryTable).all().length,
    prompts: db.handle.db.select().from(promptsTable).all().length,
  };
}

describe('reads on an unresolvable slug refuse rather than widen', () => {
  it('memory.get_batch on a default-project id returns project_not_found and no content', async () => {
    const r = await runWithContext(ctxFor(), () =>
      Promise.resolve(memoryHandlers().get({ ids: [defaultMemoryId], relations_limit: 50 })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('project_not_found');
    expect(body.memory).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('default-project row about tabs');
  });

  it('memory.get_batch reports the unusable connection for a valid-shaped request', async () => {
    const r = await runWithContext(ctxFor(), () =>
      memoryHandlers().get({ ids: ['unresolved-control'] }),
    );
    expect(decode(r).body.code).toBe('project_not_found');
  });

  it('the same valid request is not_found on a resolvable slug', async () => {
    const r = await runWithContext(
      ctxFor({ project: realProject, requestedSlug: realProject.slug }),
      () => memoryHandlers().get({ ids: ['unresolved-control'] }),
    );
    expect(decode(r).body.code).toBe('not_found');
  });
});

describe('writes on an unresolvable slug insert nothing', () => {
  it('memory.capture_passive is refused and inserts no memory row', async () => {
    const before = countRows();
    const handlers = buildObservabilityHandlers({
      logInternalError,
      memory,
      agentSessions,
      repos,
      projects,
      doctor: () => DOCTOR,
      relations,
      candidates: { perSaveMax: 5 },
    });
    const r = await runWithContext(ctxFor(), () =>
      Promise.resolve(
        handlers.capturePassive({
          text: '## Key Learnings\n\n1. a learning worth persisting\n2. a second one',
        }),
      ),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('project_not_found');
    // Non-zero at both ends: a before/after match over an empty table is vacuous.
    expect(before.memories).toBeGreaterThan(0);
    expect(countRows().memories).toBe(before.memories);
  });

  it('memory.save_prompt is refused and inserts no prompt row', async () => {
    prompts.save({
      content: 'a pre-existing prompt',
      sessionId: null,
      projectId: realProject.id,
      agent: 'test',
      title: 'seed',
      tags: null,
      replaces: null,
    });
    const before = countRows();
    const handlers = buildPromptHandlers({
      logInternalError,
      prompts,
      agentSessions,
      projects,
    });
    const r = await runWithContext(ctxFor(), () =>
      Promise.resolve(handlers.savePrompt({ content: 'a curated prompt', title: 'p' })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('project_not_found');
    expect(before.prompts).toBeGreaterThan(0);
    expect(countRows().prompts).toBe(before.prompts);
  });

  it('memory.session_start is refused and opens no session in the default project', async () => {
    const handlers = buildSessionHandlers({ logInternalError, agentSessions, projects });
    const r = await runWithContext(ctxFor(), () =>
      Promise.resolve(handlers.sessionStart({ agent: 'probe' })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('project_not_found');
    expect(agentSessions.countByStatus(projectScope(defaultProjectId)).active).toBe(0);
  });
});

describe('the refusal names candidate slugs', () => {
  it('a near-miss slug returns suggestedSlugs containing the real one', async () => {
    const r = await runWithContext(ctxFor({ requestedSlug: 'rembic' }), () =>
      Promise.resolve(memoryHandlers().search({ query: 'tabs' })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('project_not_found');
    expect(body.suggestedSlugs).toContain('rembric');
  });
});

describe('the refusal does not brick the connection', () => {
  it('project.current and project.list still work, and the refusal points at the dashboard', async () => {
    const projectTools = buildProjectHandlers({
      logInternalError,
      repos,
      projects,
      agentSessions,
      repositoryBindings: new RepositoryBindingsService(repos, db.handle.db),
    });
    const current = await runWithContext(ctxFor(), () => Promise.resolve(projectTools.current({})));
    expect(decode(current).isError).toBe(false);
    memory.save(
      { type: 'project', title: 'row in the real project', content: 'row in the real project' },
      projectScope(realProject.id),
    );
    const listed = await runWithContext(ctxFor(), () => Promise.resolve(projectTools.list({})));
    expect(decode(listed).isError).toBe(false);
    const entries = decode(listed).body.projects as
      | { slug: string; activeMemoryCount: number }[]
      | undefined;
    const real = entries?.find((e) => e.slug === realProject.slug);
    expect(real, `project.list has no entry for ${realProject.slug}`).toBeDefined();
    expect(real?.activeMemoryCount).toBe(1);

    const refused = await runWithContext(ctxFor(), () =>
      Promise.resolve(memoryHandlers().search({ query: 'tabs' })),
    );
    const { isError, body } = decode(refused);
    expect(isError).toBe(true);
    expect(body.message).toBe(
      `project '${UNRESOLVABLE}' does not exist; create it from the dashboard or with project.create({ slug: '${UNRESOLVABLE}' })`,
    );
  });

  it('project.current on an unresolvable slug projects no project data at all', async () => {
    const projectTools = buildProjectHandlers({
      logInternalError,
      repos,
      projects,
      agentSessions,
      repositoryBindings: new RepositoryBindingsService(repos, db.handle.db),
    });
    const pinnedToOther = mintTestToken(db.handle, {
      project: realProject,
      access: 'read',
    }).token;
    const r = await runWithContext(
      ctxFor({ token: pinnedToOther, scope: `read:project:${realProject.id}` }),
      () => Promise.resolve(projectTools.current({})),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(false);
    expect(body).toEqual({
      slug: null,
      projectId: null,
      source: 'url-path',
    });
  });
});

describe('error messages name only reachable remedies', () => {
  it('a path-scoped save is not refused at all, so no message can name a retired scope', async () => {
    const r = await runWithContext(
      ctxFor({ project: realProject, requestedSlug: realProject.slug }),
      () => Promise.resolve(memoryHandlers().save({ type: 'user', title: 't', content: 'c' })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(false);
    expect(memory.unsafeGetById(body.id as string)?.projectId).toBe(realProject.id);
  });

  it('the refusal a path-scoped connection can still produce names no scope', async () => {
    const sessionTools = buildSessionHandlers({ logInternalError, agentSessions, projects });
    const r = await runWithContext(
      ctxFor({ project: realProject, requestedSlug: realProject.slug }),
      () => Promise.resolve(sessionTools.sessionStart({ project: 'somewhere-else' })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('scope_locked');
    const message = body.message as string;
    expect(message).toContain('rembric');
    expect(message).not.toMatch(/global|user-wide/i);
    expect(message).not.toMatch(/separate MCP connection|second connection/i);
  });

  it('agrees with the path-scoped instructions block about reachability', () => {
    const instructions = buildInstructions({ requestedSlug: realProject.slug });
    expect(instructions).toContain(realProject.slug);
    expect(instructions).not.toMatch(/global|user-wide/i);
    expect(instructions).not.toMatch(/separate MCP connection|second connection/i);
  });

  it('a project-pinned token denied a read on the default project is told the URL of its own', async () => {
    const pinned = mintTestToken(db.handle, { project: realProject, access: 'write' }).token;
    const r = await runWithContext(
      ctxFor({
        token: pinned,
        scope: `project:${realProject.id}`,
        requestedSlug: null,
      }),
      () => Promise.resolve(memoryHandlers().search({ query: 'tabs' })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('forbidden');
    const message = body.message as string;
    expect(message).toContain("reconnect at '/mcp/rembric'");
    expect(message).not.toContain('project.use');
  });

  it('a read:* token denied a write is not told to reconnect', async () => {
    const readOnly = mintTestToken(db.handle, { scope: 'read:*' }).token;
    const r = await runWithContext(
      ctxFor({
        token: readOnly,
        scope: 'read:*',
        requestedSlug: null,
      }),
      () => Promise.resolve(memoryHandlers().save({ type: 'user', title: 't', content: 'c' })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('forbidden');
    expect(body.message as string).not.toContain('reconnect at');
  });

  it('a token pinned to another project IS told its URL on a project-scope denial', async () => {
    const other = projects.create({ slug: 'other-project' });
    const pinned = mintTestToken(db.handle, { project: other, access: 'read' }).token;
    const r = await runWithContext(
      ctxFor({
        token: pinned,
        scope: `read:project:${other.id}`,
        requestedSlug: null,
      }),
      () => Promise.resolve(memoryHandlers().search({ query: 'tabs' })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('forbidden');
    expect(body.message as string).toContain(defaultProjectId);
    expect(body.message as string).toContain("reconnect at '/mcp/other-project'");
    expect(body.message as string).not.toContain('project.use');
  });

  it('a token denied an action on its OWN pinned project is not told to reconnect', async () => {
    const home = projects.getById(defaultProjectId);
    if (!home) throw new Error('fixture: default project missing');
    const pinned = mintTestToken(db.handle, { project: home, access: 'read' }).token;
    const r = await runWithContext(
      ctxFor({
        token: pinned,
        scope: `read:project:${home.id}`,
        requestedSlug: null,
      }),
      () => Promise.resolve(memoryHandlers().save({ type: 'user', title: 't', content: 'c' })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('forbidden');
    expect(body.message as string).not.toContain('reconnect at');
  });

  it('a legacy token whose scope carries a slug is told that slug’s URL', async () => {
    const r = await runWithContext(
      ctxFor({
        scope: 'read:project:legacy-slug',
        requestedSlug: null,
      }),
      () => Promise.resolve(memoryHandlers().save({ type: 'user', title: 't', content: 'c' })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('forbidden');
    expect(body.message as string).toContain("reconnect at '/mcp/legacy-slug'");
    expect(body.message as string).not.toContain('undefined');
  });

  it('a pinned token denied a read on another path-scoped connection is told its URL', async () => {
    const other = projects.create({ slug: 'other-project' });
    const pinned = mintTestToken(db.handle, { project: other, access: 'read' }).token;
    const r = await runWithContext(
      ctxFor({
        token: pinned,
        scope: `read:project:${other.id}`,
        project: realProject,
        requestedSlug: realProject.slug,
      }),
      () => Promise.resolve(memoryHandlers().search({ query: 'tabs' })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('forbidden');
    expect(body.message as string).toContain("reconnect at '/mcp/other-project'");
    expect(body.message as string).not.toContain('project.use');
  });
});

const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  'memory.save': { type: 'user', title: 't', content: 'c', tags: ['mcp'] },
  'memory.search': {},
  'memory.get_batch': { ids: ['placeholder'] },
  'memory.confirm_batch': { ids: ['placeholder'] },
  'memory.archive': { id: 'placeholder' },
  'memory.merge': {
    ids: ['placeholder-a', 'placeholder-b'],
    type: 'user',
    title: 't',
    content: 'c',
    tags: ['mcp'],
  },
  'memory.session_start': {},
  'memory.session_end': {},
  'memory.session_summary': { summary: 's' },
  'memory.session_resume': { sessionId: 'placeholder' },
  'memory.context': {},
  'memory.session_get_batch': { ids: ['placeholder'] },
  'memory.timeline': { memoryId: 'placeholder' },
  'memory.capture_passive': { text: '## Key Learnings\n\n1. one learning', tags: ['mcp'] },
  'memory.save_prompt': { content: 'c', title: 't' },
  'memory.search_prompts': {},
  'memory.doctor': {},
  'memory.stats': {},
  'memory.suggest_topic_key': { type: 'user', title: 't' },
  'memory.judge_batch': { judgments: [{ judgmentId: 'placeholder', relation: 'related' }] },
  'memory.compare': {
    memoryIdA: 'a',
    memoryIdB: 'b',
    relation: 'related',
    confidence: 0.5,
  },
};

const EXEMPT: Record<string, Record<string, unknown>> = {
  'memory.about': {},
  'project.list': {},
  'project.current': {},
  'project.bind_repository': { slug: 'rembric' },
  'project.create': { slug: 'exempt-created' },
};

const FINGERPRINT = 'ab'.repeat(20);

function exemptCtx(name: string, overrides: Partial<RequestContext> = {}): RequestContext {
  return ctxFor(
    name === 'project.bind_repository'
      ? { repository: { fingerprint: FINGERPRINT }, ...overrides }
      : overrides,
  );
}

describe('every registered scope-sensitive tool refuses an unresolvable slug', () => {
  let client: Client;

  beforeEach(async () => {
    const server = createMcpServer({
      memory,
      projects,
      agentSessions,
      prompts,
      relations,
      repositoryBindings: new RepositoryBindingsService(repos, db.handle.db),
      candidates: { perSaveMax: 5 },
      repos,
      doctor: () => DOCTOR,
      requestedSlug: UNRESOLVABLE,
      logInternalError,
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    client = new Client({ name: 'test-client', version: '0' });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(async () => {
    await client.close();
  });

  it('classifies every advertised tool: refused, or explicitly exempt', async () => {
    const advertised = (await client.listTools()).tools.map((t) => t.name).sort();
    const classified = [...Object.keys(MINIMAL_ARGS), ...Object.keys(EXEMPT)].sort();
    expect(advertised).toEqual(classified);
  });

  it.each(Object.keys(MINIMAL_ARGS))('%s returns the structured refusal', async (name) => {
    const args = { ...MINIMAL_ARGS[name] };
    if ('id' in args) args.id = defaultMemoryId;
    if ('memoryId' in args) args.memoryId = defaultMemoryId;

    const result = await runWithContext(ctxFor(), () => client.callTool({ name, arguments: args }));
    const { isError, body } = decode(result);
    expect(isError).toBe(true);
    expect(body.code).toBe('project_not_found');
    expect(Array.isArray(body.suggestedSlugs)).toBe(true);
  });

  it.each(Object.keys(EXEMPT))('%s stays reachable', async (name) => {
    const result = await runWithContext(exemptCtx(name), () =>
      client.callTool({ name, arguments: EXEMPT[name] ?? {} }),
    );
    expect(decode(result).isError).toBe(false);
  });

  describe('on an unbound request', () => {
    const unbound = (name = ''): RequestContext =>
      exemptCtx(name, { requestedSlug: null, repository: { fingerprint: FINGERPRINT } });

    it.each(Object.keys(MINIMAL_ARGS))('%s is refused with project_unbound', async (name) => {
      const args = { ...MINIMAL_ARGS[name] };
      if ('id' in args) args.id = defaultMemoryId;
      if ('memoryId' in args) args.memoryId = defaultMemoryId;
      const before = countRows();
      const result = await runWithContext(unbound(), () =>
        client.callTool({ name, arguments: args }),
      );
      const { isError, body } = decode(result);
      expect(isError).toBe(true);
      expect(body.code).toBe('project_unbound');
      expect(countRows()).toEqual(before);
    });

    it.each(Object.keys(MINIMAL_ARGS))(
      'control: %s without the header is not refused as unbound',
      async (name) => {
        const args = { ...MINIMAL_ARGS[name] };
        if ('id' in args) args.id = defaultMemoryId;
        if ('memoryId' in args) args.memoryId = defaultMemoryId;
        const result = await runWithContext(ctxFor({ requestedSlug: null }), () =>
          client.callTool({ name, arguments: args }),
        );
        expect(decode(result).body.code).not.toBe('project_unbound');
      },
    );

    it.each(Object.keys(EXEMPT))('%s stays reachable', async (name) => {
      const result = await runWithContext(unbound(name), () =>
        client.callTool({ name, arguments: EXEMPT[name] ?? {} }),
      );
      expect(decode(result).isError).toBe(false);
    });
  });

  it.each(['projects', ADMIN] as const)(
    'no tool creates the named project for a %s token',
    async (scope) => {
      const member = projects.create({ slug: 'set-member' });
      const memberProjectIds = scope === ADMIN ? [] : [realProject.id, member.id];
      const token =
        scope === ADMIN
          ? adminToken
          : mintTestToken(db.handle, { projects: [realProject, member], access: 'write' }).token;
      const ctx = ctxFor({ token, scope, memberProjectIds });
      const before = projects.list(true).length;
      const creators = ['project.create'];
      const others = [...Object.keys(MINIMAL_ARGS), ...Object.keys(EXEMPT)].filter(
        (name) => !creators.includes(name),
      );
      for (const name of others) {
        const args: Record<string, unknown> = { ...MINIMAL_ARGS[name], ...EXEMPT[name] };
        if (name === 'memory.session_start') args.project = UNRESOLVABLE;
        await runWithContext(ctx, () => client.callTool({ name, arguments: args }));
      }
      expect(projects.findBySlug(UNRESOLVABLE)).toBeUndefined();
      expect(projects.list(true)).toHaveLength(before);
    },
  );
});
