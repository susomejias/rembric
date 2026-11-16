import { randomUUID } from 'node:crypto';

import { DEFAULT_MAX_REQUEST_BODY_SIZE, readRequestBody } from '@modelcontextprotocol/server';
import { type AgentSessionsService, type RequestContext } from '@rembric/core';

import { AuthError, authenticate, isDomainError } from './auth';
import { clientIdentity } from './client-identity';
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

export function statusForCode(code: string): 400 | 401 | 403 | 404 | 409 | 413 | 500 {
  switch (code) {
    case 'invalid_input':
    case 'invalid_scope':
    case 'invalid_slug':
    case 'invalid_repository_fingerprint':
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
    case 'repository_ambiguous':
    case 'repository_already_bound':
      return 409;
    case 'payload_too_large':
      return 413;
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

export function maxRequestBodyBytes(): number {
  const parsed = Number(process.env['MAX_BODY_BYTES']);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_REQUEST_BODY_SIZE;
}

export type JsonBody = { ok: true; body: unknown } | { ok: false; response: Response };

export async function readJson(request: Request): Promise<JsonBody> {
  const maxBytes = maxRequestBodyBytes();
  let text: string;
  try {
    const read = await readRequestBody(request, maxBytes);
    if (read.tooLarge) {
      await request.body?.cancel();
      const code = 'payload_too_large';
      const message = `request body exceeds ${maxBytes} bytes`;
      return { ok: false, response: json(errorBody(code, message), statusForCode(code)) };
    }
    text = read.text;
  } catch {
    return { ok: true, body: undefined };
  }
  try {
    return { ok: true, body: JSON.parse(text) as unknown };
  } catch {
    return { ok: true, body: undefined };
  }
}

export type AuthOutcome = { ok: true; ctx: RequestContext } | { ok: false; response: Response };

export async function authenticateRequest(
  request: Request,
  slug: string | undefined,
): Promise<AuthOutcome> {
  const services = getServices();
  const identity = clientIdentity(request);
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
