import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Repositories } from '../db/repositories/index.js';
import type { MemoryScope, MemoryStatus, MemoryType } from '../db/schema/memory.js';
import { getRequestContext } from '../server/request-context.js';
import type { SessionRouter } from '../server/session-router.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import { DomainError } from '../services/errors.js';
import type { MemoryService, SaveMemoryInput, SearchMemoriesInput } from '../services/memory.js';
import type { ProjectsService } from '../services/projects.js';
import type { RelationsService } from '../services/relations.js';
import { findSaveTimeCandidates, type CandidateOptions } from '../services/save-time-candidates.js';
import { type Scope, SCOPE_GLOBAL, projectScope } from '../services/scope.js';
import { isAuthorized } from '../services/tokens.js';

import { mcpError } from './errors.js';
import { pendingSuggestionGate, suggestionPendingMessage } from './project-suggestion-gate.js';
import { ok } from './result.js';
import { ensureRootsDiscoveryRun } from './roots-discovery.js';

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
 *   /mcp  (no slug)            → scope = global (unless `project.use` ran)
 *     - memory.save scope='project' →  mcpError 'project_required'
 *                                     (unless `project.use` activated one
 *                                      for this transport — see
 *                                      `resolveEffectiveProject`)
 *     - memory.save scope='global'  →  saved as user-wide
 *     - memory.search                →  globals only (or the active project
 *                                       set via `project.use`)
 *     - memory.get / .confirm        →  project ids are 'not_found' (idem)
 */

const MEMORY_TYPES = ['user', 'feedback', 'project', 'reference'] as const;
const MEMORY_SCOPES = ['global', 'project'] as const;
const MEMORY_STATUSES = ['active', 'superseded', 'archived'] as const;

export const memorySaveSchema = {
  scope: z.enum(MEMORY_SCOPES).default('project'),
  type: z.enum(MEMORY_TYPES),
  content: z.string().min(1),
  tags: z.array(z.string()).max(64).optional(),
  topic_key: z.string().min(1).max(128).optional(),
};

export const memorySearchSchema = {
  query: z.string().optional(),
  type: z.enum(MEMORY_TYPES).optional(),
  tag: z.string().optional(),
  status: z.enum(MEMORY_STATUSES).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Max results (default 8). Raise it (up to 200) when 8 are all relevant and you need more.',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      'Skip this many results for paging. Exact for the no-query listing; on a text query it is best-effort within a bounded relevance window, so a deep offset may return an empty page.',
    ),
};

export const memoryGetSchema = {
  id: z.string().min(1),
};

export const memoryConfirmSchema = {
  id: z.string().min(1),
};

const relationView = z.object({
  kind: z.string(),
  targetId: z.string(),
  judgmentId: z.string().optional(),
  status: z.string(),
  reason: z.string().nullable().optional(),
  confidence: z.number().nullable().optional(),
});

const candidate = z.object({
  judgmentId: z.string(),
  targetId: z.string(),
  snippet: z.string(),
  similarity: z.number(),
  source: z.string(),
});

const memoryRow = z.object({
  id: z.string(),
  scope: z.string(),
  projectId: z.string().nullable(),
  type: z.string(),
  content: z.string(),
  tags: z.array(z.string()),
  status: z.string(),
  createdAt: z.string(),
  lastSeenAt: z.string().nullable(),
  relations: z.array(relationView),
  reviewState: z.string().optional(),
  reviewAfter: z.string().nullable().optional(),
});

export const memorySaveOutput = {
  id: z.string(),
  status: z.string(),
  createdAt: z.string(),
  candidates: z.array(candidate),
  judgmentRequired: z.boolean(),
};

export const memorySearchOutput = {
  count: z.number(),
  memories: z.array(memoryRow),
};

export const memoryGetOutput = {
  memory: z.object({
    id: z.string(),
    scope: z.string(),
    projectId: z.string().nullable(),
    type: z.string(),
    content: z.string(),
    tags: z.array(z.string()),
    status: z.string(),
    replaces: z.array(z.string()),
    createdAt: z.string(),
  }),
  head: z.object({ id: z.string(), content: z.string(), status: z.string() }),
  predecessors: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      status: z.string(),
      createdAt: z.string(),
    }),
  ),
  confirmationCount: z.number(),
  relations: z.array(relationView),
  reviewState: z.string().optional(),
  reviewAfter: z.string().nullable().optional(),
};

