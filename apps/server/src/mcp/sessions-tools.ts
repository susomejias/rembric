import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import type { Repositories } from '../db/repositories/index.js';
import type { Memory } from '../db/schema/memory.js';
import { getRequestContext } from '../server/request-context.js';
import type { SessionRouter } from '../server/session-router.js';
import { SUMMARY_MAX_CHARS, type AgentSessionsService } from '../services/agent-sessions.js';
import { DomainError } from '../services/errors.js';
import type { MemoryService } from '../services/memory.js';
import { type ProjectsService } from '../services/projects.js';
import { type PromptsService } from '../services/prompts.js';
import { projectScope, SCOPE_GLOBAL, type Scope } from '../services/scope.js';

import { mcpError } from './errors.js';
import { pendingSuggestionGate, suggestionPendingMessage } from './project-suggestion-gate.js';
import { ensureRootsDiscoveryRun } from './roots-discovery.js';

/**
 * Tool handlers for the session-lifecycle, research, and observability
 * MCP tools added in change `add-sessions-and-research-tools`.
 *
 * The schemas are shaped as `Record<string, ZodType>` (matching what the
 * MCP SDK's `server.tool()` expects).
 */

export const sessionStartSchema = {
  agent: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
  project: z.string().min(1).max(128).optional(),
};

export const sessionEndSchema = {
  sessionId: z.string().min(1).optional(),
};

export const sessionSummarySchema = {
  sessionId: z.string().min(1).optional(),
  summary: z.string().min(1).max(SUMMARY_MAX_CHARS, `summary must be ≤${SUMMARY_MAX_CHARS} chars`),
  title: z.string().min(1).max(100).optional(),
};

export const contextSchema = {
  sessions: z.number().int().min(0).max(25).optional(),
  prompts: z.number().int().min(0).max(50).optional(),
  memories: z.number().int().min(0).max(100).optional(),
  includeArchived: z.boolean().optional(),
};

export const savePromptSchema = {
  content: z.string().min(1).max(20_000),
  title: z.string().min(1).max(100),
  tags: z.array(z.string().min(1)).optional(),
  replaces: z.string().min(1).optional(),
};

export const searchPromptsSchema = {
  query: z.string().optional(),
  sessionId: z.string().min(1).optional(),
  agent: z.string().min(1).optional(),
  includeDeleted: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional(),
  offset: z.number().int().min(0).optional(),
};

export const timelineSchema = {
  memoryId: z.string().min(1),
  before: z.number().int().min(0).max(50).optional(),
  after: z.number().int().min(0).max(50).optional(),
};

export const capturePassiveSchema = {
  text: z.string().min(1).max(50_000),
  sessionId: z.string().min(1).optional(),
};

export const sessionGetSchema = {
  sessionId: z.string().min(1),
};

export interface SessionsToolDeps {
  repos: Pick<Repositories, 'memory' | 'relations'>;
  agentSessions: AgentSessionsService;
  memory: MemoryService;
  projects: ProjectsService;
  prompts: PromptsService;
  router: SessionRouter;
  doctor: () => DoctorReport;
  /** Fire-and-forget consolidation sweep, invoked after session start. */
  sweep?: (projectId: string | null) => void;
  /** Pending relations older than this surface in memory.context. */
  orphanAfterMs?: number;
  /** Back-reference for roots-based discovery; set by createMcpServer. */
  getServer?: () => McpServer;
}

export interface DoctorReport {
  db: { open: boolean; journalMode: string; integrity: string; sizeBytes: number };
  embeddings: { model: string; backlog: number };
  consolidation: { lastRunAt: string | null; lastRunOps: Record<string, number> };
  sessions: { active: number };
  warnings: string[];
}

