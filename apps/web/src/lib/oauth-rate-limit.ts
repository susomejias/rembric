import { isIP, isIPv6 } from 'node:net';

import type { OAuthReply, ReplyHeaders } from './oauth-http';

const CLIENT_IDENTITY_UNKNOWN = '0.0.0.0';
const IPV6_SUBNET_HEXTETS = 3;

export interface RateLimitPolicy {
  windowMs: number;
  limit: number;
  message: string;
}

export interface RateLimiter {
  consume(identity: string, headers: ReplyHeaders): OAuthReply | null;
}

interface Window {
  hits: number;
  resetAt: number;
}

export function rateLimitIdentity(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim() ?? '';
    if (isIP(first) !== 0) return first;
  }
  return CLIENT_IDENTITY_UNKNOWN;
}

export function rateLimitKey(ip: string): string {
  if (!isIPv6(ip)) return ip;
  const address = ip.split('%')[0] ?? ip;
  if (address.includes('.')) return address.slice(address.lastIndexOf(':') + 1);
  const hextets = expandIPv6(address);
  const prefix = hextets.slice(0, IPV6_SUBNET_HEXTETS).map((h) => h.toString(16));
  const fourth = ((hextets[IPV6_SUBNET_HEXTETS] ?? 0) & 0xff00).toString(16);
  return `${[...prefix, fourth].join(':')}::/56`;
}

function expandIPv6(address: string): number[] {
  const [head = '', tail] = address.split('::');
  const left = head.length > 0 ? head.split(':') : [];
  const right = tail !== undefined && tail.length > 0 ? tail.split(':') : [];
  const zeros = new Array<string>(8 - left.length - right.length).fill('0');
  return [...left, ...(tail === undefined ? [] : zeros), ...right].map((h) =>
    Number.parseInt(h, 16),
  );
}

export function createRateLimiter(policy: RateLimitPolicy): RateLimiter {
  let current = new Map<string, Window>();
  let previous = new Map<string, Window>();
  const sweep = setInterval(() => {
    previous = current;
    current = new Map();
  }, policy.windowMs);
  sweep.unref();

  const windowFor = (key: string, now: number): Window => {
    let entry = current.get(key);
    if (entry === undefined) {
      entry = previous.get(key) ?? { hits: 0, resetAt: now + policy.windowMs };
      previous.delete(key);
      current.set(key, entry);
    }
    if (entry.resetAt <= now) {
      entry.hits = 0;
      entry.resetAt = now + policy.windowMs;
    }
    return entry;
  };

  const windowSeconds = Math.ceil(policy.windowMs / 1000);
  const refusal = JSON.stringify({ error: 'too_many_requests', error_description: policy.message });

  return {
    consume(identity, headers) {
      const now = Date.now();
      const entry = windowFor(rateLimitKey(identity), now);
      entry.hits += 1;
      const resetSeconds = String(Math.max(0, Math.ceil((entry.resetAt - Date.now()) / 1000)));
      headers.set('ratelimit-policy', `${policy.limit};w=${windowSeconds}`);
      headers.set('ratelimit-limit', String(policy.limit));
      headers.set('ratelimit-remaining', String(Math.max(policy.limit - entry.hits, 0)));
      headers.set('ratelimit-reset', resetSeconds);
      if (entry.hits <= policy.limit) return null;
      headers.set('retry-after', resetSeconds);
      return { status: 429, headers, body: refusal };
    },
  };
}
