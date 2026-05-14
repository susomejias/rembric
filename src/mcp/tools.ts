import { z } from 'zod';

import { getRequestContext } from '../server/request-context.js';
import { DomainError } from '../services/errors.js';
import type { MemoryService, SaveMemoryInput, SearchMemoriesInput } from '../services/memory.js';
import { type Scope, SCOPE_GLOBAL, projectScope } from '../services/scope.js';
import { isAuthorized } from '../services/tokens.js';

import { mcpError } from './errors.js';

/**
 * Tool handlers backing the four MCP tools.
 *
 * Scope resolution happens here once and is then threaded into every
 * service call. The service layer enforces the scope at the SQL level
 * (rows outside scope are invisible) so handlers cannot leak by mistake.
 *
 * Path-scoping contract (also asserted by tests):
 *
 *   /mcp/<slug>  → scope = project:<id>
 *     - memory.save scope='global'  →  mcpError 'scope_locked'
 *     - memory.save scope='project' →  saved to that project
 *     - memory.search                →  only that project's memories
 *     - memory.get / .confirm        →  cross-scope ids are 'not_found'
 *
 *   /mcp  (no slug)            → scope = global
 *     - memory.save scope='project' →  mcpError 'project_required'
 *     - memory.save scope='global'  →  saved as user-wide
 *     - memory.search                →  globals only
 *     - memory.get / .confirm        →  project ids are 'not_found'
 */

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
const MEMORY_SCOPES = ['global', 'project'] as const;
const MEMORY_STATUSES = ['active', 'superseded', 'archived'] as const;

export const memorySaveSchema = {
  scope: z.enum(MEMORY_SCOPES).default('project'),
  type: z.enum(MEMORY_TYPES),
  content: z.string().min(1),
  tags: z.array(z.string()).max(64).optional(),
};

export const memorySearchSchema = {
  query: z.string().optional(),
  type: z.enum(MEMORY_TYPES).optional(),
  tag: z.string().optional(),
  status: z.enum(MEMORY_STATUSES).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
};

export const memoryGetSchema = {
  id: z.string().min(1),
};

export const memoryConfirmSchema = {
  id: z.string().min(1),
};

export interface ToolDeps {
  memory: MemoryService;
}

export function buildHandlers(deps: ToolDeps) {
  return {
    save: handleSave.bind(null, deps),
    search: handleSearch.bind(null, deps),
    get: handleGet.bind(null, deps),
    confirm: handleConfirm.bind(null, deps),
  };
}