export const memoryConfirmOutput = {
  ok: z.literal(true),
};

export interface ToolDeps {
  memory: MemoryService;
  /** Optional — when present, save surfaces candidates + writes pending relations. */
  relations?: RelationsService;
  /** Optional — when present, controls candidate detection thresholds. */
  candidates?: CandidateOptions;
  /** Optional — repositories needed for save-time candidate queries. */
  repos?: Pick<Repositories, 'memory' | 'vectors'>;
  /**
   * Optional — embeds the just-saved row inline so vec candidate
   * detection has a self-vector to kNN from.
   */
  embedNow?: (
    memoryId: string,
    content: string,
    scope: MemoryScope,
    projectId: string | null,
    status: MemoryStatus,
    type: MemoryType,
  ) => Promise<boolean>;
  /** Optional — required to evaluate the project-suggestion gate on save. */
  router?: SessionRouter;
  /** Optional — required to evaluate the project-suggestion gate on save. */
  projects?: ProjectsService;
  /**
   * Optional — when present, `memory.save` attaches the most-recently-
   * active session row for `(tokenId, projectId)` to the memory when the
   * SessionRouter has no entry. This is the bridge that makes
   * HTTP-driven sessions (the plugin's hooks POSTing `/api/<slug>/sessions`)
   * show up as `memory.session_id` on subsequent MCP-side saves.
   */
  agentSessions?: AgentSessionsService;
  /**
   * Optional — provides access to the active `McpServer` so handlers can
   * await (or trigger) roots discovery when no project is resolved yet.
   * Set by `createMcpServer` after construction.
   */
  getServer?: () => McpServer;
}

export function buildHandlers(deps: ToolDeps) {
  return {
    save: handleSave.bind(null, deps),
    search: handleSearch.bind(null, deps),
    get: handleGet.bind(null, deps),
    confirm: handleConfirm.bind(null, deps),
  };
}

/**
 * Resolve the project that subsequent operations should target.
 *
 * Sources, in order of precedence:
 *   1. `ctx.project` — set by the HTTP layer when the URL was `/mcp/<slug>`
 *      and the slug resolved to an existing project.
 *   2. `SessionRouter` entry — set by an explicit `project.use({slug})` or
 *      by roots-based discovery on a path-less `/mcp` connection.
 *
 * Before consulting source #2 on an unscoped connection, this helper
 * awaits any in-flight roots discovery (or triggers it lazily as a
 * fallback for clients that never emit `notifications/initialized`) so
 * the router is populated by the time we read it. Path-scoped
 * connections short-circuit on `ctx.requestedSlug`.
 */
async function resolveEffectiveProject(
  deps: ToolDeps,
): Promise<{ id: string; slug: string } | null> {
  const ctx = getRequestContext();
  if (ctx.project) return ctx.project;
  if (ctx.requestedSlug !== null) return null;
  if (!ctx.mcpSessionId || !deps.router || !deps.projects) return null;
  if (deps.getServer) {
    await ensureRootsDiscoveryRun(
      { server: deps.getServer(), router: deps.router, projects: deps.projects },
      { tokenId: ctx.token.id, mcpSessionId: ctx.mcpSessionId, pathSlug: ctx.requestedSlug },
    );
  }
  const entry = deps.router.get(ctx.token.id, ctx.mcpSessionId);
  if (!entry?.projectId) return null;
  return deps.projects.getById(entry.projectId) ?? null;
}

/**
 * Resolve the active Rembric session id for a memory write.
 *
 * Sources, in order of precedence:
 *   1. The `SessionRouter` entry for `(tokenId, mcpSessionId)` — set by
 *      an explicit `memory.session_start` call over MCP.
 *   2. The most recently-started `status='active'` row for `(tokenId,
 *      projectId)` — captures sessions created out-of-band by the plugin's
 *      HTTP hooks (`POST /api/<slug>/sessions`).
 *
 * Returns null when no active session can be resolved (the memory is
 * saved with `session_id = NULL`, the back-compat path for clients that
 * neither run the plugin nor call `memory.session_start`).
 */