function ok(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Resolve the effective scope for a session-tool call.
 *
 * Precedence (mirrors `resolveEffectiveProject` in `tools.ts` and the
 * inline resolution in `handleSessionStart`):
 *   1. `ctx.project` — set when the connection is path-scoped (`/mcp/<slug>`).
 *   2. For path-less `/mcp` connections (`ctx.requestedSlug === null`), fall
 *      back to the `SessionRouter` entry populated by a prior `project.use`
 *      or roots-based discovery.
 *   3. Global scope when neither source resolves a project.
 *
 * Without step (2), tools that call this helper (`memory.context`,
 * `memory.timeline`, `memory.stats`, `memory.save_prompt`,
 * `memory.capture_passive`) silently return global scope even when the
 * agent has pinned a project via `project.use`, violating the invariant
 * documented in `CLAUDE.md`.
 */
function scopeFromContext(deps: Pick<SessionsToolDeps, 'router'>): Scope {
  const ctx = getRequestContext();
  if (ctx.project) return projectScope(ctx.project.id);
  if (ctx.requestedSlug !== null) return SCOPE_GLOBAL;
  if (ctx.mcpSessionId) {
    const entry = deps.router.get(ctx.token.id, ctx.mcpSessionId);
    if (entry?.projectId) return projectScope(entry.projectId);
  }
  return SCOPE_GLOBAL;
}

function routerKey(): { tokenId: string; mcpSessionId: string } | null {
  const ctx = getRequestContext();
  if (!ctx.mcpSessionId) return null;
  return { tokenId: ctx.token.id, mcpSessionId: ctx.mcpSessionId };
}

export function buildSessionsHandlers(deps: SessionsToolDeps) {
  return {
    sessionStart: handleSessionStart.bind(null, deps),
    sessionEnd: handleSessionEnd.bind(null, deps),
    sessionSummary: handleSessionSummary.bind(null, deps),
    context: handleContext.bind(null, deps),
    sessionGet: handleSessionGet.bind(null, deps),
    timeline: handleTimeline.bind(null, deps),
    capturePassive: handleCapturePassive.bind(null, deps),
    doctor: handleDoctor.bind(null, deps),
    stats: handleStats.bind(null, deps),
    savePrompt: handleSavePrompt.bind(null, deps),
    searchPrompts: handleSearchPrompts.bind(null, deps),
  };
}

function handleSavePrompt(
  deps: SessionsToolDeps,
  args: {
    content: string;
    title: string;
    tags?: string[];
    replaces?: string;
  },
) {
  const ctx = getRequestContext();
  const scope = scopeFromContext(deps);
  const sessionId = resolveSessionId(deps, undefined);
  try {
    const row = deps.prompts.save({
      content: args.content,
      sessionId,
      projectId: scope.kind === 'project' ? scope.projectId : null,
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

function handleSearchPrompts(
  deps: SessionsToolDeps,
  args: {
    query?: string;
    sessionId?: string;
    agent?: string;
    includeDeleted?: boolean;
    limit?: number;
    offset?: number;
  },
) {
  const scope = scopeFromContext(deps);
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
      clamped: result.clamped,
    });
  } catch (err) {
    return errToMcp(err);
  }
}

async function handleSessionStart(
  deps: SessionsToolDeps,
  args: { agent?: string; description?: string; project?: string },
) {
  const ctx = getRequestContext();

  // Await any eager (or in-flight) roots discovery; trigger it lazily
  // if no eager run happened. The agent may then end up scoped via the
  // derived slug.
  const key = routerKey();
  if (!args.project && key && deps.getServer) {
    await ensureRootsDiscoveryRun(
      { server: deps.getServer(), router: deps.router, projects: deps.projects },
      { tokenId: key.tokenId, mcpSessionId: key.mcpSessionId, pathSlug: ctx.requestedSlug },
    );
  }

  // Resolve the project id this session attaches to, in order of
  // precedence: (1) explicit args.project (validated below), (2) URL
  // path scope, (3) router entry from a prior `project.use` or roots
  // discovery, (4) null (global).
  let projectId: string | null = ctx.project?.id ?? null;
  if (projectId === null && key) {
    const routerEntry = deps.router.get(key.tokenId, key.mcpSessionId);
    projectId = routerEntry?.projectId ?? null;
  }
  // When the agent did not pin a project and roots-based discovery
  // surfaced pending suggestions, refuse to silently open a global-scope
  // session — make the choice explicit.
  if (args.project === undefined && projectId === null) {
    const pending = pendingSuggestionGate(ctx, {
      router: deps.router,
      projects: deps.projects,
    });
    if (pending) {
      return mcpError('project_suggestion_pending', suggestionPendingMessage(), {
        suggestedSlugs: pending,
      });
    }
  }
  if (args.project !== undefined) {
    if (ctx.requestedSlug && ctx.requestedSlug !== args.project) {
      return mcpError(
        'scope_locked',
        `connection is path-scoped to '${ctx.requestedSlug}'; cannot start a session for project '${args.project}'`,
      );
    }
    const found = deps.projects.findBySlug(args.project);
    if (!found) {
      return mcpError('project_not_found', `project '${args.project}' not found`, {
        suggestedSlugs: deps.projects.findSimilarSlugs(args.project),
      });
    }
    if (found.archivedAt) {
      return mcpError('project_archived', `project '${found.slug}' is archived`);
    }
    projectId = found.id;
  }

  // Idempotency on (token, project): if a session is already active for
  // this scope (typically because the plugin's SessionStart hook created
  // one via the HTTP /api/.../sessions path), return that one instead of
  // minting a new ULID-based row. Prevents the duplicate-session bug
  // where the model defensively calls memory.session_start on top of the
  // hook-driven row, ending up with two parallel sessions.
  let session = deps.agentSessions.findActiveForTransport({
    tokenId: ctx.token.id,
    projectId,
  });
  let reused = false;
  if (session) {
    reused = true;
  } else {
    try {
      session = deps.agentSessions.start({
        tokenId: ctx.token.id,
        projectId,
        agent: args.agent ?? 'unknown',
        description: args.description ?? null,
        cwd: typeof process !== 'undefined' ? process.cwd() : null,
      });
    } catch (err) {
      return errToMcp(err);
    }
  }

  deps.sweep?.(projectId);

  if (key) {
    deps.router.setActiveSession(key.tokenId, key.mcpSessionId, session.id);
    if (projectId !== null) {
      // Preserve the existing resolution source (e.g. 'roots') unless the
      // agent explicitly supplied a project slug, which is always
      // 'tool-explicit'.
      const existing = deps.router.get(key.tokenId, key.mcpSessionId);
      const source = args.project
        ? 'tool-explicit'
        : (existing?.projectResolutionSource ?? (ctx.requestedSlug ? 'url-path' : 'tool-explicit'));
      deps.router.setActiveProject(key.tokenId, key.mcpSessionId, projectId, source);
    }
  }

  return ok({
    sessionId: session.id,
    scope: projectId ? 'project' : 'global',
    projectId,
    startedAt: session.startedAt,
    title: session.title,
    reused,
  });
}

function resolveSessionId(deps: SessionsToolDeps, explicit: string | undefined): string | null {
  if (explicit) return explicit;
  const ctx = getRequestContext();
  const key = routerKey();
  if (key) {
    const routerHit = deps.router.get(key.tokenId, key.mcpSessionId)?.rembricSessionId;
    if (routerHit) return routerHit;
  }
  // Fallback when the SessionRouter has no entry: pick the most recently
  // active session for (tokenId, projectId). This is what makes
  // memory.session_summary / memory.session_end land on the session
  // created via the HTTP hook path (SessionStart bash script) instead of
  // returning session_not_found and pushing the agent to invent a new
  // session via memory.session_start (the cause of the duplicate-session
  // bug observed during testing v0.5.0).
  const scope = scopeFromContext(deps);
  const projectId = scope.kind === 'project' ? scope.projectId : null;
  const active = deps.agentSessions.findActiveForTransport({
    tokenId: ctx.token.id,
    projectId,
  });
  return active?.id ?? null;
}

function handleSessionEnd(deps: SessionsToolDeps, args: { sessionId?: string }) {
  const ctx = getRequestContext();
  const sessionId = resolveSessionId(deps, args.sessionId);
  if (!sessionId) {
    return mcpError(
      'session_not_found',
      'no active session on this MCP transport and no sessionId was provided',
    );
  }
  const blocked = rejectIfDeleted(deps, sessionId, ctx.token.id);
  if (blocked) return blocked;
  try {
    const ended = deps.agentSessions.end(sessionId, { tokenId: ctx.token.id });
    const key = routerKey();
    if (key) deps.router.clearSession(key.tokenId, key.mcpSessionId);
    return ok({ ok: true, sessionId: ended.id, endedAt: ended.endedAt });
  } catch (err) {
    return errToMcp(err);
  }
}

function handleSessionSummary(
  deps: SessionsToolDeps,
  args: { sessionId?: string; summary: string; title?: string },
) {
  const ctx = getRequestContext();
  const sessionId = resolveSessionId(deps, args.sessionId);
  if (!sessionId) {
    return mcpError(
      'session_not_found',
      'no active session on this MCP transport and no sessionId was provided',
    );
  }
  const blocked = rejectIfDeleted(deps, sessionId, ctx.token.id);
  if (blocked) return blocked;
  try {
    const updated = deps.agentSessions.writeSummary(sessionId, {
      tokenId: ctx.token.id,
      summary: args.summary,
      title: args.title,
      final: true,
    });
    return ok({
      ok: true,
      sessionId: updated.id,
      summary: updated.summary,
      title: updated.title,
      summaryFinal: updated.summaryFinal,
      titleFinal: updated.titleFinal,
    });
  } catch (err) {
    return errToMcp(err);
  }
}

/**
 * Run the cross-token check first (mask as session_not_found, matching
 * the existing behavior of `end`/`summarize`), then check the soft-delete
 * gate. Returns an MCP error response when the session is deleted by the
 * owning token, or `null` when the caller may proceed.
 */
function rejectIfDeleted(
  deps: SessionsToolDeps,
  sessionId: string,
  callerTokenId: string,
): ReturnType<typeof mcpError> | null {
  const row = deps.agentSessions.getById(sessionId);
  if (!row) {
    return mcpError('session_not_found', `session '${sessionId}' not found`);
  }
  if (row.tokenId !== callerTokenId) {
    return mcpError('session_not_found', `session '${sessionId}' not found`);
  }
  if (row.deletedAt) {
    return mcpError(
      'session_deleted',
      `session '${sessionId}' was soft-deleted at ${row.deletedAt.toISOString()}; ask an operator to undelete it before resuming`,
    );
  }
  return null;
}

function handleSessionGet(deps: SessionsToolDeps, args: { sessionId: string }) {
  const scope = scopeFromContext(deps);
  const row = deps.agentSessions.getById(args.sessionId);
  if (
    !row ||
    row.deletedAt ||
    (scope.kind === 'project' ? row.projectId !== scope.projectId : row.projectId !== null)
  ) {
    return mcpError('not_found', `session '${args.sessionId}' not found in this scope`);
  }
  return ok({
    id: row.id,
    agent: row.agent,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    title: row.title,
    summary: row.summary,
  });
}

const CONTEXT_SNIPPET_CHARS = 350;

function handleContext(
  deps: SessionsToolDeps,
  args: {
    sessions?: number;
    prompts?: number;
    memories?: number;
    includeArchived?: boolean;
  },
) {
  const scope = scopeFromContext(deps);
  const sessionsLimit = clamp(args.sessions ?? 5, 0, 25);
  const memoriesLimit = clamp(args.memories ?? 20, 0, 100);
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
      snippet: snippet(m.content, CONTEXT_SNIPPET_CHARS),
      status: m.status,
      createdAt: m.createdAt.toISOString(),
    }));

  const promptsLimit = clamp(args.prompts ?? 10, 0, 50);
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
      sourceSnippet: snippet(r.sourceContent, CONTEXT_SNIPPET_CHARS),
      targetSnippet: snippet(r.targetContent, CONTEXT_SNIPPET_CHARS),
      ageMs: now - r.createdAt.getTime(),
    }));

  return ok({
    scope: scope.kind === 'project' ? `project:${scope.projectId}` : 'global',
    recentSessions,
    recentPrompts,
    recentMemories,
    pendingJudgments,
    clamped,
  });
}

