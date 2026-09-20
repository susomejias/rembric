import { deriveSessionKey, SessionsService, type SessionContext } from '@rembric/core';

import { getServices } from './services';

/**
 * Cookie sessions for `/dashboard` — the authentication half of
 * `apps/server/src/server/dashboard-router.ts`, re-expressed for an app that has
 * no Hono context.
 *
 * The cookie is `SessionsService`'s signed `<sessionId>.<hmac>` naming a row in
 * `dashboard_sessions`, NOT the token plaintext. Two independent reasons:
 *
 *  - `openspec/specs/dashboard` fixes the format ("set an httpOnly, SameSite=Lax,
 *    signed cookie referencing a row in `dashboard_sessions`"), and logout's
 *    contract is the row's deletion — a plaintext cookie would have no row to
 *    delete.
 *  - Both servers share the cookie while the port is in flight: the OAuth
 *    authorization endpoint the consent card POSTs to verifies this exact cookie
 *    through this exact service (`app/dashboard/oauth-consent/session.ts`). A
 *    plaintext value would read as "no session" there.
 *
 * The signing key is `bootstrap.ts`'s resolution — `REMBRIC_SESSION_SECRET`, else
 * the admin token — so a session minted here resolves there, and vice versa.
 * Only the *key derivation* is shared that way; each process holds its own
 * `SessionsService` over its own connection to the same SQLite file.
 */

/** `sessions.ts::SESSION_TTL_MS`, in the unit `Set-Cookie`'s `Max-Age` takes. */
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

/** `dashboard-router.ts`: `path: '/dashboard'`, so `/mcp` and `/api` never receive this cookie. */
const COOKIE_PATH = '/dashboard';

/**
 * Anything that can hand a cookie back by name: `NextRequest['cookies']`,
 * `cookies()` from `next/headers`, or a `Map`. Deliberately structural, because
 * the middleware's request store and a server component's store are different
 * classes with the same `get`.
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
    /** `bootstrap.ts`: `REMBRIC_PUBLIC_URL` starting with `https:`, else false. */
    secure: boolean;
    maxAge: number;
  };
}

const globalForSessions = globalThis as typeof globalThis & {
  __rembricDashboardSessions?: SessionsService | null;
};

/**
 * `bootstrap.ts` throws when neither variable is set, because that process is
 * allowed to refuse to boot; this one is not (Next turns a throwing
 * `register()` into a fatal boot error), and `lib/process.ts` already mints an
 * admin token when the variable is absent. The `null` is the fail-closed answer
 * rather than a missing feature: with no key nothing can be signed or verified,
 * so every caller below refuses instead of admitting an unverifiable cookie.
 */
function sessionSecretBase(): string | null {
  const configured = process.env['REMBRIC_SESSION_SECRET'] ?? process.env['REMBRIC_ADMIN_TOKEN'];
  return configured !== undefined && configured.length > 0 ? configured : null;
}

/**
 * One service per process, cached on `globalThis` — the same reason `lib/db.ts`
 * caches the handle: Next re-evaluates modules on an HMR edit, and a second
 * service over the same rows would mint a second view of the same sessions.
 * Caching the `null` too is intentional (a misconfiguration is not retried on
 * every request; the operator restarts after setting the variable).
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

/**
 * The live session this request's cookie names, or `null` when it is absent,
 * unsigned, tampered with, expired or already logged out. `null` is the only
 * refusal a caller has to handle — the store's own failure modes are not
 * distinguished, exactly as `dashboard-router.ts`'s middleware does not
 * distinguish them.
 */
export function getSession(source: SessionCookieSource): SessionContext | null {
  const sessions = sessionsService();
  if (sessions === null) return null;
  return sessions.resolve(source.get(SessionsService.cookieName())?.value);
}

/**
 * The `Set-Cookie` a successful login writes, or `null` when this process has no
 * signing key. A `null` is not a silent success: the login route answers it with
 * the `unavailable` error rather than a cookie no later request could verify.
 */
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

/**
 * The `Set-Cookie` that clears the session: same name, same path, same
 * attributes, empty value and `Max-Age=0`. Path and `SameSite` are not optional
 * here — a browser only replaces a cookie whose name AND path match.
 */
export function clearSessionCookie(): SessionCookie {
  return {
    name: SessionsService.cookieName(),
    value: '',
    options: cookieOptions(0),
  };
}

/**
 * `dashboard-router.ts`'s logout half: delete the row, so the cookie value
 * cannot be replayed even if it is copied out of the browser. The Hono handler
 * takes the session id from the cookie without checking its signature; here the
 * caller passes the id it already resolved, so only a signature this process
 * issued can reach the delete.
 */
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
