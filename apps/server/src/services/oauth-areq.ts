import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Stateless, signed hand-off of an already-SDK-validated authorization
 * request from `provider.authorize` (which only has the response object) to
 * the consent screen (a dashboard route with full request/session access).
 *
 * The payload is HMAC-signed with a key derived from the session secret, so
 * the consent screen can trust that the client_id / redirect_uri / scope /
 * code_challenge were validated by the SDK authorize handler and not forged.
 * Short-lived (the `exp` field) to bound replay.
 */

export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state?: string;
  /** Expiry, seconds since epoch. */
  exp: number;
}

export function signAuthRequest(req: AuthRequest, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(req), 'utf8').toString('base64url');
  const sig = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyAuthRequest(blob: string, key: Buffer, nowMs: number): AuthRequest | null {
  const dot = blob.indexOf('.');
  if (dot <= 0) return null;
  const body = blob.slice(0, dot);
  const sig = blob.slice(dot + 1);
  const expected = createHmac('sha256', key).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let parsed: AuthRequest;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as AuthRequest;
  } catch {
    return null;
  }
  if (typeof parsed.exp !== 'number' || parsed.exp * 1000 <= nowMs) return null;
  return parsed;
}
