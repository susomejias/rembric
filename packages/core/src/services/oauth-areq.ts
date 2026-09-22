import { createHmac, timingSafeEqual } from 'node:crypto';

export interface AuthRequest {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  scope: string;
  state?: string;
  /** Consented project id (from the RFC 8707 resource path); null/absent = global grant. */
  projectId?: string | null;
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
