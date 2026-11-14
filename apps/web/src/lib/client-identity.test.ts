import { describe, expect, it } from 'vitest';

import { clientIdentity, UNKNOWN_CLIENT } from './client-identity';

function withHop(hop?: string): Request {
  const headers: Record<string, string> = {};
  if (hop !== undefined) headers['x-forwarded-for'] = hop;
  return new Request('http://127.0.0.1:8787/healthz', { headers });
}

describe('clientIdentity', () => {
  it('reads the first forwarded value when it is an IP address', () => {
    expect(clientIdentity(withHop('203.0.113.7'))).toBe('203.0.113.7');
    expect(clientIdentity(withHop(' 203.0.113.7 , 10.0.0.1'))).toBe('203.0.113.7');
    expect(clientIdentity(withHop('2001:db8::1'))).toBe('2001:db8::1');
  });

  it('answers the one fallback for a missing, empty or non-IP value', () => {
    expect(UNKNOWN_CLIENT).toBe('0.0.0.0');
    expect(clientIdentity(withHop())).toBe(UNKNOWN_CLIENT);
    expect(clientIdentity(withHop(''))).toBe(UNKNOWN_CLIENT);
    expect(clientIdentity(withHop('not-an-address, 203.0.113.7'))).toBe(UNKNOWN_CLIENT);
  });
});
