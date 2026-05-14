import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Project } from '../db/schema/projects.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import { SCOPE_GLOBAL, projectScope } from '../services/scope.js';
import type { TokenScope } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { buildHandlers } from './tools.js';

/**
 * Strict path-scoping contract — see src/services/memory.ts and
 * src/services/scope.ts for the application-level RLS pattern this
 * encodes.
 */

let db: TestDb;
let projects: ProjectsService;
let memory: MemoryService;
let handlers: ReturnType<typeof buildHandlers>;
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
  projects = new ProjectsService(db.handle.db);
  memory = new MemoryService(db.handle.db);
  handlers = buildHandlers({ memory });
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
        handlers.save({ scope: 'global', type: 'user', content: 'developer of full-stack' }),
      ),
    );
    expect(isErrorResponse(r)).toBe(true);
    const payload = parseText<{ code: string; message: string }>(r);
    expect(payload.code).toBe('scope_locked');
    expect(payload.message).toContain('test-rembric');
  });

  it("rejects scope='project' on an unscoped connection with code 'project_required'", async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(handlers.save({ scope: 'project', type: 'user', content: 'x' })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('project_required');
  });

  it('saves under the bound project regardless of the input scope', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        handlers.save({ scope: 'project', type: 'user', content: 'prefers pnpm', tags: [] }),
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
      Promise.resolve(handlers.save({ scope: 'global', type: 'user', content: 'dark mode' })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.unsafeGetById(id);
    expect(persisted?.scope).toBe('global');
    expect(persisted?.projectId).toBeNull();
  });
});

describe('memory.search — strict path scoping', () => {
  beforeEach(() => {
    memory.save({ type: 'user', content: 'global preference one' }, SCOPE_GLOBAL);
    memory.save({ type: 'user', content: 'project-A specific' }, projectScope(projectA.id));
    memory.save({ type: 'user', content: 'project-B specific' }, projectScope(projectB.id));
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
    globalId = memory.save({ type: 'user', content: 'global' }, SCOPE_GLOBAL).id;
    projectAId = memory.save({ type: 'user', content: 'A' }, projectScope(projectA.id)).id;
    projectBId = memory.save({ type: 'user', content: 'B' }, projectScope(projectB.id)).id;
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
