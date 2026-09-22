import { deriveSessionKey, SessionsService, type SessionContext } from '@rembric/core';

import { getServices } from './services';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

const COOKIE_PATH = '/dashboard';

export interface SessionCookieSource {
  get(name: string): { value: string } | undefined;
}

export interface SessionCookie {
  name: string;
  value: string;
  options: {
    httpOnly: true;
    sameSite: 'lax';
    path: string;
    secure: boolean;
    maxAge: number;
  };
}

const globalForSessions = globalThis as typeof globalThis & {
  __rembricDashboardSessions?: SessionsService | null;
};

function sessionSecretBase(): string | null {
  const configured = process.env['REMBRIC_SESSION_SECRET'] ?? process.env['REMBRIC_ADMIN_TOKEN'];
  return configured !== undefined && configured.length > 0 ? configured : null;
}

function sessionsService(): SessionsService | null {
  const cached = globalForSessions.__rembricDashboardSessions;
  if (cached !== undefined) return cached;

  const base = sessionSecretBase();
  const built =
    base === null ? null : new SessionsService(getServices().repos, deriveSessionKey(base));
  globalForSessions.__rembricDashboardSessions = built;
  return built;
}

export function getSession(source: SessionCookieSource): SessionContext | null {
  const sessions = sessionsService();
  if (sessions === null) return null;
  return sessions.resolve(source.get(SessionsService.cookieName())?.value);
}

export async function resolveDashboardSession(
  source?: SessionCookieSource,
): Promise<{ session: SessionContext; sessions: SessionsService } | null> {
  const sessions = sessionsService();
  if (sessions === null) return null;
  const cookies = source ?? (await requestCookieSource());
  const resolved = sessions.resolve(cookies.get(SessionsService.cookieName())?.value);
  if (resolved === null) return null;
  return { session: resolved, sessions };
}

export async function dashboardCsrfToken(
  formName: string,
  source?: SessionCookieSource,
): Promise<string | null> {
  const resolved = await resolveDashboardSession(source);
  if (resolved === null) return null;
  return resolved.sessions.csrfToken(resolved.session.session, formName);
}

async function requestCookieSource(): Promise<SessionCookieSource> {
  const { cookies } = await import('next/headers');
  return cookies();
}

export function createSessionCookie(tokenId: string): SessionCookie | null {
  const sessions = sessionsService();
  if (sessions === null) return null;
  const { cookie } = sessions.create(tokenId);
  return {
    name: SessionsService.cookieName(),
    value: cookie,
    options: cookieOptions(SESSION_TTL_SECONDS),
  };
}

export function clearSessionCookie(): SessionCookie {
  return {
    name: SessionsService.cookieName(),
    value: '',
    options: cookieOptions(0),
  };
}

export function destroySession(sessionId: string): void {
  sessionsService()?.destroy(sessionId);
}

function cookieOptions(maxAge: number): SessionCookie['options'] {
  return {
    httpOnly: true,
    sameSite: 'lax',
    path: COOKIE_PATH,
    secure: (process.env['REMBRIC_PUBLIC_URL'] ?? '').startsWith('https:'),
    maxAge,
  };
}
