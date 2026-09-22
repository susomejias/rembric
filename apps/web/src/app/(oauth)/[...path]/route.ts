import { notFound } from 'next/navigation';

import { handleOAuthRequest, isOAuthPath } from '../../../lib/oauth';

/**
 * The OAuth 2.1 authorization-server endpoints, served at the application root:
 * `/authorize`, `/token`, `/register`, `/revoke` and `/.well-known/oauth-*`.
 *
 * This is a catch-all because RFC 8414 puts the metadata endpoints under the
 * literal path segment `/.well-known`, which no ordinary route file can claim
 * on its own here. The route group is transparent to the URL, so the paths stay
 * stable.
 *
 * Everything the catch-all swallows that is NOT an authorization-server path
 * gets the app's own 404 (`notFound()`), so the surface this adds is exactly
 * five endpoint families wide.
 *
 * `force-dynamic` is mandatory: a route handler is cacheable by default, and a
 * cached authorization response would hand one client another's redirect.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ path?: string[] }> };

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  // `params.path` is undefined for the bare root and the segments otherwise.
  const pathname = `/${(path ?? []).join('/')}`;
  if (!isOAuthPath(pathname)) notFound();
  return handleOAuthRequest(request, pathname);
}

// Every method the SDK router can answer, including the 405 it returns for the
// ones an endpoint does not support (a route file only receives the methods it
// exports) and the CORS preflight `OPTIONS` a web-based MCP client sends.
export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
