import { NextResponse, type NextRequest } from 'next/server';

import { clearSessionCookie, destroySession, getSession } from '@/lib/session';

/**
 * `POST /dashboard/logout`.
 *
 * Two effects, in this order and for one reason each: the row is deleted so the
 * cookie value cannot be replayed even if it was copied out of the browser, and
 * the cookie is cleared so the browser stops sending it. Destroying the row is
 * the load-bearing half; clearing the cookie alone would leave a live session in
 * `dashboard_sessions` that the next holder of that string could use.
 *
 * The row is resolved through `getSession`, which verifies the signature first,
 * so only a value this process signed can reach the delete.
 *
 * `middleware.ts` exempts this path, so a request carrying an expired or stale
 * cookie still reaches here and still gets the cookie cleared instead of a
 * redirect it cannot satisfy.
 */

export function POST(request: NextRequest): NextResponse {
  const session = getSession(request.cookies);
  if (session !== null) destroySession(session.session.id);

  const cookie = clearSessionCookie();
  // 302 for the same reason the login redirect is: the browser must follow up
  // with a GET of the login page, not a second POST of this request.
  const response = NextResponse.redirect(new URL('/dashboard/login', request.url), 302);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
