import { deriveOAuthAreqKey, deriveSessionKey, SessionsService } from '@rembric/core';
import { cookies } from 'next/headers';

import { getServices } from '@/lib/services';

/**
 * The two keys and the CSRF token the consent screen needs to keep working as a
 * protocol form — all three derived here rather than in `apps/server`, because
 * the decision control POSTs to the authorization endpoint, whose CSRF check
 * reads the dashboard-session cookie.
 *
 * A ported view that rendered approve/deny without a token would be refused by
 * that check (`403 csrf_invalid`), so the token is minted from the same session
 * row and the same key the endpoint verifies with. Both derivations are
 * `@rembric/core`'s (`deriveSessionKey` / `deriveOAuthAreqKey`), so the two
 * processes cannot drift in *how* they derive — only in the secret they are
 * handed, which is the same resolution `bootstrap.ts` uses.
 *
 * Their permanent home is `lib/services.ts` beside the other shared singletons;
 * that file is outside this slice's edit surface.
 */

/** The form name the endpoint binds its CSRF token to. */
export const CONSENT_FORM = 'oauth.consent';

/**
 * `bootstrap.ts`: `REMBRIC_SESSION_SECRET`, else the admin token. `null` when
 * neither is set — the caller renders that as a state instead of throwing,
 * because a page may not fail the process the way boot may.
 */
function sessionSecretBase(): string | null {
  const configured = process.env['REMBRIC_SESSION_SECRET'] ?? process.env['REMBRIC_ADMIN_TOKEN'];
  return configured !== undefined && configured.length > 0 ? configured : null;
}

/** HMAC key for verifying the signed authorization request (`areq`). */
export function areqKey(): Buffer | null {
  const base = sessionSecretBase();
  return base === null ? null : deriveOAuthAreqKey(base);
}

/**
 * The CSRF token for this request's dashboard session, or `null` when there is
 * no secret to derive the key from and no live session to bind the token to.
 * A `null` token is not a permissive state: the authorization endpoint refuses
 * the POST, which is exactly the boundary that must not be weakened here.
 */
export async function consentCsrfToken(): Promise<string | null> {
  const base = sessionSecretBase();
  if (base === null) return null;

  const { repos } = getServices();
  const sessions = new SessionsService(
    { dashboardSessions: repos.dashboardSessions },
    deriveSessionKey(base),
  );
  const cookie = (await cookies()).get(SessionsService.cookieName())?.value;
  const resolved = sessions.resolve(cookie);
  if (!resolved) return null;

  return sessions.csrfToken(resolved.session, CONSENT_FORM);
}
