import { deriveOAuthAreqKey } from '@rembric/core';

/**
 * The two protocol keys the consent flow derives: `areqKey`, the HMAC key that
 * verifies the signed authorization request (`areq`), and `CONSENT_FORM`, the
 * form name the authorization endpoint binds its CSRF token to.
 *
 * The key derivation is `@rembric/core`'s (`deriveOAuthAreqKey`), so this app
 * and `apps/server` cannot drift in *how* they derive — only in the secret they
 * are handed, which is the same resolution `bootstrap.ts` uses.
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