function handleTimeline(
  deps: SessionsToolDeps,
  args: { memoryId: string; before?: number; after?: number },
) {
  const before = clamp(args.before ?? 5, 0, 50);
  const after = clamp(args.after ?? 5, 0, 50);
  if (before + after > 50) {
    return mcpError(
      'invalid_input',
      'memory.timeline: before + after exceeds 50; for larger windows use memory.search',
    );
  }
  const scope = scopeFromContext(deps);
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

const KEY_LEARNINGS_RE = /^## Key Learnings:\s*$/m;
const LIST_ITEM_RE = /^(?:\s*(?:-|\*|\d+\.)\s+)(.+?)\s*$/gm;

export function parseKeyLearnings(text: string): string[] {
  const match = KEY_LEARNINGS_RE.exec(text);
  if (!match || match.index === undefined) return [];
  const after = text.slice(match.index + match[0].length);
  // Stop at the next H2 header or end of input.
  const nextH2 = after.search(/^## (?!Key Learnings:)/m);
  const section = nextH2 === -1 ? after : after.slice(0, nextH2);
  LIST_ITEM_RE.lastIndex = 0;
  const items: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = LIST_ITEM_RE.exec(section)) !== null) {
    const v = (m[1] ?? '').trim();
    if (v.length > 0) items.push(v);
  }
  return items;
}

