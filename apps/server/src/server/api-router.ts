import { Hono, type Context } from 'hono';
import { z } from 'zod';

import { truncateSummary, type AgentSessionsService } from '../services/agent-sessions.js';
import { DomainError } from '../services/errors.js';
import type { ProjectsService } from '../services/projects.js';
import { isAuthorized } from '../services/tokens.js';
import type { TokensService } from '../services/tokens.js';

import { AuthError, authenticate } from './auth.js';
import type { RequestContext } from './request-context.js';

type ApiEnv = { Variables: { rembricCtx: RequestContext } };
type ApiContext = Context<ApiEnv>;

/**
 * Non-MCP HTTP API for client-driven session lifecycle.
 *
 * The plugin's `command`-type hooks (Claude Code's `session-start.sh`,
 * `pre-compact.sh`, `session-stop.sh` and the Codex equivalents) POST
 * here directly so sessions are tracked regardless of whether the agent
 * remembers to call `memory.session_start` over MCP.
 *
 * Mounted by `startHttpServer` at `/api`. Auth is identical to `/mcp` —
 * same `Authorization: Bearer <token>` header, same `authenticate()`
 * helper, same per-token rate limiting layer applied upstream.
 */

export interface ApiRouterDeps {
  agentSessions: AgentSessionsService;
  tokens: TokensService;
  projects: ProjectsService;
  /**
   * Fire-and-forget consolidation sweep (decay + deadline orphaning),
   * invoked after a session is created. Throttled and error-isolated by
   * the bootstrapper — never affects the session response.
   */
  sweep?: (projectId: string | null) => void;
}

const ID_RE_SOURCE = '^[A-Za-z0-9_-]{8,128}$';
const ID_RE = new RegExp(ID_RE_SOURCE);

const sessionPostSchema = z.object({
  id: z.string().regex(ID_RE, `id must match ${ID_RE_SOURCE}`),
  cwd: z.string().max(4096).optional(),
  agent: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).optional(),
});

const sessionSummarySchema = z.object({
  summary: z.string().min(1).max(20_000),
  title: z.string().min(1).max(100).optional(),
  final: z.boolean().optional(),
});

const sessionEndSchema = z.object({
  summary: z.string().min(1).max(20_000).optional(),
  title: z.string().min(1).max(100).optional(),
  final: z.boolean().optional(),
});

export function createApiRouter(deps: ApiRouterDeps): Hono<ApiEnv> {
  const app = new Hono<ApiEnv>();

  app.use('/:slug/sessions/*', authMiddleware(deps));
  app.use('/:slug/sessions', authMiddleware(deps));

  app.post('/:slug/sessions', async (c) => {
    const ctx = c.get('rembricCtx');
    if (!ctx.project) {
      return c.json({ ok: false, code: 'project_not_found', slug: c.req.param('slug') }, 404);
    }
    if (!isAuthorized(ctx.scope, 'write', { scope: 'project', projectId: ctx.project.id })) {
      return c.json(
        { ok: false, code: 'forbidden', message: 'token scope does not cover this project' },
        403,
      );
    }
    const body = await readJson(c);
    const parsed = sessionPostSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, code: 'invalid_input', message: zodMessage(parsed.error) }, 400);
    }
    try {
      const result = deps.agentSessions.ensure({
        id: parsed.data.id,
        tokenId: ctx.token.id,
        projectId: ctx.project.id,
        agent: parsed.data.agent ?? 'unknown',
        description: parsed.data.description ?? null,
        cwd: parsed.data.cwd ?? null,
      });
      deps.sweep?.(ctx.project.id);
      return c.json({
        ok: true,
        sessionId: result.session.id,
        scope: 'project' as const,
        projectId: ctx.project.id,
        startedAt: result.session.startedAt.toISOString(),
        title: result.session.title,
        created: result.created,
      });
    } catch (err) {
      return domainErr(c, err);
    }
  });

  app.post('/:slug/sessions/:id/summary', async (c) => {
    const ctx = c.get('rembricCtx');
    if (!ctx.project) {
      return c.json({ ok: false, code: 'project_not_found', slug: c.req.param('slug') }, 404);
    }
    const sessionId = c.req.param('id');
    const blocked = rejectIfDeleted(deps, sessionId, ctx.token.id);
    if (blocked) {
      return c.json(blocked.body, blocked.status);
    }
    const body = await readJson(c);
    const parsed = sessionSummarySchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ ok: false, code: 'invalid_input', message: zodMessage(parsed.error) }, 400);
    }
    try {
      // HTTP path truncates server-side: bash / Python / opencode writers
      // cannot react to invalid_input. The MCP path rejects (agent retries).
      // See apps/server/src/services/agent-sessions.ts:SUMMARY_MAX_CHARS.
      const updated = deps.agentSessions.writeSummary(sessionId, {
        tokenId: ctx.token.id,
        summary: truncateSummary(parsed.data.summary),
        title: parsed.data.title,
        final: parsed.data.final,
      });
      return c.json({
        ok: true,
        sessionId: updated.id,
        summary: updated.summary,
        title: updated.title,
        summaryFinal: updated.summaryFinal,
        titleFinal: updated.titleFinal,
      });
    } catch (err) {
      return domainErr(c, err);
    }
  });

  app.post('/:slug/sessions/:id/end', async (c) => {
    const ctx = c.get('rembricCtx');
    if (!ctx.project) {
      return c.json({ ok: false, code: 'project_not_found', slug: c.req.param('slug') }, 404);
    }
    const sessionId = c.req.param('id');
    const blocked = rejectIfDeleted(deps, sessionId, ctx.token.id);
    if (blocked) {
      return c.json(blocked.body, blocked.status);
    }
    const body = await readJson(c);
    const parsed = sessionEndSchema.safeParse(body ?? {});
    if (!parsed.success) {
      return c.json({ ok: false, code: 'invalid_input', message: zodMessage(parsed.error) }, 400);
    }
    try {
      // HTTP path truncates server-side (see /summary handler above).
      const updated = deps.agentSessions.end(sessionId, {
        tokenId: ctx.token.id,
        summary:
          parsed.data.summary !== undefined ? truncateSummary(parsed.data.summary) : undefined,
        title: parsed.data.title,
        final: parsed.data.final,
      });
      return c.json({
        ok: true,
        sessionId: updated.id,
        endedAt: updated.endedAt?.toISOString() ?? null,
        summary: updated.summary,
        title: updated.title,
      });
    } catch (err) {
      return domainErr(c, err);
    }
  });

  app.all('/*', (c) => c.json({ ok: false, code: 'not_found', path: c.req.path }, 404));

  return app;
}

