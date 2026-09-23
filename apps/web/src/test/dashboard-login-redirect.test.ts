import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { NextRequest } from 'next/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { POST as loginPost } from '../app/dashboard/login/verify/route';
import { POST as logoutPost } from '../app/dashboard/logout/route';
import { backupDownloadDenial } from '../app/dashboard/maintenance/data';
import { GET as consentGet } from '../app/dashboard/oauth/consent/route';
import { getServices } from '../lib/services';
import { middleware } from '../middleware';

// The three modules the routes reach through the `@/` alias, which this vitest
// project does not define (see `mcp-http.test.ts`). Proxied to their real
// relative files, so the arms below run the production handlers.
vi.mock('@/lib/auth', async () => await import('../lib/auth'));
vi.mock('@/lib/http-redirect', async () => await import('../lib/http-redirect'));
vi.mock('@/lib/services', async () => await import('../lib/services'));
vi.mock('@/lib/session', async () => await import('../lib/session'));

/**
 * Same-origin redirects must stay relative.
 *
 * Regression this file locks down: the handlers used to build their `Location`
 * from `new URL(path, request.url)`. Inside the Next standalone server the
 * Dockerfile bakes `HOSTNAME=0.0.0.0`, so `request.url` reflected the internal
 * `http://0.0.0.0:8787`, and a real browser was redirected to a connection-refused
 * address after login. The request URL below carries that same internal host, so
 * a handler that leaks it into `Location` fails here.
 *
 * The `0.0.0.0` in the request URL is the point, not an accident: it is the only
 * input that distinguishes an origin-relative `Location` from the absolute URL
 * the browser cannot reach.
 */

const INTERNAL_ORIGIN = 'http://0.0.0.0:8787';
const LOGIN_PATH = '/dashboard/login';
const VERIFY_PATH = '/dashboard/login/verify';

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { close: () => void; raw?: { close: () => void } };
  __rembricDashboardSessions?: unknown;
};

const globalForApp = globalThis as MutableGlobal;

function resetAppGlobals(): void {
  try {
    globalForApp.__rembricDb?.close();
  } catch {
    // ignore double-close of a fixture the process already closed
  }
  delete globalForApp.__rembricServices;
  delete globalForApp.__rembricDb;
  delete globalForApp.__rembricDashboardSessions;
}

function formPost(path: string, fields: Record<string, string>): NextRequest {
  return new NextRequest(`${INTERNAL_ORIGIN}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(fields).toString(),
  });
}

/**
 * The assertion the whole file rests on. Returns the value so a caller can pin
 * the exact path without repeating the three host checks.
 */
function expectRelativeLocation(response: Response): string {
  const location = response.headers.get('location');
  expect(location, 'the response must carry a Location').not.toBeNull();
  const value = location ?? '';
  expect(value.startsWith('/'), `Location must be origin-relative, got ${value}`).toBe(true);
  expect(value.startsWith('http')).toBe(false);
  expect(value).not.toContain('0.0.0.0');
  return value;
}

describe('dashboard redirects stay on the origin the browser used', () => {
  let dataDir: string;
  let adminToken: string;

  beforeAll(() => {
    resetAppGlobals();
    dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-login-redirect-'));
    process.env['REMBRIC_DATA_DIR'] = dataDir;
    process.env['REMBRIC_SESSION_SECRET'] = 'web-login-redirect-session-secret-long-enough';
    const services = getServices();
    adminToken = services.tokens.create({ name: 'redirect-admin', scope: '*' }).plaintext;
  });

  afterAll(() => {
    resetAppGlobals();
    rmSync(dataDir, { recursive: true, force: true });
    delete process.env['REMBRIC_DATA_DIR'];
    delete process.env['REMBRIC_SESSION_SECRET'];
  });

  it('answers a successful login with a relative dashboard Location and the session cookie', async () => {
    const response = await loginPost(formPost(VERIFY_PATH, { token: adminToken }));

    expect(response.status).toBe(302);
    expect(expectRelativeLocation(response)).toBe('/dashboard');
    // The relative Location must not cost the cookie: the redirect and the
    // `Set-Cookie` are set on the same response object.
    expect(response.headers.get('set-cookie') ?? '').toContain('rembric_session=');
  });

  it('keeps an allow-listed `next` destination relative, with its query intact', async () => {
    const next = '/dashboard/oauth/consent?client=abc';
    const response = await loginPost(formPost(VERIFY_PATH, { token: adminToken, next }));

    expect(response.status).toBe(302);
    expect(expectRelativeLocation(response)).toBe(next);
  });

  it('answers a refused login with a relative login Location carrying the reason', async () => {
    const response = await loginPost(
      formPost(VERIFY_PATH, { token: 'definitely-not-a-real-token-value' }),
    );

    expect(response.status).toBe(302);
    const location = expectRelativeLocation(response);
    expect(location.startsWith(`${LOGIN_PATH}?`)).toBe(true);
    expect(new URLSearchParams(location.split('?')[1] ?? '').get('error')).toBe('invalid');
  });

  it('sends logout to the relative login page', () => {
    const response = logoutPost(formPost('/dashboard/logout', {}));

    expect(response.status).toBe(302);
    expect(expectRelativeLocation(response)).toBe(LOGIN_PATH);
  });

  it('sends an anonymous dashboard request to the relative login page', () => {
    const response = middleware(new NextRequest(`${INTERNAL_ORIGIN}/dashboard`));

    expect(response.status).toBe(302);
    expect(expectRelativeLocation(response)).toBe(LOGIN_PATH);
  });

  it('hands the consent hand-off to the relative consent path, query intact', () => {
    const search = '?client=abc&state=xyz';
    const response = consentGet(
      new NextRequest(`${INTERNAL_ORIGIN}/dashboard/oauth/consent${search}`),
    );

    expect(response.status).toBe(302);
    expect(expectRelativeLocation(response)).toBe(`/dashboard/oauth-consent${search}`);
  });

  it('sends an anonymous backup download to the relative login page', () => {
    const denied = backupDownloadDenial(
      new NextRequest(
        `${INTERNAL_ORIGIN}/dashboard/maintenance/backup/download/on-demand-1.sqlite`,
      ),
    );

    expect(denied, 'an anonymous download must be denied').not.toBeNull();
    const response = denied as Response;
    expect(response.status).toBe(302);
    expect(expectRelativeLocation(response)).toBe(LOGIN_PATH);
  });
});
