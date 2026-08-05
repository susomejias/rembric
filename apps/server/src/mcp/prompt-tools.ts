import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { getRequestContext } from '../server/request-context.js';
import type { SessionRouter } from '../server/session-router.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import type { ProjectsService } from '../services/projects.js';
import { type PromptsService } from '../services/prompts.js';
import type { Scope } from '../services/scope.js';

import {
  assertAuthorized,
  assertExplicitSessionOwned,
  requireScope,
  resolveEffectiveScope,
  resolveSessionId,
} from './_shared.js';
import { errToMcp } from './errors.js';
import { ok } from './result.js';

/**
 * Curated-prompt MCP tools: save_prompt / search_prompts.
 */

export const savePromptSchema = {
  content: z.string().min(1).max(20_000),
  title: z.string().min(1).max(100),
  tags: z.array(z.string().min(1)).optional(),
  replaces: z.string().min(1).optional(),
  sessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Pass this if you know your current session id (your host may surface it) to guarantee correct attachment when multiple sessions could be active. Never invent one — omit if unknown.',
    ),
};

export const searchPromptsSchema = {
  query: z.string().optional(),
  sessionId: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  includeDeleted: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
};

const promptRow = z.object({
  id: z.string(),
  content: z.string(),
  title: z.string(),
  tags: z.array(z.string()).nullable(),
  sessionId: z.string().nullable(),
  projectId: z.string().nullable(),
  agent: z.string().nullable(),
  replaces: z.array(z.string()).nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
});

export const savePromptOutput = {
  ok: z.literal(true),
  id: z.string(),
  createdAt: z.string(),
  replaces: z.array(z.string()).optional(),
};

export const searchPromptsOutput = {
  scope: z.string(),
  prompts: z.array(promptRow),
  total: z.number(),
};

export interface PromptToolDeps {
  prompts: PromptsService;
  agentSessions: AgentSessionsService;
  router: SessionRouter;
  projects: ProjectsService;
  /** Set by `createMcpServer` after construction to enable roots discovery. */
  getServer?: () => McpServer;
}

export function buildPromptHandlers(deps: PromptToolDeps) {
  return {
    savePrompt: handleSavePrompt.bind(null, deps),
    searchPrompts: handleSearchPrompts.bind(null, deps),
  };
}

async function handleSavePrompt(
  deps: PromptToolDeps,
  args: {
    content: string;
    title: string;
    tags?: string[];
    replaces?: string;
    sessionId?: string;
  },
) {
  const ctx = getRequestContext();
  let scope: Scope;
  try {
    scope = (await resolveEffectiveScope(deps)).scope;
    assertAuthorized('write', scope, deps);
  } catch (err) {
    return errToMcp(err);
  }
  const promptProjectId = scope.projectId;
  let sessionId: string | null;
  try {
    if (args.sessionId)
      assertExplicitSessionOwned(deps.agentSessions, args.sessionId, promptProjectId);
    sessionId = resolveSessionId(deps, args.sessionId, promptProjectId);
  } catch (err) {
    return errToMcp(err);
  }
  try {
    const row = deps.prompts.save({
      content: args.content,
      sessionId,
      projectId: scope.projectId,
      agent: ctx.token.name,
      title: args.title,
      tags: args.tags ?? null,
      replaces: args.replaces ?? null,
    });
    const response: {
      ok: true;
      id: string;
      createdAt: Date;
      replaces?: string[];
    } = { ok: true, id: row.id, createdAt: row.createdAt };
    if (row.replaces && row.replaces.length > 0) {
      response.replaces = row.replaces;
    }
    return ok(response);
  } catch (err) {
    return errToMcp(err);
  }
}

async function handleSearchPrompts(
  deps: PromptToolDeps,
  args: {
    query?: string;
    sessionId?: string;
    agent?: string;
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  },
) {
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'read');
  } catch (err) {
    return errToMcp(err);
  }
  try {
    const result = deps.prompts.searchByScope({
      scope,
      query: args.query,
      sessionId: args.sessionId,
      agent: args.agent,
      includeDeleted: args.includeDeleted,
      limit: args.limit,
      offset: args.offset,
    });
    return ok({
      scope: scope.kind === 'project' ? `project:${scope.projectId}` : 'global',
      prompts: result.prompts.map((p) => ({
        id: p.id,
        content: p.content,
        title: p.title,
        tags: p.tags,
        sessionId: p.sessionId,
        projectId: p.projectId,
        agent: p.agent,
        replaces: p.replaces,
        deletedAt: p.deletedAt,
        createdAt: p.createdAt,
      })),
      total: result.total,
    });
  } catch (err) {
    return errToMcp(err);
  }
}
