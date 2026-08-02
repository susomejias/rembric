import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { getRequestContext } from '../server/request-context.js';
import type { SessionRouter } from '../server/session-router.js';
import { SUMMARY_MAX_CHARS, type AgentSessionsService } from '../services/agent-sessions.js';
import { type ProjectsService } from '../services/projects.js';
import { projectScope, SCOPE_GLOBAL, type Scope } from '../services/scope.js';

import {
  assertAuthorized,
  requireScope,
  resolveSessionId,
  routerKey,
  unresolvableSlugError,
} from './_shared.js';
import { errToMcp, mcpError } from './errors.js';
import { pendingSuggestionGate, suggestionPendingMessage } from './project-suggestion-gate.js';
import { ok } from './result.js';
import { ensureRootsDiscoveryRun } from './roots-discovery.js';

/**
 * Session-lifecycle MCP tools: session_start / session_end / session_summary
 * / session_get. The schemas are `Record<string, ZodType>` (what the MCP
 * SDK's `server.tool()` expects).
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

export const sessionGetSchema = {
  sessionId: z.string().min(1),
};

export interface SessionToolDeps {
  agentSessions: AgentSessionsService;
  projects: ProjectsService;
  router: SessionRouter;
  /** Fire-and-forget consolidation sweep, invoked after session start. */
  sweep?: (projectId: string | null) => void;
  /** Back-reference for roots-based discovery; set by createMcpServer. */
  getServer?: () => McpServer;
}

export const sessionStartOutput = {
  sessionId: z.string(),
  scope: z.string(),
  projectId: z.string().nullable(),
  startedAt: z.string(),
  title: z.string().nullable(),
  reused: z.boolean(),
};

export const sessionEndOutput = {
  ok: z.literal(true),
  sessionId: z.string(),
  endedAt: z.string().nullable(),
};

export const sessionSummaryOutput = {
  ok: z.literal(true),
  sessionId: z.string(),
  summary: z.string(),
  title: z.string().nullable(),
  summaryFinal: z.boolean(),
  titleFinal: z.boolean(),
};

export const sessionGetOutput = {
  id: z.string(),
  agent: z.string(),
  status: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
};

export function buildSessionHandlers(deps: SessionToolDeps) {
  return {
    sessionStart: handleSessionStart.bind(null, deps),
    sessionEnd: handleSessionEnd.bind(null, deps),
    sessionSummary: handleSessionSummary.bind(null, deps),
    sessionGet: handleSessionGet.bind(null, deps),
  };
}

async function handleSessionStart(
  deps: SessionToolDeps,
  args: { agent?: string; description?: string; project?: string },
) {
  const ctx = getRequestContext();

  // This handler resolves the session's project itself rather than through
  // `resolveEffectiveScope`, so it needs the unresolvable-slug refusal
  // explicitly or it opens a global-scope session on a path-scoped connection.
  if (ctx.requestedSlug !== null && !ctx.project) {
    return errToMcp(unresolvableSlugError(ctx.requestedSlug, deps.projects));
  }

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

  try {
    assertAuthorized('write', projectId ? projectScope(projectId) : SCOPE_GLOBAL, deps);
  } catch (err) {
    return errToMcp(err);
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
    // findActiveForTransport now excludes rows idle past TRANSPORT_STALENESS_MS
    // (fix-audited-defects); a session whose only activity is repeated
    // session_start calls must still count as touched, or it goes stale and
    // this reuse branch stops firing on its own next call.
    deps.agentSessions.touchActivity(session.id);
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

async function handleSessionEnd(deps: SessionToolDeps, args: { sessionId?: string }) {
  const ctx = getRequestContext();
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'write');
  } catch (err) {
    return errToMcp(err);
  }
  // touch:false — end() stamps last_activity_at on an active row (and
  // deliberately not on a terminal one); touching here too would be a second
  // UPDATE of the same row for one request.
  const sessionId = resolveSessionId(
    deps,
    args.sessionId,
    scope.kind === 'project' ? scope.projectId : null,
    { touch: false },
  );
  if (!sessionId) {
    return mcpError(
      'session_not_found',
      'no active session on this MCP transport and no sessionId was provided',
    );
  }
  const blocked = rejectIfDeleted(
    deps,
    sessionId,
    ctx.token.id,
    scope.kind === 'project' ? scope.projectId : null,
  );
  if (blocked) return blocked;
  try {
    const ended = deps.agentSessions.end(sessionId, { tokenId: ctx.token.id });
    const key = routerKey();
    // Not on an abandoned row: `end()` used to throw there, so the binding
    // survived. Clearing it now would drop auto-attach to `session_id = NULL`.
    if (key && ended.status !== 'abandoned') {
      deps.router.clearSession(key.tokenId, key.mcpSessionId);
    }
    return ok({ ok: true, sessionId: ended.id, endedAt: ended.endedAt });
  } catch (err) {
    return errToMcp(err);
  }
}

async function handleSessionSummary(
  deps: SessionToolDeps,
  args: { sessionId?: string; summary: string; title?: string },
) {
  const ctx = getRequestContext();
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'write');
  } catch (err) {
    return errToMcp(err);
  }
  // touch:false — writeSummary() stamps last_activity_at on an active row, and
  // deliberately does not on a terminal one.
  const sessionId = resolveSessionId(
    deps,
    args.sessionId,
    scope.kind === 'project' ? scope.projectId : null,
    { touch: false },
  );
  if (!sessionId) {
    return mcpError(
      'session_not_found',
      'no active session on this MCP transport and no sessionId was provided',
    );
  }
  const blocked = rejectIfDeleted(
    deps,
    sessionId,
    ctx.token.id,
    scope.kind === 'project' ? scope.projectId : null,
  );
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
 * the existing behavior of `end`/`summary`), then check the soft-delete
 * gate. Returns an MCP error response when the session is deleted by the
 * owning token, or `null` when the caller may proceed.
 */
function rejectIfDeleted(
  deps: SessionToolDeps,
  sessionId: string,
  callerTokenId: string,
  projectId: string | null,
): ReturnType<typeof mcpError> | null {
  const row = deps.agentSessions.getById(sessionId);
  if (!row) {
    return mcpError('session_not_found', `session '${sessionId}' not found`);
  }
  if (row.tokenId !== callerTokenId) {
    return mcpError('session_not_found', `session '${sessionId}' not found`);
  }
  // Matches the HTTP handler's mask. Without it a terminal row from any other
  // project this token ever touched is writable, which the late-write path
  // widened from "my one live session" to "every session ever".
  if (row.projectId !== projectId) {
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

async function handleSessionGet(deps: SessionToolDeps, args: { sessionId: string }) {
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'read');
  } catch (err) {
    return errToMcp(err);
  }
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
