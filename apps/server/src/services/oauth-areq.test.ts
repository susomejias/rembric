import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { signAuthRequest, verifyAuthRequest, type AuthRequest } from './oauth-areq.js';

const KEY = randomBytes(32);
const NOW = 1_000_000_000_000;

function req(overrides: Partial<AuthRequest> = {}): AuthRequest {
  return {
    clientId: 'oauthc_x',
    redirectUri: 'https://chatgpt.example/cb',
    codeChallenge: 'challenge',
    scope: 'mcp',
    state: 'st-123',
    exp: Math.floor(NOW / 1000) + 600,
    ...overrides,
  };
}

describe('oauth-areq', () => {
  it('round-trips a signed authorization request', () => {
    const blob = signAuthRequest(req(), KEY);
    const out = verifyAuthRequest(blob, KEY, NOW);
    expect(out).not.toBeNull();
    expect(out?.clientId).toBe('oauthc_x');
    expect(out?.state).toBe('st-123');
  });

  it('rejects a tampered payload', () => {
    const blob = signAuthRequest(req(), KEY);
    const [body, sig] = blob.split('.');
    const forged = `${body}x.${sig}`;
    expect(verifyAuthRequest(forged, KEY, NOW)).toBeNull();
  });

  it('rejects a wrong signing key', () => {
    const blob = signAuthRequest(req(), KEY);
    expect(verifyAuthRequest(blob, randomBytes(32), NOW)).toBeNull();
  });

  it('rejects an expired request', () => {
    const blob = signAuthRequest(req({ exp: Math.floor(NOW / 1000) - 1 }), KEY);
    expect(verifyAuthRequest(blob, KEY, NOW)).toBeNull();
  });

  it('rejects a malformed blob', () => {
    expect(verifyAuthRequest('not-a-blob', KEY, NOW)).toBeNull();
    expect(verifyAuthRequest('', KEY, NOW)).toBeNull();
  });
});
