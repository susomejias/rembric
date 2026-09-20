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
