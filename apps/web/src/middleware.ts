import { NextResponse, type NextRequest } from 'next/server';

import { getSession } from '@/lib/session';

/**
 * Dashboard authentication — `dashboard-router.ts`'s `app.use('*')` middleware,
 * moved to the one place Next runs before a dashboard route does.
 *
 * Node runtime, on purpose and not by default: the cookie is verified against
 * `dashboard_sessions` (`lib/session.ts`), which needs `node:crypto` for the
 * signature and the SQLite handle for the row, and neither exists in the Edge
 * runtime. Next only routes this file to Node when the runtime is declared
 * (`next/dist/build/index.js`: `staticInfo.runtime === 'nodejs'`), so the export
 * below is load-bearing rather than decoration.
 *
 * Exemptions are by path rather than by matcher, because the matcher cannot say
 * "everything under `/dashboard` except these", and a matcher that missed
 * `/dashboard` itself would leave the overview — the first page an operator
 * loads — unguarded. `/api`, `/mcp` and `/healthz` are outside the matcher
 * entirely: they carry their own bearer/token authentication and are never
 * reached with this cookie (it is scoped to `Path=/dashboard`).
 */

export const runtime = 'nodejs';

export const config = {
  matcher: ['/dashboard/:path*'],
};

const LOGIN_PATH = '/dashboard/login';

/**
 * Where the sign-in POST handler actually lives. The App Router refuses
 * `page.tsx` and `route.ts` in the same segment (measured: with the handler at
 * `login/route.ts` every `/dashboard/login` request answered 500,
 * "Conflicting route and page at /dashboard/login"), so the handler sits one
 * segment down and this rewrite is what keeps the public URL unchanged. A
 * rewrite, not a redirect: a redirect would answer the form POST with a GET to a
 * path that has no handler, and the token would never be read.
 */
const LOGIN_POST_PATH = '/dashboard/login/verify';

/** The anonymous pair and the brand assets. */
const PUBLIC_PATHS = new Set([LOGIN_PATH, '/dashboard/logout']);

export function middleware(request: NextRequest): NextResponse {
  const { pathname } = request.nextUrl;

  if (pathname === LOGIN_PATH && request.method === 'POST') {
    return NextResponse.rewrite(new URL(LOGIN_POST_PATH, request.url));
  }

  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith('/dashboard/assets/')) {
    return NextResponse.next();
  }
  if (getSession(request.cookies) !== null) return NextResponse.next();

  // Bare `/dashboard/login`, with no `next`: the only destination the login
  // route's sanitiser accepts is `/dashboard/oauth/...`, and this app serves the
  // consent card at `/dashboard/oauth-consent` instead (a path divergence the
  // consent slice disclosed). Emitting the server's prefix here would land a
  // freshly signed-in operator on a route this app does not serve.
  //
  // Status 302, not the 307 `NextResponse.redirect` defaults to: a 307 preserves
  // the method, so the browser would re-POST the token to `/dashboard`.
  return NextResponse.redirect(new URL('/dashboard/login', request.url), 302);
}
