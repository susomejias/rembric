import { z } from 'zod';

import { getRequestContext } from '../server/request-context.js';
import { DomainError } from '../services/errors.js';
import type { MemoryService, SaveMemoryInput, SearchMemoriesInput } from '../services/memory.js';
import { isAuthorized } from '../services/tokens.js';

import { mcpError } from './errors.js';

/**
 * Tool handlers backing the four MCP tools. Validation of arguments is
 * performed by the SDK against the zod schemas declared below; these
 * handlers focus on domain dispatch and authorization.
 *
 * Each handler:
 *   1. Reads the per-request context (token + project) via AsyncLocalStorage.
 *   2. Enforces token scope vs. requested action and target.
 *   3. Calls the corresponding `MemoryService` method.
 *   4. Wraps known `DomainError`s into MCP-shaped error responses.
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
  includeGlobal: z.boolean().optional(),
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

type Json = string;

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

  // Strict path scoping: when the connection is bound to a project (via
  // `/mcp/<slug>` or the X-Rembric-Project header), the contract is hard:
  // every write goes to that project and global writes are rejected.
  if (ctx.project && args.scope === 'global') {
    return mcpError(
      'scope_locked',
      `This MCP connection is path-scoped to project '${ctx.project.path}'. ` +
        'Global writes are not permitted on this connection. To save a ' +
        "user-wide memory, open a separate MCP connection at '/mcp' (no " +
        'project slug) with the same token.',
    );
  }

  if (args.scope === 'project' && !ctx.project) {
    return mcpError(
      'project_required',
      'This MCP server is registered without a project scope. To save a project memory, either: ' +
        "(a) reconnect the MCP server at '/mcp/<your-project-slug>' (recommended for per-project setups), " +
        "(b) pass an 'X-Rembric-Project: <slug>' header, " +
        "or (c) set scope='global' to save this as a user-wide memory instead.",
    );
  }

  // When path-scoped, force project regardless of what the agent asked for.
  // The defensive branch above already handled scope='global' explicitly;
  // any other input is normalised here.
  const effectiveScope: 'global' | 'project' = ctx.project ? 'project' : args.scope;
  const target = {
    scope: effectiveScope,
    projectId: effectiveScope === 'project' ? (ctx.project?.id ?? null) : null,
  };
  if (!isAuthorized(ctx.scope, 'write', target)) {
    return mcpError(
      'forbidden',
      `token scope '${ctx.scope}' cannot write ${effectiveScope} memories`,
    );
  }

  const input: SaveMemoryInput = {
    scope: effectiveScope,
    projectId: target.projectId,
    type: args.type,
    content: args.content,
    tags: args.tags,
    source: {
      tokenName: ctx.token.name,
    },
  };

  try {
    const memory = deps.memory.save(input);
    return ok({ id: memory.id, status: memory.status, createdAt: memory.createdAt });
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
    includeGlobal?: boolean;
    limit?: number;
    offset?: number;
  },
) {
  const ctx = getRequestContext();
  const scope: 'global' | 'project' = ctx.project ? 'project' : 'global';
  const target = {
    scope,
    projectId: ctx.project?.id ?? null,
  };

  if (!isAuthorized(ctx.scope, 'read', target)) {
    return mcpError('forbidden', `token scope '${ctx.scope}' cannot read ${scope} memories`);
  }

  // Strict path scoping: when the connection is path-bound to a project,
  // searches NEVER leak global memories. The `includeGlobal` argument is
  // honoured only on unscoped connections (/mcp without slug); there it
  // is moot because the scope is already global.
  const input: SearchMemoriesInput = {
    scope,
    projectId: target.projectId,
    includeGlobal: ctx.project ? false : (args.includeGlobal ?? false),
    query: args.query,
    type: args.type,
    tag: args.tag,
    status: args.status,
    limit: args.limit,
    offset: args.offset,
  };

  try {
    const memories = deps.memory.search(input);
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
  try {
    const result = deps.memory.getWithHistory(args.id);
    if (!result) {
      return mcpError('not_found', `memory '${args.id}' not found`);
    }

    // Strict path scoping: when the connection is bound to a project,
    // memories outside that project (globals or other projects) are
    // invisible — return not_found so callers cannot probe existence.
    if (ctx.project) {
      const m = result.memory;
      if (m.scope !== 'project' || m.projectId !== ctx.project.id) {
        return mcpError('not_found', `memory '${args.id}' not found`);
      }
    }

    const target = {
      scope: result.memory.scope,
      projectId: result.memory.projectId,
    };
    if (!isAuthorized(ctx.scope, 'read', target)) {
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
  try {
    const memory = deps.memory.getById(args.id);
    if (!memory) {
      return mcpError('not_found', `memory '${args.id}' not found`);
    }
    // Strict path scoping: confirming a memory outside the path-bound
    // project is treated as not_found, mirroring memory.get above.
    if (ctx.project) {
      if (memory.scope !== 'project' || memory.projectId !== ctx.project.id) {
        return mcpError('not_found', `memory '${args.id}' not found`);
      }
    }
    const target = {
      scope: memory.scope,
      projectId: memory.projectId,
    };
    if (!isAuthorized(ctx.scope, 'write', target)) {
      return mcpError('forbidden', `token scope '${ctx.scope}' cannot confirm this memory`);
    }
    deps.memory.confirm(args.id, { tokenName: ctx.token.name });
    return ok({ ok: true });
  } catch (err) {
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

// Maintained for future inspection of the Json brand.
void (null as unknown as Json);
