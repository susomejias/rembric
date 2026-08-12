import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { getRequestContext } from '../server/request-context.js';
import type { ProjectResolutionSource, SessionRouter } from '../server/session-router.js';
import { SUMMARY_MAX_CHARS, type AgentSessionsService } from '../services/agent-sessions.js';
import { type ProjectsService } from '../services/projects.js';
import { projectScope, type Scope } from '../services/scope.js';

import {
  assertAuthorized,
  assertExplicitSessionOwned,
  requireScope,
  resolveEffectiveScope,
  resolveSessionId,
  routerKey,
  unresolvableSlug,
  unresolvableSlugError,
} from './_shared.js';
import { errToMcp, mcpError } from './errors.js';
import { ok } from './result.js';

/**
 * Session-lifecycle MCP tools: session_start / session_end / session_summary
 * / session_resume / session_get. The schemas are `Record<string, ZodType>`
 * (what the MCP SDK's `server.tool()` expects).
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

// No `.optional()`, unlike session_end/session_summary: there is no terminal
// row to fall back to (the router binding was cleared on end, and the active
// lookup filters `status = 'active'`), so a fallback could only guess by
// recency.
export const sessionResumeSchema = {
  sessionId: z.string().min(1),
};

/** Bound on `sessionGetSchema.limit` — see its `.describe()` for what it bounds. */
export const SESSION_GET_VERSIONS_MAX = 5;

export const sessionGetSchema = {
  sessionId: z.string().min(1),
  limit: z
    .number()
    .int()
    .min(0)
    .max(SESSION_GET_VERSIONS_MAX)
    .optional()
    .describe(
      `How many of this session's stored summary VERSIONS to also return (NOT the summary's length or any other size) — the most recent ${SESSION_GET_VERSIONS_MAX} at most, newest first, each with its full untruncated content. Omit or pass 0 for today's response (no version history): use this only to recover text a later rewrite displaced, not routinely.`,
    ),
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

export const sessionResumeOutput = {
  ok: z.literal(true),
  sessionId: z.string(),
  status: z.literal('active'),
  startedAt: z.string(),
  resumedAt: z.string(),
  previousStatus: z.string(),
  previousEndedAt: z.string().nullable(),
  title: z.string().nullable(),
};

export const sessionGetOutput = {
  id: z.string(),
  agent: z.string(),
  status: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  title: z.string().nullable(),
  summary: z.string().nullable(),
  versions: z
    .array(
      z.object({
        version: z.number(),
        title: z.string().nullable(),
        content: z.string(),
        createdAt: z.string(),
      }),
    )
    .optional(),
};

export function buildSessionHandlers(deps: SessionToolDeps) {
  return {
    sessionStart: handleSessionStart.bind(null, deps),
    sessionEnd: handleSessionEnd.bind(null, deps),
    sessionSummary: handleSessionSummary.bind(null, deps),
    sessionResume: handleSessionResume.bind(null, deps),
    sessionGet: handleSessionGet.bind(null, deps),
  };
}

async function handleSessionStart(
  deps: SessionToolDeps,
  args: { agent?: string; description?: string; project?: string },
) {
  const ctx = getRequestContext();

  // `args.project` is resolved here rather than by the shared resolver, which
  // knows nothing about it, so the unresolvable-slug refusal is needed
  // explicitly for the argument path.
  const deadSlug = unresolvableSlug();
  if (deadSlug !== null) {
    return errToMcp(unresolvableSlugError(deadSlug, deps.projects));
  }

  // The scope this session attaches to: an explicit `args.project` wins,
  // otherwise the shared resolver decides (URL path → router pin → default
  // project), awaiting roots discovery on a path-less connection.
  let scope: Scope;
  let source: ProjectResolutionSource;
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
    scope = projectScope(found.id);
    source = 'tool-explicit';
  } else {
    try {
      ({ scope, source } = await resolveEffectiveScope(deps));
    } catch (err) {
      return errToMcp(err);
    }
  }
  const projectId = scope.projectId;

  try {
    assertAuthorized('write', scope, deps);
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

  const key = routerKey();
  if (key) {
    deps.router.setActiveSession(key.tokenId, key.mcpSessionId, session.id);
    // A router entry means the agent deliberately activated this project, which
    // `project.use`'s switch gates then treat as a project to be switched away
    // from. A `'default'` resolution is a fallback, not an activation, so
    // pinning it would make the documented `project.use` remedy unreachable.
    if (projectId !== null && source !== 'default') {
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
  const sessionId = resolveSessionId(deps, args.sessionId, scope.projectId, { touch: false });
  if (!sessionId) {
    return mcpError(
      'session_not_found',
      'no active session on this MCP transport and no sessionId was provided',
    );
  }
  const blocked = rejectIfDeleted(deps, sessionId, ctx.token.id, scope.projectId);
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
  const sessionId = resolveSessionId(deps, args.sessionId, scope.projectId, { touch: false });
  if (!sessionId) {
    return mcpError(
      'session_not_found',
      'no active session on this MCP transport and no sessionId was provided',
    );
  }
  const blocked = rejectIfDeleted(deps, sessionId, ctx.token.id, scope.projectId);
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

async function handleSessionResume(deps: SessionToolDeps, args: { sessionId: string }) {
  const ctx = getRequestContext();
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'write');
  } catch (err) {
    return errToMcp(err);
  }
  try {
    assertExplicitSessionOwned(deps.agentSessions, args.sessionId, scope.projectId);
    const before = deps.agentSessions.getById(args.sessionId);
    if (!before) {
      return mcpError('session_not_found', `session '${args.sessionId}' not found`);
    }
    const resumed = deps.agentSessions.resume(args.sessionId, { tokenId: ctx.token.id });
    const key = routerKey();
    // The pin is what makes attribution unambiguous: `resolveSessionId` reads
    // the router entry before the sole-active-session fallback, which refuses
    // to resolve whenever a second session is live for the same (token,
    // project). Set on the already-active no-op path too.
    if (key) {
      deps.router.setActiveSession(key.tokenId, key.mcpSessionId, resumed.id);
    }
    return ok({
      ok: true,
      sessionId: resumed.id,
      status: resumed.status,
      startedAt: resumed.startedAt,
      resumedAt: resumed.lastActivityAt ?? resumed.startedAt,
      previousStatus: before.status,
      previousEndedAt: before.endedAt,
      title: resumed.title,
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

async function handleSessionGet(
  deps: SessionToolDeps,
  args: { sessionId: string; limit?: number },
) {
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'read');
  } catch (err) {
    return errToMcp(err);
  }
  const row = deps.agentSessions.getById(args.sessionId);
  if (!row || row.deletedAt || row.projectId !== scope.projectId) {
    return mcpError('not_found', `session '${args.sessionId}' not found in this scope`);
  }
  // Omitted or 0 => the response is byte-identical to before `limit` existed
  // (`sessions`, "No new read surface"): no `versions` key at all, not an
  // empty array.
  const versions = args.limit
    ? deps.agentSessions.listSummaryVersions(args.sessionId, scope, args.limit).map((v) => ({
        version: v.version,
        title: v.title,
        content: v.content,
        createdAt: v.createdAt,
      }))
    : undefined;
  return ok({
    id: row.id,
    agent: row.agent,
    status: row.status,
    startedAt: row.startedAt,
    endedAt: row.endedAt,
    title: row.title,
    summary: row.summary,
    ...(versions !== undefined && { versions }),
  });
}