function authMiddleware(deps: ApiRouterDeps) {
  return async (c: ApiContext, next: () => Promise<void>) => {
    const slug = c.req.param('slug');
    try {
      const ctx = authenticate({
        authorization: c.req.header('authorization'),
        pathSlug: slug,
        tokens: deps.tokens,
        projects: deps.projects,
      });
      c.set('rembricCtx', ctx);
    } catch (err) {
      if (err instanceof AuthError) {
        return c.json({ ok: false, code: err.code, message: err.message }, err.status);
      }
      throw err;
    }
    await next();
  };
}

function rejectIfDeleted(
  deps: ApiRouterDeps,
  sessionId: string,
  callerTokenId: string,
): { status: 404 | 409; body: { ok: false; code: string; message: string } } | null {
  const row = deps.agentSessions.getById(sessionId);
  if (!row || row.tokenId !== callerTokenId) {
    return {
      status: 404,
      body: { ok: false, code: 'session_not_found', message: `session '${sessionId}' not found` },
    };
  }
  if (row.deletedAt) {
    return {
      status: 409,
      body: {
        ok: false,
        code: 'session_deleted',
        message: `session '${sessionId}' is soft-deleted`,
      },
    };
  }
  return null;
}

function domainErr(c: ApiContext, err: unknown) {
  if (err instanceof DomainError) {
    const status = statusForCode(err.code);
    return c.json({ ok: false, code: err.code, message: err.message }, status);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ ok: false, code: 'internal_error', message }, 500);
}

function statusForCode(code: string): 400 | 401 | 403 | 404 | 409 | 500 {
  switch (code) {
    case 'invalid_input':
    case 'invalid_scope':
    case 'invalid_slug':
      return 400;
    case 'token_invalid':
    case 'token_revoked':
    case 'token_expired':
    case 'token_not_found':
    case 'admin_token_required':
      return 401;
    case 'forbidden':
    case 'scope_locked':
    case 'project_archived':
      return 403;
    case 'session_not_found':
    case 'project_not_found':
    case 'memory_not_found':
      return 404;
    case 'session_already_ended':
    case 'session_active_must_end':
    case 'project_switch_requires_confirm':
    case 'id_collision':
    case 'conflict':
      return 409;
    default:
      return 500;
  }
}

function zodMessage(err: z.ZodError): string {
  return err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

async function readJson(c: ApiContext): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}
