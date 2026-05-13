import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Project } from '../db/schema/projects.js';
import type { Token } from '../db/schema/tokens.js';
import { runWithContext, type RequestContext } from '../server/request-context.js';
import { MemoryService } from '../services/memory.js';
import { ProjectsService } from '../services/projects.js';
import type { TokenScope } from '../services/tokens.js';
import { createTestDb, type TestDb } from '../test/index.js';

import { buildHandlers } from './tools.js';

/**
 * Strict path-scoping contract:
 *
 *   When the MCP connection is bound to a project (via `/mcp/<slug>` or
 *   the X-Rembric-Project header), every operation is locked to that
 *   project. Globals and other projects are invisible.
 *
 *   memory.save  scope='global'           → mcpError code 'scope_locked'
 *   memory.search                          → never returns globals
 *   memory.get / .confirm  cross-scope id  → mcpError code 'not_found'
 *
 *   When the connection is unscoped (/mcp without slug):
 *
 *   memory.save  scope='project'  (no header)  → 'project_required'
 *   memory.search                                → globals only
 *   memory.get / .confirm                        → existing token-scope checks
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
  return { token, scope: ADMIN_TOKEN_SCOPE, project };
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

  projectA = projects.findOrCreate('test-rembric');
  projectB = projects.findOrCreate('other-project');
});

afterEach(() => {
  db.cleanup();
});

describe('memory.save — strict path scoping', () => {
  it("rejects scope='global' on a path-scoped connection with code 'scope_locked'", () => {
    const resp = runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        handlers.save({ scope: 'global', type: 'user', content: 'developer of full-stack' }),
      ),
    );
    return resp.then((r) => {
      expect(isErrorResponse(r)).toBe(true);
      const payload = parseText<{ code: string; message: string }>(r);
      expect(payload.code).toBe('scope_locked');
      expect(payload.message).toContain('test-rembric');
    });
  });

  it("rejects scope='project' on an unscoped connection with code 'project_required'", async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(handlers.save({ scope: 'project', type: 'user', content: 'x' })),
    );
    expect(isErrorResponse(r)).toBe(true);
    expect(parseText<{ code: string }>(r).code).toBe('project_required');
  });

  it('saves under the bound project regardless of the input scope', async () => {
    // Even though the agent (hypothetically) sends scope=project, the
    // resulting row must carry the path-bound project_id.
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(
        handlers.save({ scope: 'project', type: 'user', content: 'prefers pnpm', tags: [] }),
      ),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.getById(id);
    expect(persisted?.scope).toBe('project');
    expect(persisted?.projectId).toBe(projectA.id);
  });

  it('on unscoped connections still saves globals normally', async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(handlers.save({ scope: 'global', type: 'user', content: 'dark mode' })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
    const { id } = parseText<{ id: string }>(r);
    const persisted = memory.getById(id);
    expect(persisted?.scope).toBe('global');
    expect(persisted?.projectId).toBeNull();
  });
});

describe('memory.search — strict path scoping', () => {
  beforeEach(() => {
    memory.save({ scope: 'global', type: 'user', content: 'global preference one' });
    memory.save({
      scope: 'project',
      projectId: projectA.id,
      type: 'user',
      content: 'project-A specific',
    });
    memory.save({
      scope: 'project',
      projectId: projectB.id,
      type: 'user',
      content: 'project-B specific',
    });
  });

  it('path-scoped: returns only memories in the bound project — no globals leak', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.search({})),
    );
    const { memories } = parseText<{ memories: { scope: string; projectId: string | null }[] }>(r);
    expect(memories.every((m) => m.scope === 'project' && m.projectId === projectA.id)).toBe(true);
    expect(memories.some((m) => m.scope === 'global')).toBe(false);
  });

  it('path-scoped: includeGlobal=true is ignored (cannot opt out of the lock)', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.search({ includeGlobal: true })),
    );
    const { memories } = parseText<{ memories: { scope: string }[] }>(r);
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
    globalId = memory.save({ scope: 'global', type: 'user', content: 'global' }).id;
    projectAId = memory.save({
      scope: 'project',
      projectId: projectA.id,
      type: 'user',
      content: 'A',
    }).id;
    projectBId = memory.save({
      scope: 'project',
      projectId: projectB.id,
      type: 'user',
      content: 'B',
    }).id;
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

  it('path-scoped: confirm(own-project id) → ok', async () => {
    const r = await runWithContext(fakeContext(projectA), () =>
      Promise.resolve(handlers.confirm({ id: projectAId })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
  });

  it('unscoped: get(global) → ok', async () => {
    const r = await runWithContext(fakeContext(null), () =>
      Promise.resolve(handlers.get({ id: globalId })),
    );
    expect(isErrorResponse(r)).toBeFalsy();
  });
});