function handleCapturePassive(deps: SessionsToolDeps, args: { text: string; sessionId?: string }) {
  const ctx = getRequestContext();
  const scope = scopeFromContext(deps);
  const items = parseKeyLearnings(args.text);
  if (items.length === 0) {
    return ok({ saved: 0, ids: [] as string[] });
  }
  const explicitSession = args.sessionId ?? resolveSessionId(deps, undefined);
  const ids: string[] = [];
  for (const content of items) {
    const m = deps.memory.save(
      {
        type: 'reference',
        content,
        source: { tokenName: ctx.token.name, agent: 'passive' },
        sessionId: explicitSession,
      },
      scope,
    );
    ids.push(m.id);
  }
  return ok({ saved: ids.length, ids });
}

function handleDoctor(deps: SessionsToolDeps, _args: Record<string, never>) {
  void _args;
  try {
    return ok(deps.doctor());
  } catch (err) {
    return errToMcp(err);
  }
}

function handleStats(deps: SessionsToolDeps, _args: Record<string, never>) {
  void _args;
  const scope = scopeFromContext(deps);
  const { byStatus, byType } = deps.repos.memory.countByStatusAndTypeInScope(
    scope.kind === 'project' ? 'project' : 'global',
    scope.kind === 'project' ? scope.projectId : null,
  );

  const sessionsByStatus = deps.agentSessions.countByStatus();

  return ok({
    scope: scope.kind === 'project' ? `project:${scope.projectId}` : 'global',
    memoriesByStatus: byStatus,
    memoriesByType: byType,
    sessionsByStatus,
  });
}

function errToMcp(err: unknown) {
  if (err instanceof DomainError) {
    return mcpError(err.code, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return mcpError('internal_error', message);
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(Math.max(n, lo), hi);
}

function snippet(content: string, max: number): string {
  if (content.length <= max) return content;
  return content.slice(0, max - 1) + '…';
}

function serializeMemory(m: Memory) {
  return {
    id: m.id,
    type: m.type,
    content: m.content,
    status: m.status,
    createdAt: m.createdAt,
    sessionId: m.sessionId,
  };
}
