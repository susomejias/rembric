import { RedactionTally, SUMMARY_MAX_CHARS, type AgentSessionsService } from '@rembric/core';
import { getRequestContext } from '@rembric/core';
import type { ProjectsService } from '@rembric/core';
import { type AgentSession, type Scope } from '@rembric/db';
import { z } from 'zod';

import {
  assertAuthorized,
  assertExplicitSessionOwned,
  requireScope,
  resolveEffectiveScope,
  resolveSessionId,
  unresolvableSlug,
  unresolvableSlugError,
} from './_shared.js';
import { errToMcp, itemError, mcpError, type ErrorReportingDeps } from './errors.js';
import { REDACTION_NOTE, redactionsField, redactionsOutput } from './redactions.js';
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
  summary: z
    .string()
    .min(1)
    .max(SUMMARY_MAX_CHARS, `summary must be ≤${SUMMARY_MAX_CHARS} chars`)
    .describe(REDACTION_NOTE),
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
  /** Fire-and-forget consolidation sweep, invoked after session start. */
  sweep?: (projectId: string | null) => void;
}

export const sessionStartOutput = {
  sessionId: z.string(),
  scope: z.string(),
  projectId: z.string().nullable(),
  startedAt: z.string(),
  title: z.string().nullable(),
  reused: z.boolean(),
  agent: z.string(),
  redactions: redactionsOutput,
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
  redactions: redactionsOutput,
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
    return errToMcp(
      unresolvableSlugError(deadSlug, deps.projects, ctx.scope),
      deps.logInternalError,
    );
  }

  let scope: Scope;
  let slug: string;
  try {
    const resolved = await resolveEffectiveScope(deps);
    scope = resolved.scope;
    slug = resolved.project.slug;
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }
  if (args.project !== undefined && args.project !== slug) {
    return mcpError(
      'scope_locked',
      ctx.requestedSlug === null
        ? `connection resolves to the default project '${slug}'; cannot start a session for project '${args.project}'`
        : `connection is path-scoped to '${slug}'; cannot start a session for project '${args.project}'`,
    );
  }
  const projectId = scope.projectId;

  try {
    assertAuthorized('write', scope, deps);
  } catch (err) {
    return errToMcp(err, deps.logInternalError);
  }

  let session: AgentSession | null =
    deps.agentSessions.findActiveForTransport({ tokenId: ctx.token.id, projectId }) ??
    deps.agentSessions.findSoleActiveForReuse({ tokenId: ctx.token.id, projectId });
  let reused = false;
  const redactions = new RedactionTally();
  if (session) {
    reused = true;
    deps.agentSessions.touchActivity(session.id);
  } else {
    try {
      session = deps.agentSessions.start(
        {
          tokenId: ctx.token.id,
          projectId,
          agent: args.agent ?? 'unknown',
          description: args.description ?? null,
          cwd: typeof process === 'undefined' ? null : process.cwd(),
        },
        redactions,
      );
    } catch (err) {
      return errToMcp(err, deps.logInternalError);
    }
  }

  deps.sweep?.(projectId);

  return ok({
    sessionId: session.id,
    scope: projectId ? 'project' : 'global',
    projectId,
    startedAt: session.startedAt,
    title: session.title,
    reused,
    agent: session.agent,
    ...redactionsField(redactions),
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
    const redactions = new RedactionTally();
    const { row: updated, applied } = deps.agentSessions.writeSummary(
      sessionId,
      {
        tokenId: ctx.token.id,
        summary: args.summary,
        title: args.title,
        final: true,
      },
      redactions,
    );
    return ok({
      ok: true,
      sessionId: updated.id,
      summary: updated.summary,
      title: updated.title,
      summaryFinal: updated.summaryFinal,
      titleFinal: updated.titleFinal,
      applied,
      ...(applied === false && { discardReason: 'terminal_final' }),
      ...(applied && redactionsField(redactions)),
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
