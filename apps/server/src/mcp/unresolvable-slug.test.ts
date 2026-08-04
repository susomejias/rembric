import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createRepositories, type Repositories } from '../db/repositories/index.js';
import { memory as memoryTable } from '../db/schema/memory.js';
import type { Project } from '../db/schema/projects.js';
import { prompts as promptsTable } from '../db/schema/prompts.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { SessionRouter } from '../server/session-router.js';
import { AgentSessionsService } from '../services/agent-sessions.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { PromptsService } from '../services/prompts.js';
import { RelationsService } from '../services/relations.js';
import { projectScope } from '../services/scope.js';
import { createTestDb, defaultProject, mintTestToken, type TestDb } from '../test/index.js';

import { buildInstructions } from './instructions.js';
import { buildMemoryHandlers } from './memory-tools.js';
import { buildObservabilityHandlers, type DoctorReport } from './observability-tools.js';
import { buildProjectHandlers } from './project-tools.js';
import { buildPromptHandlers } from './prompt-tools.js';
import { createMcpServer } from './server.js';
import { buildSessionHandlers } from './session-tools.js';

/**
 * A path slug that names no project used to resolve to the global scope, so
 * `/mcp/<typo>` was a live connection onto user-wide memory: reads widened and
 * `capture_passive` / `save_prompt` / `session_start` deposited global rows.
 * Every tool that resolves scope now refuses with `project_not_found`.
 */

const UNRESOLVABLE = 'no-such-project';
const ADMIN = '*' as const;

let db: TestDb;
let repos: Repositories;
let projects: ProjectsService;
let memory: MemoryService;
let agentSessions: AgentSessionsService;
let prompts: PromptsService;
let relations: RelationsService;
let router: SessionRouter;
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
  router = new SessionRouter();
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
    project: null,
    requestedSlug: UNRESOLVABLE,
    mcpSessionId: 'mcp-sess-unresolvable',
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
    memory,
    relations,
    repos,
    router,
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
  it('memory.get on a default-project id returns project_not_found and no content', async () => {
    const r = await runWithContext(ctxFor(), () =>
      Promise.resolve(memoryHandlers().get({ id: defaultMemoryId })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('project_not_found');
    expect(body.memory).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('default-project row about tabs');
  });

  it('memory.get with neither id nor ids reports the unusable connection, not invalid_input', async () => {
    const r = await runWithContext(ctxFor(), () => Promise.resolve(memoryHandlers().get({})));
    expect(decode(r).body.code).toBe('project_not_found');
  });

  // Control: the same malformed call on a slug that DOES resolve still reports
  // the argument error, so the reordering above is scoped to the refusal.
  it('memory.get with neither id nor ids is still invalid_input on a resolvable slug', async () => {
    const r = await runWithContext(
      ctxFor({ project: realProject, requestedSlug: realProject.slug }),
      () => Promise.resolve(memoryHandlers().get({})),
    );
    expect(decode(r).body.code).toBe('invalid_input');
  });
});

