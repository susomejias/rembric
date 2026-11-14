import { OAuthError, OAuthErrorCode } from '@modelcontextprotocol/server';

export type ReplyHeaders = Map<string, string>;

export interface OAuthReply {
  status: number;
  headers: ReplyHeaders;
  body: string | null;
}

export class BodyParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BodyParseError';
  }
}

export type BodyKind = 'json' | 'form';

const BODY_LIMIT_BYTES = 100 * 1024;
const MEDIA_TYPE: Record<BodyKind, string> = {
  json: 'application/json',
  form: 'application/x-www-form-urlencoded',
};
const BODYLESS_STATUSES = new Set([204, 205, 304]);
const CORS_ALLOWED_METHODS = 'GET,HEAD,PUT,PATCH,POST,DELETE';

export function jsonReply(status: number, headers: ReplyHeaders, value: unknown): OAuthReply {
  headers.set('content-type', 'application/json; charset=utf-8');
  return { status, headers, body: JSON.stringify(value) };
}

export function redirectReply(headers: ReplyHeaders, location: string): OAuthReply {
  headers.set('location', location);
  return { status: 302, headers, body: null };
}

export function oauthErrorReply(headers: ReplyHeaders, err: unknown): OAuthReply {
  const error = OAuthError.isInstance(err)
    ? err
    : new OAuthError(OAuthErrorCode.ServerError, 'Internal Server Error');
  const status = error.code === String(OAuthErrorCode.ServerError) ? 500 : 400;
  return jsonReply(status, headers, error.toResponseObject());
}

export function corsPreflight(request: Request, headers: ReplyHeaders): OAuthReply | null {
  headers.set('access-control-allow-origin', '*');
  if (request.method.toUpperCase() !== 'OPTIONS') return null;
  headers.set('access-control-allow-methods', CORS_ALLOWED_METHODS);
  headers.set('vary', 'Access-Control-Request-Headers');
  const requested = request.headers.get('access-control-request-headers');
  if (requested !== null && requested.length > 0) {
    headers.set('access-control-allow-headers', requested);
  }
  headers.set('content-length', '0');
  return { status: 204, headers, body: null };
}

export function refuseMethod(
  request: Request,
  headers: ReplyHeaders,
  allowed: readonly string[],
): OAuthReply | null {
  if (allowed.includes(request.method)) return null;
  headers.set('allow', allowed.join(', '));
  const error = new OAuthError(
    OAuthErrorCode.MethodNotAllowed,
    `The method ${request.method} is not allowed for this endpoint`,
  );
  return jsonReply(405, headers, error.toResponseObject());
}

export function queryParams(url: URL): Record<string, string> {
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, name) => {
    query[name] = value;
  });
  return query;
}

export async function readBody(request: Request, kind: BodyKind): Promise<unknown> {
  if (request.method === 'GET' || request.method === 'HEAD') return undefined;
  const headers = request.headers;
  const type = headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (type !== MEDIA_TYPE[kind]) return undefined;

  const encoding = headers.get('content-encoding')?.trim().toLowerCase() || 'identity';
  if (encoding !== 'identity')
    throw new BodyParseError(`unsupported content encoding "${encoding}"`);
  if (Number(headers.get('content-length') ?? 0) > BODY_LIMIT_BYTES) {
    throw new BodyParseError('entity too large');
  }
  const bytes = await request.arrayBuffer();
  if (bytes.byteLength > BODY_LIMIT_BYTES) throw new BodyParseError('entity too large');
  const text = new TextDecoder().decode(bytes);

  if (kind === 'json') return text.length === 0 ? {} : (JSON.parse(text) as unknown);
  const form = new Map<string, string[]>();
  for (const [name, value] of new URLSearchParams(text)) {
    form.set(name, [...(form.get(name) ?? []), value]);
  }
  return Object.fromEntries(
    [...form].map(([name, values]) => [name, values.length === 1 ? values[0] : values]),
  );
}

export function toResponse(request: Request, reply: OAuthReply): Response {
  const bodyless = request.method.toUpperCase() === 'HEAD' || BODYLESS_STATUSES.has(reply.status);
  const body = bodyless || reply.body === null ? null : new TextEncoder().encode(reply.body);
  return new Response(body, { status: reply.status, headers: Object.fromEntries(reply.headers) });
}
