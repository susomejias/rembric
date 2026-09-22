import { NextResponse, type NextRequest } from 'next/server';

import { clearSessionCookie, destroySession, getSession } from '@/lib/session';

export function POST(request: NextRequest): NextResponse {
  const session = getSession(request.cookies);
  if (session !== null) destroySession(session.session.id);

  const cookie = clearSessionCookie();
  const response = NextResponse.redirect(new URL('/dashboard/login', request.url), 302);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