describe('writes on an unresolvable slug insert nothing', () => {
  it('memory.capture_passive is refused and inserts no memory row', async () => {
    const before = countRows();
    const handlers = buildObservabilityHandlers({
      memory,
      agentSessions,
      repos,
      router,
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
    const handlers = buildPromptHandlers({ prompts, agentSessions, router, projects });
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
    const handlers = buildSessionHandlers({ agentSessions, projects, router });
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
  it('project.current, project.list, memory.about and project.use all still work', async () => {
    const projectTools = buildProjectHandlers({ repos, projects, agentSessions, router });
    const current = await runWithContext(ctxFor(), () => Promise.resolve(projectTools.current({})));
    expect(decode(current).isError).toBe(false);
    // A project row with content, so the count below is non-zero and the
    // assertion is not satisfied by an empty corpus.
    memory.save(
      { type: 'project', title: 'row in the real project', content: 'row in the real project' },
      projectScope(realProject.id),
    );
    const listed = await runWithContext(ctxFor(), () => Promise.resolve(projectTools.list({})));
    expect(decode(listed).isError).toBe(false);
    // The count is produced without resolving an effective scope, so it must
    // still be reported for every project the token may read.
    const entries = decode(listed).body.projects as
      | { slug: string; activeMemoryCount: number }[]
      | undefined;
    const real = entries?.find((e) => e.slug === realProject.slug);
    expect(real, `project.list has no entry for ${realProject.slug}`).toBeDefined();
    expect(real?.activeMemoryCount).toBe(1);

    const used = await runWithContext(ctxFor(), () =>
      Promise.resolve(projectTools.use({ slug: UNRESOLVABLE, autocreate: true })),
    );
    const { isError, body } = decode(used);
    expect(isError).toBe(false);
    expect(body.created).toBe(true);
  });

  it('a scope-resolving tool succeeds in the new project after that project.use', async () => {
    const projectTools = buildProjectHandlers({ repos, projects, agentSessions, router });
    await runWithContext(ctxFor(), () =>
      Promise.resolve(projectTools.use({ slug: UNRESOLVABLE, autocreate: true })),
    );
    // `authenticate` re-runs per request, so the next call arrives with
    // `ctx.project` populated from the now-existing slug.
    const minted = projects.findBySlug(UNRESOLVABLE);
    expect(minted).toBeDefined();
    const inScope = memory.save(
      { type: 'project', title: 'row in the minted project', content: 'row in the minted project' },
      projectScope(minted?.id ?? ''),
    );
    const r = await runWithContext(ctxFor({ project: minted ?? null }), () =>
      Promise.resolve(memoryHandlers().search({ query: 'minted' })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(false);
    expect((body.memories as { id: string }[]).map((m) => m.id)).toContain(inScope.id);
  });
});

describe('error messages name only reachable remedies', () => {
  it('scope_locked names the project and does not promise a second connection', async () => {
    const r = await runWithContext(
      ctxFor({ project: realProject, requestedSlug: realProject.slug }),
      () =>
        Promise.resolve(
          memoryHandlers().save({ scope: 'global', type: 'user', title: 't', content: 'c' }),
        ),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('scope_locked');
    const message = body.message as string;
    expect(message).toContain('rembric');
    expect(message).not.toMatch(/separate MCP connection|second connection/i);
    expect(message).toMatch(/user-wide memory is not reachable/i);
  });

  it('agrees with the path-scoped instructions block about reachability', () => {
    // Two surfaces of the same connection: neither may claim user-wide memory
    // is reachable from it.
    const instructions = buildInstructions({ requestedSlug: realProject.slug });
    expect(instructions).toMatch(/User-wide memory is not reachable here/);
    expect(instructions).not.toMatch(/separate MCP connection|second connection/i);
  });

  it('a project-pinned token denied a read on the default project is told to activate its own', async () => {
    const pinned = mintTestToken(db.handle, { project: realProject, access: 'write' }).token;
    const r = await runWithContext(
      ctxFor({
        token: pinned,
        scope: `project:${realProject.id}`,
        requestedSlug: null,
        mcpSessionId: 'mcp-sess-pinned',
      }),
      () => Promise.resolve(memoryHandlers().search({ query: 'tabs' })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('forbidden');
    const message = body.message as string;
    expect(message).toContain('project.use');
    expect(message).toContain('rembric');
  });

  // Control for the clause above: a token with no project pin has nothing to
  // activate, so the hint must be absent.
  it('a read:* token denied a write is not told to call project.use', async () => {
    const readOnly = mintTestToken(db.handle, { scope: 'read:*' }).token;
    const r = await runWithContext(
      ctxFor({
        token: readOnly,
        scope: 'read:*',
        requestedSlug: null,
        mcpSessionId: 'mcp-sess-readonly',
      }),
      () =>
        Promise.resolve(
          memoryHandlers().save({ scope: 'global', type: 'user', title: 't', content: 'c' }),
        ),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('forbidden');
    expect(body.message as string).not.toContain('project.use');
  });

  // The remedy's condition is "the resolved scope differs from the token's pin",
  // not "the resolved scope is global": a router pin on a path-less connection is
  // switchable with `project.use`, so the way out is real here too.
  it('a token pinned to another project IS told to activate it on a project-scope denial', async () => {
    const other = projects.create({ slug: 'other-project' });
    const pinned = mintTestToken(db.handle, { project: other, access: 'read' }).token;
    router.setActiveProject(pinned.id, 'mcp-sess-cross', realProject.id, 'tool-explicit');
    const r = await runWithContext(
      ctxFor({
        token: pinned,
        scope: `read:project:${other.id}`,
        requestedSlug: null,
        mcpSessionId: 'mcp-sess-cross',
      }),
      () => Promise.resolve(memoryHandlers().search({ query: 'tabs' })),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('forbidden');
    // The denial names the project it refused; the remedy names the token's pin.
    expect(body.message as string).toContain(realProject.id);
    expect(body.message as string).toContain("project.use({slug: 'other-project'})");
  });

  // Second control: the denied scope IS the token's pin, so re-activating it
  // changes nothing — a `read:` token refused a write cannot fix that by moving.
  it('a token denied an action on its OWN pinned project is not told to activate it', async () => {
    const pinned = mintTestToken(db.handle, { project: realProject, access: 'read' }).token;
    router.setActiveProject(pinned.id, 'mcp-sess-own', realProject.id, 'tool-explicit');
    const r = await runWithContext(
      ctxFor({
        token: pinned,
        scope: `read:project:${realProject.id}`,
        requestedSlug: null,
        mcpSessionId: 'mcp-sess-own',
      }),
      () =>
        Promise.resolve(
          memoryHandlers().save({ scope: 'project', type: 'user', title: 't', content: 'c' }),
        ),
    );
    const { isError, body } = decode(r);
    expect(isError).toBe(true);
    expect(body.code).toBe('forbidden');
    expect(body.message as string).not.toContain('project.use');
  });

  // Third control: on a path-scoped connection `project.use({slug})` is rejected
  // whenever the slug differs from the path slug (`project-tools.ts`), so the
  // hint would name a remedy this caller cannot reach.
  it('a pinned token denied a read on a path-scoped connection is not told to call project.use', async () => {
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
    expect(body.message as string).not.toContain('project.use');
  });
});

/**
 * Enumerated rather than grepped: the table is checked against the tool list
 * the SDK actually advertises, so a tool registered later fails this test
 * instead of silently inheriting a scope fallback.
 */
const MINIMAL_ARGS: Record<string, Record<string, unknown>> = {
  'memory.save': { scope: 'project', type: 'user', title: 't', content: 'c' },
  'memory.search': {},
  'memory.get': { id: 'placeholder' },
  'memory.confirm': { id: 'placeholder' },
  'memory.archive': { id: 'placeholder' },
  'memory.session_start': {},
  'memory.session_end': {},
  'memory.session_summary': { summary: 's' },
  'memory.context': {},
  'memory.session_get': { sessionId: 'placeholder' },
  'memory.timeline': { memoryId: 'placeholder' },
  'memory.capture_passive': { text: '## Key Learnings\n\n1. one learning' },
  'memory.save_prompt': { content: 'c', title: 't' },
  'memory.search_prompts': {},
  'memory.doctor': {},
  'memory.stats': {},
  'memory.suggest_topic_key': { type: 'user', title: 't' },
  'memory.judge': { judgmentId: 'placeholder', relation: 'related' },
  'memory.compare': {
    memoryIdA: 'a',
    memoryIdB: 'b',
    relation: 'related',
    confidence: 0.5,
  },
};

/**
 * The recovery path. These four never resolve a scope, which is what keeps an
 * unresolvable connection repairable from inside the session. `project.use`
 * needs `autocreate` because minting the missing project is the repair — it
 * returns `project_not_found` without it, from its own lookup rather than from
 * the resolver.
 */
const EXEMPT: Record<string, Record<string, unknown>> = {
  'memory.about': {},
  'project.use': { slug: UNRESOLVABLE, autocreate: true },
  'project.list': {},
  'project.current': {},
};

describe('every registered scope-sensitive tool refuses an unresolvable slug', () => {
  let client: Client;

  beforeEach(async () => {
    const server = createMcpServer({
      memory,
      projects,
      agentSessions,
      prompts,
      relations,
      candidates: { perSaveMax: 5 },
      router,
      repos,
      doctor: () => DOCTOR,
      requestedSlug: UNRESOLVABLE,
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
    const result = await runWithContext(ctxFor(), () =>
      client.callTool({ name, arguments: EXEMPT[name] ?? {} }),
    );
    expect(decode(result).isError).toBe(false);
  });
});
