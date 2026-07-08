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
import type { PromptsService } from '../services/prompts.js';
import type { RelationsService } from '../services/relations.js';
import { findSaveTimeCandidates, type CandidateOptions } from '../services/save-time-candidates.js';
import type { Scope } from '../services/scope.js';

import {
  assertAuthorized,
  clamp,
  requireScope,
  resolveEffectiveScope,
  serializeMemory,
  snippet,
} from './_shared.js';
import { errToMcp, mcpError } from './errors.js';
import { pendingSuggestionGate, suggestionPendingMessage } from './project-suggestion-gate.js';
import { ok } from './result.js';

/**
 * Tool handlers backing the core memory tools: save / search / get / confirm
 * plus the memory-reading research tools context / timeline.
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
 *                                      `resolveEffectiveScope` in `_shared`)
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
  title: z.string().min(1).max(100),
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
  snippet: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Truncate each result's `content` to this many characters (ellipsis appended) so a broad triage scan stays cheap; omit for full content, then drill in with memory.get.",
    ),
  fields: z
    .array(z.string())
    .optional()
    .describe(
      'Restrict each result to these fields; identity fields (id, type, title) are always included. Omit for the full row.',
    ),
};

export const memoryGetSchema = {
  id: z
    .string()
    .min(1)
    .optional()
    .describe('A single memory id. Provide exactly one of `id` or `ids`.'),
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Batch: fetch several memories by id in one scoped call. Out-of-scope/unknown ids come back in `notFound`. Provide exactly one of `id` or `ids`.',
    ),
};

export const memoryConfirmSchema = {
  id: z
    .string()
    .min(1)
    .optional()
    .describe('A single memory id. Provide exactly one of `id` or `ids`.'),
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(100)
    .optional()
    .describe(
      'Batch re-affirm several memories in one call (e.g. all of memory.context.needsReview). Provide exactly one of `id` or `ids`.',
    ),
};

export const contextSchema = {
  sessions: z.number().int().min(0).max(25).optional(),
  prompts: z.number().int().min(0).max(50).optional(),
  memories: z.number().int().min(0).max(100).optional(),
  includeArchived: z.boolean().optional(),
};

export const timelineSchema = {
  memoryId: z.string().min(1),
  before: z.number().int().min(0).max(50).optional(),
  after: z.number().int().min(0).max(50).optional(),
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
  title: z.string(),
  snippet: z.string(),
  similarity: z.number(),
  source: z.string(),
});

const memoryRow = z.object({
  // Identity fields are always present; the rest MAY be omitted by the
  // `fields` projection, and `content` MAY be truncated by `snippet`.
  id: z.string(),
  type: z.string(),
  title: z.string(),
  scope: z.string().optional(),
  projectId: z.string().nullable().optional(),
  content: z.string().optional(),
  tags: z.array(z.string()).optional(),
  status: z.string().optional(),
  createdAt: z.string().optional(),
  lastSeenAt: z.string().nullable().optional(),
  relations: z.array(relationView).optional(),
  reviewState: z.string().optional(),
  reviewAfter: z.string().nullable().optional(),
});

const memoryNeighbor = z.object({
  id: z.string(),
  type: z.string(),
  title: z.string(),
  content: z.string(),
  status: z.string(),
  createdAt: z.string(),
  sessionId: z.string().nullable(),
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
  // Single-id response (when `id` is provided). Optional so the same tool can
  // also return the batch shape below (when `ids` is provided).
  memory: z
    .object({
      id: z.string(),
      scope: z.string(),
      projectId: z.string().nullable(),
      type: z.string(),
      title: z.string(),
      content: z.string(),
      tags: z.array(z.string()),
      status: z.string(),
      replaces: z.array(z.string()),
      createdAt: z.string(),
    })
    .optional(),
  head: z
    .object({ id: z.string(), title: z.string(), content: z.string(), status: z.string() })
    .optional(),
  predecessors: z
    .array(
      z.object({
        id: z.string(),
        title: z.string(),
        content: z.string(),
        status: z.string(),
        createdAt: z.string(),
      }),
    )
    .optional(),
  confirmationCount: z.number().optional(),
  relations: z.array(relationView).optional(),
  reviewState: z.string().optional(),
  reviewAfter: z.string().nullable().optional(),
  // Batch response (when `ids` is provided).
  memories: z.array(memoryRow).optional(),
  notFound: z.array(z.string()).optional(),
};

export const memoryConfirmOutput = {
  ok: z.literal(true),
  confirmed: z.number().optional(),
};

export const contextOutput = {
  scope: z.string(),
  recentSessions: z.array(
    z.object({
      id: z.string(),
      agent: z.string(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
      status: z.string(),
      title: z.string().nullable(),
      summary: z.string().nullable(),
    }),
  ),
  recentPrompts: z.array(
    z.object({
      id: z.string(),
      content: z.string(),
      agent: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  recentMemories: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      title: z.string(),
      snippet: z.string(),
      status: z.string(),
      createdAt: z.string(),
    }),
  ),
  pendingJudgments: z.array(
    z.object({
      judgmentId: z.string(),
      sourceId: z.string(),
      targetId: z.string(),
      sourceTitle: z.string(),
      targetTitle: z.string(),
      sourceSnippet: z.string(),
      targetSnippet: z.string(),
      ageMs: z.number(),
    }),
  ),
  needsReview: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      title: z.string(),
      snippet: z.string(),
      reviewAfter: z.string(),
      ageMs: z.number(),
    }),
  ),
  clamped: z.boolean(),
};

export const timelineOutput = {
  target: z.object({ id: z.string(), createdAt: z.string() }),
  before: z.array(memoryNeighbor),
  after: z.array(memoryNeighbor),
  fallback: z.string().nullable(),
};

export interface MemoryToolDeps {
  memory: MemoryService;
  /** Optional — when present, save surfaces candidates + writes pending relations. */
  relations?: RelationsService;
  /** Optional — when present, controls candidate detection thresholds. */
  candidates?: CandidateOptions;
  /** Optional — repositories needed for save-time candidates + context/timeline reads. */
  repos?: Pick<Repositories, 'memory' | 'relations' | 'vectors'>;
  /**
   * Optional — embeds the just-saved row inline so vec candidate
   * detection has a self-vector to kNN from.
   */
  embedNow?: (
    memoryId: string,
    title: string,
    content: string,
    scope: MemoryScope,
    projectId: string | null,
    status: MemoryStatus,
    type: MemoryType,
  ) => Promise<boolean>;
  /** Optional — required to evaluate the project-suggestion gate on save, and scope resolution for context/timeline. */
  router?: SessionRouter;
  /** Optional — required to evaluate the project-suggestion gate on save. */
  projects?: ProjectsService;
  /**
   * Optional — when present, `memory.save` attaches the most-recently-
   * active session row for `(tokenId, projectId)` to the memory when the
   * SessionRouter has no entry. This is the bridge that makes
   * HTTP-driven sessions (the plugin's hooks POSTing `/api/<slug>/sessions`)
   * show up as `memory.session_id` on subsequent MCP-side saves. Also used
   * by `memory.context` to surface recent sessions.
   */
  agentSessions?: AgentSessionsService;
  /** Optional — required by `memory.context` to surface recent prompts. */
  prompts?: PromptsService;
  /** Optional — pending relations older than this surface in `memory.context`. */
  orphanAfterMs?: number;
  /**
   * Optional — provides access to the active `McpServer` so handlers can
   * await (or trigger) roots discovery when no project is resolved yet.
   * Set by `createMcpServer` after construction.
   */
  getServer?: () => McpServer;
}

