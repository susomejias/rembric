import { runWithContext } from '@rembric/core';

import { verifyMcpBearerToken } from '../../../lib/mcp-auth';
import { getMcpSurface } from '../../../lib/mcp-server';
import { getServices } from '../../../lib/services';

/**
 * `/mcp` and `/mcp/<slug>` — the MCP Streamable HTTP endpoint, at the same path
 * `apps/server` serves it on, so no client config changes with the port. This
 * route owns only what is HTTP: the path slug, pre-auth identity, the bearer
 * gate, and installing the per-request context the tools read. The protocol
 * lives in `lib/mcp-server.ts` (v2 handler + sessionful 2025-era leg) and the
 * credentials in `lib/mcp-auth.ts`.
 *
 * `force-dynamic` is mandatory: a route handler is cacheable by default in the
 * App Router, and a cached MCP exchange would replay one caller's tool result
 * to another.
 */
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ path?: string[] }> };

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  // `params.path` is undefined for `/mcp` and the segments after it otherwise.
  // Only the first segment is a project slug — `apps/server`'s
  // `extractProjectSlug` stops at the next `/` the same way.
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

  // The two hardening gates `apps/server/src/server/http.ts` applies before the
  // transport: the body cap (`MAX_BODY_BYTES`, step 2) and the opt-in
  // DNS-rebinding Host/Origin allow-lists. Both are only reachable after the
  // bearer gate, exactly as they are there — an unauthenticated caller learns
  // nothing about either.
  const oversized = await bodyTooLarge(request);
  if (oversized !== null) return oversized;

  const rebinding = dnsRebindingRefusal(request);
  if (rebinding !== null) return rebinding;

  const { authInfo, requestContext } = auth;
  const sessionId = request.headers.get('mcp-session-id');

  // The tools never read `AuthInfo`: they read this store
  // (`packages/mcp/src/_shared.ts::resolveEffectiveScope`), which is why the
  // handler runs inside `runWithContext`. `mcpSessionId` is the transport's,
  // and null on the initial `initialize` of a connection.
  return runWithContext({ ...requestContext, mcpSessionId: sessionId }, () =>
    getMcpSurface().fetch(request, { authInfo, requestedSlug: slug }),
  );
}

/** `apps/server/src/config.ts::MAX_BODY_BYTES`'s default. */
const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

/**
 * The declared cap, or the server default when unset or unparseable. Read per
 * request (not cached at module scope) so a test can drive it, the same inline
 * `process.env` read `lib/mcp-server.ts` uses for its other knobs.
 */
function maxBodyBytes(): number {
  const raw = process.env['MAX_BODY_BYTES'];
  if (raw === undefined || raw.trim().length === 0) return DEFAULT_MAX_BODY_BYTES;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_MAX_BODY_BYTES;
}

/**
 * `apps/server/src/server/http.ts`'s 413 arm. The body is measured on a CLONE
 * so the transport still receives its own untouched stream — the same buffering
 * the server does in `readJsonBody`, which reads the whole body before deciding.
 */
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

/**
 * `McpTransportManager`'s DNS-rebinding gate
 * (`packages/mcp/src/transport.ts:enableDnsRebindingProtection`), moved into the
 * route because the web surface builds its transport in `lib/mcp-server.ts`.
 * Both allow-lists are opt-in: with neither set the gate is inactive, so a
 * non-browser MCP client that sends no Origin/Host is unaffected by default.
 * The refusal body is the SDK's own `createJsonErrorResponse(403, -32000, …)`.
 */
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

/** `apps/server/src/config.ts::splitCsv`, verbatim. */
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

/**
 * Mirrors `apps/server/src/server/http.ts::isValidSlug`. A slug that fails this
 * is refused before any authentication, exactly as it is there: it cannot name
 * a project, so it is a malformed request rather than an unauthorized one.
 */
const SLUG_RE = /^[a-zA-Z0-9_.-]+$/;
function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 128 && SLUG_RE.test(slug);
}

/**
 * Pre-auth lockout key. `apps/server` reads the socket address; a route handler
 * cannot reach it, so the first `x-forwarded-for` hop is the closest available
 * substitute and a direct request shares the `'unknown'` bucket — the same
 * decision `lib/api.ts::networkIdentity` documents for the `/api` surface.
 */
function clientIdentity(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return 'unknown';
}
