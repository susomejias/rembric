import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { Db } from '../db/client.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { memory } from '../db/schema/memory.js';
import { getRequestContext } from '../server/request-context.js';
import type { SessionRouter } from '../server/session-router.js';
import { type AgentSessionsService } from '../services/agent-sessions.js';
import { DomainError } from '../services/errors.js';
import type { MemoryService } from '../services/memory.js';
import { type ProjectsService } from '../services/projects.js';
import { type PromptsService } from '../services/prompts.js';
import { projectScope, SCOPE_GLOBAL, type Scope } from '../services/scope.js';

import { mcpError } from './errors.js';
import { pendingSuggestionGate, suggestionPendingMessage } from './project-suggestion-gate.js';
import { maybeDiscoverViaRoots } from './roots-discovery.js';

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
  summary: z.string().min(1).max(20_000),
};

export const contextSchema = {
  sessions: z.number().int().min(0).max(25).optional(),
  prompts: z.number().int().min(0).max(50).optional(),
  memories: z.number().int().min(0).max(100).optional(),
  includeArchived: z.boolean().optional(),
};

export const savePromptSchema = {
  content: z.string().min(1).max(20_000),
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

export interface SessionsToolDeps {
  db: Db;
  agentSessions: AgentSessionsService;
  memory: MemoryService;
  projects: ProjectsService;
  prompts: PromptsService;
  router: SessionRouter;
  doctor: () => DoctorReport;
  /** Back-reference for roots-based discovery; set by createMcpServer. */
  getServer?: () => McpServer;
}

export interface DoctorReport {
  db: { open: boolean; journalMode: string; integrity: string; sizeBytes: number };
  llm: { reachable: boolean; lastPingAt: string | null };
  embeddings: { enabled: boolean; backlog: number };
  consolidation: { lastRunAt: string | null; lastRunOps: Record<string, number> };
  sessions: { active: number };
  warnings: string[];
}

function ok(payload: unknown) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }],
  };
}

function scopeFromContext(): Scope {
  const ctx = getRequestContext();
  return ctx.project ? projectScope(ctx.project.id) : SCOPE_GLOBAL;
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
    timeline: handleTimeline.bind(null, deps),
    capturePassive: handleCapturePassive.bind(null, deps),
    doctor: handleDoctor.bind(null, deps),
    stats: handleStats.bind(null, deps),
    savePrompt: handleSavePrompt.bind(null, deps),
  };
}

function handleSavePrompt(deps: SessionsToolDeps, args: { content: string }) {
  const ctx = getRequestContext();
  const scope = scopeFromContext();
  const sessionId = resolveSessionId(deps, undefined);
  try {
    const row = deps.prompts.save({
      content: args.content,
      sessionId,
      projectId: scope.kind === 'project' ? scope.projectId : null,
      agent: ctx.token.name,
    });
    return ok({ ok: true, id: row.id, createdAt: row.createdAt });
  } catch (err) {
    return errToMcp(err);
  }
}

async function handleSessionStart(
  deps: SessionsToolDeps,
  args: { agent?: string; description?: string; project?: string },
) {
  const ctx = getRequestContext();

  // Trigger lazy roots discovery on session start when no explicit
  // project is supplied; the agent may then end up scoped via the
  // derived slug.
  const key = routerKey();
  if (!args.project && key && deps.getServer) {
    await maybeDiscoverViaRoots(
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

  let session;
  try {
    session = deps.agentSessions.start({
      tokenId: ctx.token.id,
      projectId,
      agent: args.agent ?? 'unknown',
      description: args.description ?? null,
    });
  } catch (err) {
    return errToMcp(err);
  }

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
  });
}

