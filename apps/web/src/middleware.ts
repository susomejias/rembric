import { NextResponse, type NextRequest } from 'next/server';

import { relativeRedirect } from './lib/http-redirect';

import { getSession } from '@/lib/session';

export const runtime = 'nodejs';

export const config = {
  matcher: ['/dashboard/:path*'],
};

const LOGIN_PATH = '/dashboard/login';

const LOGIN_POST_PATH = '/dashboard/login/verify';

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

  return relativeRedirect('/dashboard/login', request);
}