function resolveActiveSessionId(deps: ToolDeps, projectId: string | null): string | null {
  const ctx = getRequestContext();
  if (ctx.mcpSessionId && deps.router) {
    const entry = deps.router.get(ctx.token.id, ctx.mcpSessionId);
    if (entry?.rembricSessionId) return entry.rembricSessionId;
  }
  if (deps.agentSessions) {
    const row = deps.agentSessions.findActiveForTransport({
      tokenId: ctx.token.id,
      projectId,
    });
    if (row) return row.id;
  }
  return null;
}

async function handleSave(
  deps: ToolDeps,
  args: {
    scope: 'global' | 'project';
    type: (typeof MEMORY_TYPES)[number];
    content: string;
    tags?: string[];
    topic_key?: string;
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

  // Pick up the project the agent already activated via `project.use` on
  // this transport (or that roots discovery activated), in addition to the
  // URL-derived `ctx.project`. Mirrors the precedence used by
  // `handleSessionStart` and `project.current`.
  const activeProject = await resolveEffectiveProject(deps);

  // When roots-based discovery surfaced suggestions the agent has not yet
  // acted on, refuse the silent fallback to global. The agent must either
  // pass scope='global' explicitly, or call project.use({slug, autocreate}).
  if (!activeProject && args.scope === 'project' && deps.router && deps.projects) {
    const pending = pendingSuggestionGate(ctx, { router: deps.router, projects: deps.projects });
    if (pending) {
      return mcpError('project_suggestion_pending', suggestionPendingMessage(), {
        suggestedSlugs: pending,
      });
    }
  }

  // Unscoped connections cannot persist project memories without a target.
  if (!activeProject && args.scope === 'project') {
    return mcpError(
      'project_required',
      'This MCP connection has no active project. To save a project memory, either: ' +
        "(a) reconnect at '/mcp/<your-project-slug>' (recommended for per-project setups), " +
        '(b) call project.use({slug}) to set a project for this session, ' +
        "or (c) set scope='global' to save as a user-wide memory instead.",
    );
  }

  const scope: Scope = activeProject ? projectScope(activeProject.id) : SCOPE_GLOBAL;
  const authzTarget = {
    scope: scope.kind,
    projectId: scope.kind === 'project' ? scope.projectId : null,
    projectSlug: activeProject?.slug ?? null,
  } as const;
  if (!isAuthorized(ctx.scope, 'write', authzTarget)) {
    return mcpError('forbidden', `token scope '${ctx.scope}' cannot write ${scope.kind} memories`);
  }

  const resolvedSessionId = resolveActiveSessionId(
    deps,
    scope.kind === 'project' ? scope.projectId : null,
  );
  const input: SaveMemoryInput = {
    type: args.type,
    content: args.content,
    tags: args.tags,
    source: {
      tokenName: ctx.token.name,
      ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
    },
    sessionId: resolvedSessionId,
    topicKey: args.topic_key ?? null,
  };

  try {
    const { memory: m, supersededByTopicKey } = deps.memory.saveWithTopicKey(input, scope);

    // If the topic_key upsert path fired, record the auto-judged
    // 'supersedes' relation so the search annotations and the dashboard
    // can show provenance.
    if (supersededByTopicKey && deps.relations) {
      try {
        deps.relations.compare({
          sourceId: m.id,
          targetId: supersededByTopicKey.id,
          relation: 'supersedes',
          reason: `topic_key='${args.topic_key}' upsert`,
          confidence: 1.0,
          actor: ctx.token.name,
          kind: 'agent_topic_key',
        });
      } catch {
        // Topic-key relation logging is best-effort. The supersede side
        // effect on the memory row already happened atomically in
        // saveWithTopicKey; failing to record the audit row should not
        // fail the save itself.
      }
    }

    // Save-time candidate detection: surface up to N similar active
    // memories so the agent can judge them while the context is fresh.
    let candidates: {
      judgmentId: string;
      targetId: string;
      snippet: string;
      similarity: number;
      source: 'vec' | 'fts';
    }[] = [];
    if (deps.repos && deps.relations && deps.candidates && deps.candidates.perSaveMax > 0) {
      try {
        // Give the new row its vector before detection runs, so the vec
        // pass has a self-vector to kNN from (model is warm by boot
        // contract; on failure detection degrades to FTS5 for this save).
        if (deps.embedNow)
          await deps.embedNow(m.id, m.content, m.scope, m.projectId, m.status, m.type);
        const detected = findSaveTimeCandidates(deps.repos, m, deps.candidates);
        for (const c of detected) {
          // Skip the topic_key supersede target — we already wrote that relation.
          if (supersededByTopicKey && c.targetId === supersededByTopicKey.id) continue;
          const row = deps.relations.createPending({
            sourceId: m.id,
            targetId: c.targetId,
          });
          candidates.push({
            judgmentId: row.judgmentId,
            targetId: c.targetId,
            snippet: c.snippet,
            similarity: c.similarity,
            source: c.source,
          });
        }
      } catch {
        // Candidate detection is best-effort. A failure here (e.g. the
        // FTS5 query rejects an unusual token) must not prevent the
        // save from returning a usable response.
        candidates = [];
      }
    }

    return ok({
      id: m.id,
      status: m.status,
      createdAt: m.createdAt,
      candidates,
      judgmentRequired: candidates.length > 0,
    });
  } catch (err) {
    return errToMcp(err);
  }
}

async function handleSearch(
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
  const activeProject = await resolveEffectiveProject(deps);
  const scope: Scope = activeProject ? projectScope(activeProject.id) : SCOPE_GLOBAL;

  const authzTarget = {
    scope: scope.kind,
    projectId: scope.kind === 'project' ? scope.projectId : null,
    projectSlug: activeProject?.slug ?? null,
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
    const memories = await deps.memory.search(input, scope);
    // Single JOIN against memory_relations — no N+1.
    const relations = deps.relations
      ? deps.relations.listForMemories(
          memories.map((m) => m.id),
          10,
        )
      : null;
    // Derived review metadata (batched confirmation lookup) — informational
    // only; never affects ordering or which rows are returned.
    const review = deps.memory.reviewStateForMemories(memories);
    return ok({
      count: memories.length,
      memories: memories.map((m) => {
        const r = review.get(m.id);
        return {
          id: m.id,
          scope: m.scope,
          projectId: m.projectId,
          type: m.type,
          content: m.content,
          tags: m.tags,
          status: m.status,
          createdAt: m.createdAt,
          lastSeenAt: m.lastSeenAt,
          relations: relations?.get(m.id) ?? [],
          ...(r && r.reviewState !== null
            ? { reviewState: r.reviewState, reviewAfter: r.reviewAfter ?? null }
            : {}),
        };
      }),
    });
  } catch (err) {
    return errToMcp(err);
  }
}

async function handleGet(deps: ToolDeps, args: { id: string }) {
  const ctx = getRequestContext();
  const activeProject = await resolveEffectiveProject(deps);
  const scope: Scope = activeProject ? projectScope(activeProject.id) : SCOPE_GLOBAL;
  try {
    const result = deps.memory.get(args.id, scope);
    if (!result) {
      return mcpError('not_found', `memory '${args.id}' not found`);
    }
    const authzTarget = {
      scope: result.memory.scope,
      projectId: result.memory.projectId,
      projectSlug: activeProject?.slug ?? null,
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
      relations: deps.relations ? deps.relations.listForMemory(result.memory.id, 50) : [],
      ...(result.reviewState !== null
        ? { reviewState: result.reviewState, reviewAfter: result.reviewAfter ?? null }
        : {}),
    });
  } catch (err) {
    return errToMcp(err);
  }
}

async function handleConfirm(deps: ToolDeps, args: { id: string }) {
  const ctx = getRequestContext();
  const activeProject = await resolveEffectiveProject(deps);
  const scope: Scope = activeProject ? projectScope(activeProject.id) : SCOPE_GLOBAL;
  try {
    const authzTarget = {
      scope: scope.kind,
      projectId: scope.kind === 'project' ? scope.projectId : null,
      projectSlug: activeProject?.slug ?? null,
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