function resolveSessionId(deps: SessionsToolDeps, explicit: string | undefined): string | null {
  if (explicit) return explicit;
  const key = routerKey();
  if (!key) return null;
  return deps.router.get(key.tokenId, key.mcpSessionId)?.rembricSessionId ?? null;
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
  args: { sessionId?: string; summary: string },
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
    const summed = deps.agentSessions.summarize(sessionId, {
      tokenId: ctx.token.id,
      summary: args.summary,
    });
    const key = routerKey();
    if (key) deps.router.clearSession(key.tokenId, key.mcpSessionId);
    return ok({ ok: true, sessionId: summed.id, endedAt: summed.endedAt });
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

function handleContext(
  deps: SessionsToolDeps,
  args: {
    sessions?: number;
    prompts?: number;
    memories?: number;
    includeArchived?: boolean;
  },
) {
  const scope = scopeFromContext();
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
      summary: s.summary,
    }));

  const memoryStatusClause = includeArchived ? sql`` : sql`AND m.status != 'archived'`;
  const memoryScopeClause =
    scope.kind === 'project'
      ? sql`m.scope = 'project' AND m.project_id = ${scope.projectId}`
      : sql`m.scope = 'global' AND m.project_id IS NULL`;
  const recentMemoryRows = deps.db.all<{
    id: string;
    type: string;
    content: string;
    status: string;
    created_at: number;
  }>(sql`
      SELECT m.id, m.type, m.content, m.status, m.created_at
      FROM memory m
      WHERE ${memoryScopeClause}
      ${memoryStatusClause}
      ORDER BY COALESCE(m.last_seen_at, m.created_at) DESC
      LIMIT ${memoriesLimit}
    `);
  const recentMemories = recentMemoryRows.map((r) => ({
    id: r.id,
    type: r.type,
    snippet: snippet(r.content, 200),
    status: r.status,
    createdAt: new Date(r.created_at).toISOString(),
  }));

  const promptsLimit = clamp(args.prompts ?? 10, 0, 50);
  const recentPrompts = deps.prompts
    .recentForContext({
      projectId: scope.kind === 'project' ? scope.projectId : null,
      limit: promptsLimit,
    })
    .map((p) => ({
      id: p.id,
      content: p.content,
      agent: p.agent,
      createdAt: p.createdAt,
    }));

  return ok({
    scope: scope.kind === 'project' ? `project:${scope.projectId}` : 'global',
    recentSessions,
    recentPrompts,
    recentMemories,
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
  const scope = scopeFromContext();
  const target = deps.memory.get(args.memoryId, scope);
  if (!target) {
    return mcpError('not_found', `memory '${args.memoryId}' not found in this scope`);
  }
  const t = target.memory;

  if (t.sessionId) {
    const beforeRows = deps.db
      .select()
      .from(memory)
      .where(sql`session_id = ${t.sessionId} AND created_at < ${t.createdAt} AND id != ${t.id}`)
      .orderBy(desc(memory.createdAt))
      .limit(before)
      .all()
      .reverse();
    const afterRows = deps.db
      .select()
      .from(memory)
      .where(sql`session_id = ${t.sessionId} AND created_at > ${t.createdAt} AND id != ${t.id}`)
      .orderBy(memory.createdAt)
      .limit(after)
      .all();
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
  const loMs = targetMs - windowMs;
  const hiMs = targetMs + windowMs;
  const scopeFilter =
    scope.kind === 'project'
      ? sql`scope = 'project' AND project_id = ${scope.projectId}`
      : sql`scope = 'global' AND project_id IS NULL`;
  const beforeRows = deps.db
    .select()
    .from(memory)
    .where(
      sql`${scopeFilter} AND created_at >= ${loMs} AND created_at < ${targetMs} AND id != ${t.id}`,
    )
    .orderBy(desc(memory.createdAt))
    .limit(before)
    .all()
    .reverse();
  const afterRows = deps.db
    .select()
    .from(memory)
    .where(
      sql`${scopeFilter} AND created_at > ${targetMs} AND created_at <= ${hiMs} AND id != ${t.id}`,
    )
    .orderBy(memory.createdAt)
    .limit(after)
    .all();
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
  const scope = scopeFromContext();
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
  const scope = scopeFromContext();
  const scopeFilter =
    scope.kind === 'project'
      ? sql`scope = 'project' AND project_id = ${scope.projectId}`
      : sql`scope = 'global' AND project_id IS NULL`;

  const byStatus = deps.db
    .all<{
      status: string;
      n: number;
    }>(sql`SELECT status, COUNT(*) AS n FROM memory WHERE ${scopeFilter} GROUP BY status`)
    .reduce<Record<string, number>>((acc, r) => {
      acc[r.status] = Number(r.n);
      return acc;
    }, {});

  const byType = deps.db
    .all<{
      type: string;
      n: number;
    }>(sql`SELECT type, COUNT(*) AS n FROM memory WHERE ${scopeFilter} GROUP BY type`)
    .reduce<Record<string, number>>((acc, r) => {
      acc[r.type] = Number(r.n);
      return acc;
    }, {});

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

function serializeMemory(m: typeof memory.$inferSelect) {
  return {
    id: m.id,
    type: m.type,
    content: m.content,
    status: m.status,
    createdAt: m.createdAt,
    sessionId: m.sessionId,
  };
}

// Maintained imports for downstream consumers.
void eq;
void isNull;
void agentSessions;
