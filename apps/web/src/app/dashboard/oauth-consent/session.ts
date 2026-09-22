import { deriveOAuthAreqKey } from '@rembric/core';

/**
 * The key derivation is `@rembric/core`'s (`deriveOAuthAreqKey`), so every
 * caller drifts only in the secret it is handed, never in how it derives.
 */

export const CONSENT_FORM = 'oauth.consent';

/** `null` when neither variable is set — a page may not fail the process the way boot may. */
function sessionSecretBase(): string | null {
  const configured = process.env['REMBRIC_SESSION_SECRET'] ?? process.env['REMBRIC_ADMIN_TOKEN'];
  return configured !== undefined && configured.length > 0 ? configured : null;
}

export function areqKey(): Buffer | null {
  const base = sessionSecretBase();
  return base === null ? null : deriveOAuthAreqKey(base);
}
