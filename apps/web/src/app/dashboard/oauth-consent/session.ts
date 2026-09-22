import { deriveOAuthAreqKey } from '@rembric/core';

export const CONSENT_FORM = 'oauth.consent';

function sessionSecretBase(): string | null {
  const configured = process.env['REMBRIC_SESSION_SECRET'] ?? process.env['REMBRIC_ADMIN_TOKEN'];
  return configured !== undefined && configured.length > 0 ? configured : null;
}

export function areqKey(): Buffer | null {
  const base = sessionSecretBase();
  return base === null ? null : deriveOAuthAreqKey(base);
}
