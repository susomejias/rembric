import { deriveSessionKey, SessionsService, type SessionContext } from '@rembric/core';

import { getServices } from './services';

/**
 * The cookie is `SessionsService`'s signed `<sessionId>.<hmac>` naming a row in
 * `dashboard_sessions`, never the token plaintext: logout deletes that row, and
 * the OAuth consent endpoint verifies the same cookie through the same service.
 */

/** `sessions.ts::SESSION_TTL_MS`, converted to the seconds `Max-Age` takes. */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** Scoped to `/dashboard`, so `/mcp` and `/api` never receive this cookie. */
const COOKIE_PATH = '/dashboard';

/**
 * Structural: the middleware's request store and a server component's store are
 * different classes with the same `get`.
 */
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

/**
 * `null` is fail-closed, not a missing feature: with no key nothing can be signed
 * or verified, so every caller refuses instead of admitting an unverifiable
 * cookie. This process may not fail to boot the way `bootstrap.ts` may.
 */
function sessionSecretBase(): string | null {
  const configured = process.env['REMBRIC_SESSION_SECRET'] ?? process.env['REMBRIC_ADMIN_TOKEN'];
  return configured !== undefined && configured.length > 0 ? configured : null;
}

/**
 * Cached on `globalThis` — the same reason `lib/db.ts` caches its handle: Next
 * re-evaluates modules on an HMR edit, and a second service over the same rows
 * would mint a second view of the same sessions. The `null` is cached too, so a
 * misconfiguration is not retried on every request.
 */
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

/**
 * Returns the session with the cached service that verified it, because the same
 * service owns the CSRF check the row's `csrfSecret` feeds. `source` is the
 * test-injected cookie store; the `next/headers` import is deferred to the
 * fallback because it is request-scoped.
 */
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

/** Path and `SameSite` are not optional: a browser only replaces a cookie whose name AND path match. */
export function clearSessionCookie(): SessionCookie {
  return {
    name: SessionsService.cookieName(),
    value: '',
    options: cookieOptions(0),
  };
}

/** Deletes the row so a copied cookie value cannot be replayed; the caller passes the id it already resolved. */
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
