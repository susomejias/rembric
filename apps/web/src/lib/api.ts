import { randomUUID } from 'node:crypto';

import { type AgentSessionsService, type RequestContext } from '@rembric/core';

import { AuthError, authenticate, isDomainError } from './auth';
import { getServices } from './services';

export interface ApiErrorBody {
  ok: false;
  code: string;
  message: string;
}

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

function errorBody(code: string, message: string): ApiErrorBody {
  return { ok: false, code, message };
}

export function projectNotFound(slug: string): Response {
  return json({ ok: false, code: 'project_not_found', slug }, 404);
}

export function forbidden(message = 'token scope does not cover this project'): Response {
  return json(errorBody('forbidden', message), 403);
}

export function adminRequired(): Response {
  return json(errorBody('forbidden', 'admin token required for debug surfaces'), 403);
}

export function invalidInput(message: string): Response {
  return json(errorBody('invalid_input', message), 400);
}

export function notFound(path: string): Response {
  return json({ ok: false, code: 'not_found', path }, 404);
}

export function rateLimited(message: string, retryAfterSeconds: number): Response {
  return Response.json(errorBody('rate_limited', message), {
    status: 429,
    headers: { 'Retry-After': String(retryAfterSeconds) },
  });
}

function internalError(err: unknown, context: string): Response {
  const errorId = randomUUID();
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(context, { errorId, message, stack });
  return json(
    {
      ok: false,
      code: 'internal_error',
      message: 'An unexpected error occurred.',
      errorId,
    },
    500,
  );
}

export function statusForCode(code: string): 400 | 401 | 403 | 404 | 409 | 500 {
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
    case 'session_deleted':
      return 409;
    default:
      return 500;
  }
}

export function domainErr(err: unknown): Response {
  if (isDomainError(err)) {
    return json(errorBody(err.code, err.message), statusForCode(err.code));
  }
  return internalError(err, 'unhandled API request error');
}

export async function readJson(request: Request): Promise<unknown> {
  try {
    const body: unknown = await request.json();
    return body;
  } catch {
    return undefined;
  }
}

export type AuthOutcome = { ok: true; ctx: RequestContext } | { ok: false; response: Response };

export async function authenticateRequest(request: Request, slug: string): Promise<AuthOutcome> {
  const services = getServices();
  const identity = networkIdentity(request);
  const locked = services.authLockout.check(identity);
  if (locked.locked) {
    return {
      ok: false,
      response: rateLimited('too many failed attempts', locked.retryAfterSeconds),
    };
  }
  try {
    const ctx = await authenticate({
      authorization: request.headers.get('authorization') ?? undefined,
      pathSlug: slug,
      tokens: services.tokens,
      projects: services.projects,
      oauth: services.oauth,
    });
    services.authLockout.recordSuccess(identity);
    return { ok: true, ctx };
  } catch (err) {
    if (err instanceof AuthError) {
      services.authLockout.recordFailure(identity);
      return { ok: false, response: json(errorBody(err.code, err.message), err.status) };
    }
    return { ok: false, response: internalError(err, 'unhandled API authentication error') };
  }
}

function networkIdentity(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}

export function rejectIfDeleted(
  agentSessions: AgentSessionsService,
  sessionId: string,
  callerTokenId: string,
  projectId: string,
): { status: 404 | 409; body: ApiErrorBody } | null {
  const row = agentSessions.getById(sessionId);
  if (!row || row.tokenId !== callerTokenId || row.projectId !== projectId) {
    return {
      status: 404,
      body: errorBody('session_not_found', `session '${sessionId}' not found`),
    };
  }
  if (row.deletedAt) {
    return {
      status: 409,
      body: errorBody('session_deleted', `session '${sessionId}' is soft-deleted`),
    };
  }
  return null;
}

export function send(status: number, body: ApiErrorBody): Response {
  return json(body, status);
}

export function snippet(content: string, max: number): string {
  if (content.length <= max) return content;
  return content.slice(0, max - 1) + '…';
}

export function methodFallback(request: Request): Response {
  return notFound(requestPath(request));
}

function requestPath(request: Request): string {
  try {
    return new URL(request.url).pathname;
  } catch {
    return request.url;
  }
}