export function buildMemoryHandlers(deps: MemoryToolDeps) {
  return {
    save: handleSave.bind(null, deps),
    search: handleSearch.bind(null, deps),
    get: handleGet.bind(null, deps),
    confirm: handleConfirm.bind(null, deps),
    context: handleContext.bind(null, deps),
    timeline: handleTimeline.bind(null, deps),
  };
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
function resolveActiveSessionId(deps: MemoryToolDeps, projectId: string | null): string | null {
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
  deps: MemoryToolDeps,
  args: {
    scope: 'global' | 'project';
    type: (typeof MEMORY_TYPES)[number];
    title: string;
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
  const { scope, project: activeProject } = await resolveEffectiveScope(deps);

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

  try {
    assertAuthorized('write', scope);
  } catch (err) {
    return errToMcp(err);
  }

  const resolvedSessionId = resolveActiveSessionId(
    deps,
    scope.kind === 'project' ? scope.projectId : null,
  );
  const input: SaveMemoryInput = {
    type: args.type,
    title: args.title,
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
    // Archived projects reject new writes (projects spec, "Archiving a
    // project"). Enforced here rather than in resolveEffectiveScope so the
    // read paths (search/get) keep returning an archived project's memories.
    if (activeProject) deps.projects?.assertWritable(activeProject.id);

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
      title: string;
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
          await deps.embedNow(m.id, m.title, m.content, m.scope, m.projectId, m.status, m.type);
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
            title: c.title,
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
  deps: MemoryToolDeps,
  args: {
    query?: string;
    type?: (typeof MEMORY_TYPES)[number];
    tag?: string;
    status?: (typeof MEMORY_STATUSES)[number];
    limit?: number;
    offset?: number;
    snippet?: number;
    fields?: string[];
  },
) {
  const { scope } = await resolveEffectiveScope(deps);
  try {
    assertAuthorized('read', scope);
  } catch (err) {
    return errToMcp(err);
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
    // Optional projection (selection/ordering/scope are already final and are
    // never affected): truncate content to `snippet` chars, then keep only the
    // requested `fields` plus the always-present identity fields.
    const fieldSet =
      args.fields && args.fields.length > 0
        ? new Set<string>(['id', 'type', 'title', ...args.fields])
        : null;
    return ok({
      count: memories.length,
      memories: memories.map((m) => {
        const r = review.get(m.id);
        const full: Record<string, unknown> = {
          id: m.id,
          scope: m.scope,
          projectId: m.projectId,
          type: m.type,
          title: m.title,
          content: typeof args.snippet === 'number' ? snippet(m.content, args.snippet) : m.content,
          tags: m.tags,
          status: m.status,
          createdAt: m.createdAt,
          lastSeenAt: m.lastSeenAt,
          relations: relations?.get(m.id) ?? [],
          ...(r && r.reviewState !== null
            ? { reviewState: r.reviewState, reviewAfter: r.reviewAfter ?? null }
            : {}),
        };
        if (!fieldSet) return full;
        return Object.fromEntries(Object.entries(full).filter(([k]) => fieldSet.has(k)));
      }),
    });
  } catch (err) {
    return errToMcp(err);
  }
}

async function handleGet(deps: MemoryToolDeps, args: { id?: string; ids?: string[] }) {
  const { scope } = await resolveEffectiveScope(deps);

  const hasId = typeof args.id === 'string' && args.id.length > 0;
  const hasIds = Array.isArray(args.ids) && args.ids.length > 0;
  if (hasId === hasIds) {
    return mcpError('invalid_input', 'provide exactly one of `id` or `ids`');
  }

  try {
    assertAuthorized('read', scope);
    if (args.ids !== undefined) {
      // Batch: scoped + ordered; out-of-scope / unknown ids land in
      // `notFound` and never leak content.
      const rows = deps.memory.getMany(args.ids, scope);
      const relations = deps.relations
        ? deps.relations.listForMemories(
            rows.map((m) => m.id),
            10,
          )
        : null;
      const found = new Set(rows.map((m) => m.id));
      return ok({
        memories: rows.map((m) => ({
          id: m.id,
          scope: m.scope,
          projectId: m.projectId,
          type: m.type,
          title: m.title,
          content: m.content,
          tags: m.tags,
          status: m.status,
          createdAt: m.createdAt,
          lastSeenAt: m.lastSeenAt,
          relations: relations?.get(m.id) ?? [],
        })),
        notFound: args.ids.filter((id) => !found.has(id)),
      });
    }

    if (args.id === undefined) {
      return mcpError('invalid_input', 'provide exactly one of `id` or `ids`');
    }
    const result = deps.memory.get(args.id, scope);
    if (!result) {
      return mcpError('not_found', `memory '${args.id}' not found`);
    }
    return ok({
      memory: {
        id: result.memory.id,
        scope: result.memory.scope,
        projectId: result.memory.projectId,
        type: result.memory.type,
        title: result.memory.title,
        content: result.memory.content,
        tags: result.memory.tags,
        status: result.memory.status,
        replaces: result.memory.replaces,
        createdAt: result.memory.createdAt,
      },
      head: {
        id: result.head.id,
        title: result.head.title,
        content: result.head.content,
        status: result.head.status,
      },
      predecessors: result.predecessors.map((p) => ({
        id: p.id,
        title: p.title,
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

async function handleConfirm(deps: MemoryToolDeps, args: { id?: string; ids?: string[] }) {
  const ctx = getRequestContext();
  const { scope } = await resolveEffectiveScope(deps);

  const hasId = typeof args.id === 'string' && args.id.length > 0;
  const hasIds = Array.isArray(args.ids) && args.ids.length > 0;
  if (hasId === hasIds) {
    return mcpError('invalid_input', 'provide exactly one of `id` or `ids`');
  }

  try {
    assertAuthorized('write', scope);
    if (args.ids !== undefined) {
      const { confirmed } = deps.memory.confirmMany(args.ids, scope, { tokenName: ctx.token.name });
      return ok({ ok: true, confirmed });
    }
    if (args.id === undefined) {
      return mcpError('invalid_input', 'provide exactly one of `id` or `ids`');
    }
    deps.memory.confirm(args.id, scope, { tokenName: ctx.token.name });
    return ok({ ok: true });
  } catch (err) {
    if (err instanceof DomainError && err.code === 'memory_not_found') {
      return mcpError('not_found', 'memory not found');
    }
    return errToMcp(err);
  }
}

const CONTEXT_SNIPPET_CHARS = 350;
// needsReview is recurring (every memory.context) and usually populated, so
// it is kept frugal on COUNT (only the 3 oldest). Its snippet uses the same
// CONTEXT_SNIPPET_CHARS cap as the other lists for a homogeneous payload.
const NEEDS_REVIEW_MAX = 3;

async function handleContext(
  deps: MemoryToolDeps,
  args: {
    sessions?: number;
    prompts?: number;
    memories?: number;
    includeArchived?: boolean;
  },
) {
  if (!deps.repos || !deps.agentSessions || !deps.prompts || !deps.router) {
    return mcpError('internal_error', 'memory.context is not wired with its required dependencies');
  }
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'read');
  } catch (err) {
    return errToMcp(err);
  }
  const sessionsLimit = clamp(args.sessions ?? 3, 0, 25);
  const memoriesLimit = clamp(args.memories ?? 10, 0, 100);
  const clamped =
    (args.sessions ?? 0) > 25 || (args.prompts ?? 0) > 50 || (args.memories ?? 0) > 100;
  const includeArchived = args.includeArchived === true;

  const recentSessions = deps.agentSessions
    .recentForContext({
      projectId: scope.kind === 'project' ? scope.projectId : null,
      limit: sessionsLimit,
    })
    .map((s) => ({
      id: s.id,
      agent: s.agent,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      status: s.status,
      title: s.title,
      summary: s.summary ? snippet(s.summary, CONTEXT_SNIPPET_CHARS) : null,
    }));

  const recentMemories = deps.repos.memory
    .recentForContext({
      scope: scope.kind === 'project' ? 'project' : 'global',
      projectId: scope.kind === 'project' ? scope.projectId : null,
      includeArchived,
      limit: memoriesLimit,
    })
    .map((m) => ({
      id: m.id,
      type: m.type,
      title: m.title,
      snippet: snippet(m.content, CONTEXT_SNIPPET_CHARS),
      status: m.status,
      createdAt: m.createdAt.toISOString(),
    }));

  const promptsLimit = clamp(args.prompts ?? 5, 0, 50);
  const recentPrompts = deps.prompts
    .recentForContext({
      projectId: scope.kind === 'project' ? scope.projectId : null,
      limit: promptsLimit,
    })
    .map((p) => ({
      id: p.id,
      content: snippet(p.content, CONTEXT_SNIPPET_CHARS),
      agent: p.agent,
      createdAt: p.createdAt,
    }));

  // Aged pending relations (older than the orphan threshold) the agent
  // should close with memory.judge while context is fresh. Unjudged rows
  // are deterministically orphaned by the sweep after the deadline.
  const now = Date.now();
  const pendingCutoff = now - (deps.orphanAfterMs ?? 86_400_000);
  const pendingJudgments = deps.repos.relations
    .listPendingOlderThanInScope({
      scope: scope.kind === 'project' ? 'project' : 'global',
      projectId: scope.kind === 'project' ? scope.projectId : null,
      cutoffMs: pendingCutoff,
      limit: 5,
    })
    .map((r) => ({
      judgmentId: r.judgmentId,
      sourceId: r.sourceId,
      targetId: r.targetId,
      sourceTitle: r.sourceTitle,
      targetTitle: r.targetTitle,
      sourceSnippet: snippet(r.sourceContent, CONTEXT_SNIPPET_CHARS),
      targetSnippet: snippet(r.targetContent, CONTEXT_SNIPPET_CHARS),
      ageMs: now - r.createdAt.getTime(),
    }));

  // Active memories past their review shelf life — re-affirm with
  // memory.confirm, supersede with memory.save + topic_key, or judge if they
  // contradict another memory. Unary (one memory, no counterpart), disjoint
  // from pendingJudgments. Derived read-time state; nothing is mutated.
  const needsReview = deps.memory.needsReviewForContext(scope, NEEDS_REVIEW_MAX).map((it) => ({
    id: it.memory.id,
    type: it.memory.type,
    title: it.memory.title,
    snippet: snippet(it.memory.content, CONTEXT_SNIPPET_CHARS),
    reviewAfter: it.reviewAfter.toISOString(),
    ageMs: now - it.reviewBaseline.getTime(),
  }));

  return ok({
    scope: scope.kind === 'project' ? `project:${scope.projectId}` : 'global',
    recentSessions,
    recentPrompts,
    recentMemories,
    pendingJudgments,
    needsReview,
    clamped,
  });
}

async function handleTimeline(
  deps: MemoryToolDeps,
  args: { memoryId: string; before?: number; after?: number },
) {
  if (!deps.repos || !deps.router) {
    return mcpError(
      'internal_error',
      'memory.timeline is not wired with its required dependencies',
    );
  }
  const before = clamp(args.before ?? 5, 0, 50);
  const after = clamp(args.after ?? 5, 0, 50);
  if (before + after > 50) {
    return mcpError(
      'invalid_input',
      'memory.timeline: before + after exceeds 50; for larger windows use memory.search',
    );
  }
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'read');
  } catch (err) {
    return errToMcp(err);
  }
  const target = deps.memory.get(args.memoryId, scope);
  if (!target) {
    return mcpError('not_found', `memory '${args.memoryId}' not found in this scope`);
  }
  const t = target.memory;

  if (t.sessionId) {
    const beforeRows = deps.repos.memory.sessionNeighbors({
      sessionId: t.sessionId,
      pivotCreatedAt: t.createdAt,
      pivotId: t.id,
      direction: 'before',
      limit: before,
    });
    const afterRows = deps.repos.memory.sessionNeighbors({
      sessionId: t.sessionId,
      pivotCreatedAt: t.createdAt,
      pivotId: t.id,
      direction: 'after',
      limit: after,
    });
    return ok({
      target: { id: t.id, createdAt: t.createdAt },
      before: beforeRows.map(serializeMemory),
      after: afterRows.map(serializeMemory),
      fallback: null,
    });
  }

  // Fallback: ±2h window around created_at, scoped to (scope, project_id).
  const windowMs = 2 * 3600 * 1000;
  const targetMs = t.createdAt.getTime();
  const window = {
    scope: scope.kind === 'project' ? ('project' as const) : ('global' as const),
    projectId: scope.kind === 'project' ? scope.projectId : null,
    pivotId: t.id,
    loMs: targetMs - windowMs,
    hiMs: targetMs + windowMs,
    pivotMs: targetMs,
  };
  const beforeRows = deps.repos.memory.windowNeighbors({
    ...window,
    direction: 'before',
    limit: before,
  });
  const afterRows = deps.repos.memory.windowNeighbors({
    ...window,
    direction: 'after',
    limit: after,
  });
  return ok({
    target: { id: t.id, createdAt: t.createdAt },
    before: beforeRows.map(serializeMemory),
    after: afterRows.map(serializeMemory),
    fallback: 'time_window',
  });
}
