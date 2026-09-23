import type { NextRequest, NextResponse } from 'next/server';

import { relativeRedirect } from '@/lib/http-redirect';
import { clearSessionCookie, destroySession, getSession } from '@/lib/session';

export function POST(request: NextRequest): NextResponse {
  const session = getSession(request.cookies);
  if (session !== null) destroySession(session.session.id);

  const cookie = clearSessionCookie();
  const response = relativeRedirect('/dashboard/login', request);
  response.cookies.set(cookie.name, cookie.value, cookie.options);
  return response;
}
