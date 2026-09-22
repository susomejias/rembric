import { runWithContext } from '@rembric/core';

import { verifyMcpBearerToken } from '../../../lib/mcp-auth';
import { getMcpSurface } from '../../../lib/mcp-server';
import { applyMcpRateLimit } from '../../../lib/rate-limit';
import { getServices } from '../../../lib/services';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ path?: string[] }> };

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const slug = path?.[0] ?? null;

  if (slug !== null && !isValidSlug(slug)) {
    return Response.json(
      {
        ok: false,
        code: 'invalid_project_slug',
        message: `project slug '${slug}' must match /^[a-zA-Z0-9_.-]+$/`,
      },
      { status: 400 },
    );
  }

  const auth = await verifyMcpBearerToken({
    authorization: request.headers.get('authorization'),
    slug,
    identity: clientIdentity(request),
    services: getServices(),
  });
  if (!auth.ok) return auth.response;

  let rateLimitResponse: Response | null;
  try {
    rateLimitResponse = await applyMcpRateLimit(
      auth.requestContext.token.id,
      auth.requestContext.token.name,
    );
  } catch (err) {
    console.error('[mcp] rate limiter failed', err);
    return Response.json(
      { ok: false, code: 'internal_error', message: 'An unexpected error occurred.' },
      { status: 500 },
    );
  }
  if (rateLimitResponse !== null) return rateLimitResponse;

  const oversized = await bodyTooLarge(request);
  if (oversized !== null) return oversized;

  const rebinding = dnsRebindingRefusal(request);
  if (rebinding !== null) return rebinding;

  const { authInfo, requestContext } = auth;
  const sessionId = request.headers.get('mcp-session-id');

  return runWithContext({ ...requestContext, mcpSessionId: sessionId }, () =>
    getMcpSurface().fetch(request, { authInfo, requestedSlug: slug }),
  );
}

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

function maxBodyBytes(): number {
  const raw = process.env['MAX_BODY_BYTES'];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_MAX_BODY_BYTES;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BODY_BYTES;
}

async function bodyTooLarge(request: Request): Promise<Response | null> {
  const method = request.method.toUpperCase();
  if (method !== 'POST' && method !== 'DELETE') return null;

  const max = maxBodyBytes();
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isInteger(n) && n > max) return payloadTooLarge(max);
  }
  const bytes = await request.clone().arrayBuffer();
  return bytes.byteLength > max ? payloadTooLarge(max) : null;
}

function payloadTooLarge(max: number): Response {
  return Response.json(
    { ok: false, code: 'payload_too_large', message: `request body exceeds the ${max}-byte limit` },
    { status: 413, headers: { Connection: 'close' } },
  );
}

function dnsRebindingRefusal(request: Request): Response | null {
  const allowedHosts = splitCsv(process.env['REMBRIC_MCP_ALLOWED_HOSTS']);
  const allowedOrigins = splitCsv(process.env['REMBRIC_MCP_ALLOWED_ORIGINS']);
  if (allowedHosts.length === 0 && allowedOrigins.length === 0) return null;

  if (allowedHosts.length > 0) {
    const host = request.headers.get('host');
    if (host === null || !allowedHosts.includes(host)) return invalidHeader('Host', host);
  }
  if (allowedOrigins.length > 0) {
    const origin = request.headers.get('origin');
    if (origin !== null && !allowedOrigins.includes(origin)) {
      return invalidHeader('Origin', origin);
    }
  }
  return null;
}

function invalidHeader(name: 'Host' | 'Origin', value: string | null): Response {
  return Response.json(
    {
      jsonrpc: '2.0',
      error: { code: -32000, message: `Invalid ${name} header: ${value}` },
      id: null,
    },
    { status: 403 },
  );
}

function splitCsv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;

const SLUG_RE = /^[a-zA-Z0-9_.-]+$/;
function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 128 && SLUG_RE.test(slug);
}

function clientIdentity(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}