function ok(payload: unknown) {
  return {
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

/** Translate the request context into the scope to operate under. */
function scopeFromContext(): Scope {
  const ctx = getRequestContext();
  return ctx.project ? projectScope(ctx.project.id) : SCOPE_GLOBAL;
}

function handleSave(
  deps: ToolDeps,
  args: {
    scope: 'global' | 'project';
    type: (typeof MEMORY_TYPES)[number];
    content: string;
    tags?: string[];
  },
) {
  const ctx = getRequestContext();

  // Path-scoped connections forbid global writes. "Path-scoped" means the
  // URL carried a slug (`requestedSlug` is non-null), regardless of whether
  // the slug resolved to an existing project.
  if (ctx.requestedSlug && args.scope === 'global') {
    return mcpError(
      'scope_locked',
      `This MCP connection is path-scoped to project '${ctx.requestedSlug}'. ` +
        'Global writes are not permitted on this connection. To save a ' +
        "user-wide memory, open a separate MCP connection at '/mcp' (no " +
        'project slug) with the same token.',
    );
  }

  // Path-scoped to a slug that doesn't exist: writes need an existing project.
  if (ctx.requestedSlug && !ctx.project && args.scope === 'project') {
    return mcpError(
      'project_not_found',
      `project '${ctx.requestedSlug}' does not exist; create it from the dashboard or call project.use({slug, autocreate: true})`,
    );
  }

  // Unscoped connections cannot persist project memories without a target.
  if (!ctx.project && args.scope === 'project') {
    return mcpError(
      'project_required',
      'This MCP connection has no active project. To save a project memory, either: ' +
        "(a) reconnect at '/mcp/<your-project-slug>' (recommended for per-project setups), " +
        '(b) call project.use({slug}) to set a project for this session, ' +
        "or (c) set scope='global' to save as a user-wide memory instead.",
    );
  }

  const scope: Scope = ctx.project ? projectScope(ctx.project.id) : SCOPE_GLOBAL;
  const authzTarget = {
    scope: scope.kind,
    projectId: scope.kind === 'project' ? scope.projectId : null,
    projectSlug: ctx.project?.slug ?? null,
  } as const;
  if (!isAuthorized(ctx.scope, 'write', authzTarget)) {
    return mcpError('forbidden', `token scope '${ctx.scope}' cannot write ${scope.kind} memories`);
  }

  const input: SaveMemoryInput = {
    type: args.type,
    content: args.content,
    tags: args.tags,
    source: { tokenName: ctx.token.name },
  };

  try {
    const m = deps.memory.save(input, scope);
    return ok({ id: m.id, status: m.status, createdAt: m.createdAt });
  } catch (err) {
    return errToMcp(err);
  }
}

function handleSearch(
  deps: ToolDeps,
  args: {
    query?: string;
    type?: (typeof MEMORY_TYPES)[number];
    tag?: string;
    status?: (typeof MEMORY_STATUSES)[number];
    limit?: number;
    offset?: number;
  },
) {
  const ctx = getRequestContext();
  const scope = scopeFromContext();

  const authzTarget = {
    scope: scope.kind,
    projectId: scope.kind === 'project' ? scope.projectId : null,
    projectSlug: ctx.project?.slug ?? null,
  } as const;
  if (!isAuthorized(ctx.scope, 'read', authzTarget)) {
    return mcpError('forbidden', `token scope '${ctx.scope}' cannot read ${scope.kind} memories`);
  }

  const input: SearchMemoriesInput = {
    query: args.query,
    type: args.type,
    tag: args.tag,
    status: args.status,
    limit: args.limit,
    offset: args.offset,
  };

  try {
    const memories = deps.memory.search(input, scope);
    return ok({
      count: memories.length,
      memories: memories.map((m) => ({
        id: m.id,
        scope: m.scope,
        projectId: m.projectId,
        type: m.type,
        content: m.content,
        tags: m.tags,
        status: m.status,
        createdAt: m.createdAt,
        lastSeenAt: m.lastSeenAt,
      })),
    });
  } catch (err) {
    return errToMcp(err);
  }
}

function handleGet(deps: ToolDeps, args: { id: string }) {
  const ctx = getRequestContext();
  const scope = scopeFromContext();
  try {
    const result = deps.memory.get(args.id, scope);
    if (!result) {
      return mcpError('not_found', `memory '${args.id}' not found`);
    }
    const authzTarget = {
      scope: result.memory.scope,
      projectId: result.memory.projectId,
      projectSlug: ctx.project?.slug ?? null,
    } as const;
    if (!isAuthorized(ctx.scope, 'read', authzTarget)) {
      return mcpError('forbidden', `token scope '${ctx.scope}' cannot read this memory`);
    }
    return ok({
      memory: {
        id: result.memory.id,
        scope: result.memory.scope,
        projectId: result.memory.projectId,
        type: result.memory.type,
        content: result.memory.content,
        tags: result.memory.tags,
        status: result.memory.status,
        replaces: result.memory.replaces,
        createdAt: result.memory.createdAt,
      },
      head: {
        id: result.head.id,
        content: result.head.content,
        status: result.head.status,
      },
      predecessors: result.predecessors.map((p) => ({
        id: p.id,
        content: p.content,
        status: p.status,
        createdAt: p.createdAt,
      })),
      confirmationCount: result.confirmationCount,
    });
  } catch (err) {
    return errToMcp(err);
  }
}

function handleConfirm(deps: ToolDeps, args: { id: string }) {
  const ctx = getRequestContext();
  const scope = scopeFromContext();
  try {
    const authzTarget = {
      scope: scope.kind,
      projectId: scope.kind === 'project' ? scope.projectId : null,
      projectSlug: ctx.project?.slug ?? null,
    } as const;
    if (!isAuthorized(ctx.scope, 'write', authzTarget)) {
      return mcpError('forbidden', `token scope '${ctx.scope}' cannot confirm in this scope`);
    }
    deps.memory.confirm(args.id, scope, { tokenName: ctx.token.name });
    return ok({ ok: true });
  } catch (err) {
    if (err instanceof DomainError && err.code === 'memory_not_found') {
      return mcpError('not_found', `memory '${args.id}' not found`);
    }
    return errToMcp(err);
  }
}

function errToMcp(err: unknown) {
  if (err instanceof DomainError) {
    return mcpError(err.code, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return mcpError('internal_error', message);
}
