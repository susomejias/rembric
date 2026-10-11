import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SUMMARY_MAX_CHARS, type AgentSessionsService } from '@rembric/core';
import { getRequestContext } from '@rembric/core';
import type { ProjectsService } from '@rembric/core';
import type { ProjectResolutionSource, SessionRouter } from '@rembric/core';
import { projectScope, type AgentSession, type Scope } from '@rembric/db';
import { z } from 'zod';

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
import { errToMcp, itemError, mcpError, type ErrorReportingDeps } from './errors.js';
import { batchResult, ok } from './result.js';

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

export const sessionResumeSchema = {
  sessionId: z.string().min(1),
};

export const sessionGetSchema = {
  ids: z
    .array(z.string().min(1))
    .min(1)
    .optional()
    .describe(
      'Session IDs; duplicates removed before paging. Use IDs OR from/to, never both. A one-item array supports summary recovery.',
    ),
  from: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'ISO timestamp with offset: inclusive interval start. Select session activity spans overlapping [from,to); not a historical summary snapshot. Mutually exclusive with ids.',
    ),
  to: z.iso
    .datetime({ offset: true })
    .optional()
    .describe(
      'ISO timestamp with offset: exclusive interval end; defaults to server now. Requires from < to.',
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(20)
    .optional()
    .describe(
      'Outcomes per page, including errors; default/max20. Full summaries without byte-based truncation.',
    ),
  offset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Default0. Continue with nextOffset until null; period pages are live reads.'),
};

export interface SessionToolDeps extends ErrorReportingDeps {
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
  agent: z.string(),
};

export const sessionEndOutput = {
  ok: z.literal(true),
  sessionId: z.string(),
  endedAt: z.string().nullable(),
  applied: z.boolean(),
};

export const sessionSummaryOutput = {
  ok: z.literal(true),
  sessionId: z.string(),
  summary: z.string(),
  title: z.string().nullable(),
  summaryFinal: z.boolean(),
  titleFinal: z.boolean(),
  applied: z.boolean(),
  discardReason: z.string().optional(),
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
  sessions: z.array(
    z.object({
      id: z.string(),
      agent: z.string(),
      status: z.string(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
      lastActivityAt: z.string().nullable(),
      title: z.string().nullable(),
      summary: z.string().nullable(),
      summaryFinal: z.boolean(),
    }),
  ),
  errors: z.array(
    z.object({
      id: z.string(),
      code: z.string(),
      message: z.string(),
      errorId: z.string().optional(),
    }),
  ),
  total: z.number(),
  nextOffset: z.number().nullable(),
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

  const deadSlug = unresolvableSlug();
  if (deadSlug !== null) {
    return errToMcp(unresolvableSlugError(deadSlug, deps.projects), deps.logInternalError);
  }

  let scope: Scope;
  let source: ProjectResolutionSource;
  if (args.project === undefined) {
    try {
      ({ scope, source } = await resolveEffectiveScope(deps));
    } catch (err) {
      return errToMcp(err, deps.logInternalError);
    }
  } else {
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
  }
  const projectId = scope.projectId;

  try {
    assertAuthorized('write', scope, deps);
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }

  const key = routerKey();
  const boundId = key
    ? (deps.router.get(key.tokenId, key.mcpSessionId)?.rembricSessionId ?? null)
    : null;
  const bound = boundId ? deps.agentSessions.getById(boundId) : undefined;
  let session: AgentSession | null;
  if (
    bound &&
    bound.status === 'active' &&
    bound.deletedAt === null &&
    bound.tokenId === ctx.token.id &&
    bound.projectId === projectId
  ) {
    session = bound;
  } else {
    session =
      deps.agentSessions.findActiveForTransport({
        tokenId: ctx.token.id,
        projectId,
      }) ?? deps.agentSessions.findSoleActiveForReuse({ tokenId: ctx.token.id, projectId });
  }
  let reused = false;
  if (session) {
    reused = true;
    deps.agentSessions.touchActivity(session.id);
  } else {
    try {
      session = deps.agentSessions.start({
        tokenId: ctx.token.id,
        projectId,
        agent: args.agent ?? 'unknown',
        description: args.description ?? null,
        cwd: typeof process === 'undefined' ? null : process.cwd(),
      });
    } catch (err) {
      return errToMcp(err, deps.logInternalError);
    }
  }

  deps.sweep?.(projectId);

  if (key) {
    deps.router.setActiveSession(key.tokenId, key.mcpSessionId, session.id);
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
    agent: session.agent,
  });
}

async function handleSessionEnd(deps: SessionToolDeps, args: { sessionId?: string }) {
  const ctx = getRequestContext();
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'write');
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
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
    const { row: ended, applied } = deps.agentSessions.end(sessionId, {
      tokenId: ctx.token.id,
    });
    const key = routerKey();
    if (key && ended.status !== 'abandoned') {
      deps.router.clearSession(key.tokenId, key.mcpSessionId);
    }
    return ok({ ok: true, sessionId: ended.id, endedAt: ended.endedAt, applied });
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
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
    return errToMcp(err, deps.logInternalError);
  }
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
    const { row: updated, applied } = deps.agentSessions.writeSummary(sessionId, {
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
      applied,
      ...(applied === false && { discardReason: 'terminal_final' }),
    });
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
}

async function handleSessionResume(deps: SessionToolDeps, args: { sessionId: string }) {
  const ctx = getRequestContext();
  let scope: Scope;
  try {
    scope = await requireScope(deps, 'write');
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
  try {
    assertExplicitSessionOwned(deps.agentSessions, args.sessionId, scope.projectId);
    const before = deps.agentSessions.getById(args.sessionId);
    if (!before) {
      return mcpError('session_not_found', `session '${args.sessionId}' not found`);
    }
    const resumed = deps.agentSessions.resume(args.sessionId, { tokenId: ctx.token.id });
    const key = routerKey();
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
    return errToMcp(err, deps.logInternalError);
  }
}

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
  args: z.infer<z.ZodObject<typeof sessionGetSchema>>,
) {
  if (
    args.ids !== undefined
      ? args.from !== undefined || args.to !== undefined
      : args.from === undefined
  ) {
    return mcpError('invalid_input', 'Provide either ids or from/to, never both.');
  }
  try {
    const scope = await requireScope(deps, 'read');
    const offset = args.offset ?? 0;
    const limit = args.limit ?? 20;
    const ids = args.ids ? [...new Set(args.ids)] : null;
    const selection = ids
      ? null
      : deps.agentSessions.forPeriod(
          scope,
          new Date(args.from!),
          args.to ? new Date(args.to) : new Date(),
          limit,
          offset,
        );
    const total = ids?.length ?? selection!.total;
    const page = ids ? ids.slice(offset, offset + limit) : selection!.sessions.map((s) => s.id);
    const sessions = [];
    const errors: z.infer<typeof sessionGetOutput.errors> = [];
    for (const id of page) {
      try {
        const row = deps.agentSessions.getInScope(id, scope);
        if (!row) {
          errors.push({ id, code: 'not_found', message: 'Item not found.' });
          continue;
        }
        sessions.push({
          id: row.id,
          agent: row.agent,
          status: row.status,
          startedAt: row.startedAt,
          endedAt: row.endedAt,
          lastActivityAt: row.lastActivityAt,
          title: row.title,
          summary: row.summary,
          summaryFinal: row.summaryFinal,
        });
      } catch (err) {
        errors.push({ id, ...itemError(err, deps.logInternalError) });
      }
    }
    const nextOffset = offset + page.length < total ? offset + page.length : null;
    return batchResult({ sessions, errors, total, nextOffset }, sessions.length, errors);
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
}
