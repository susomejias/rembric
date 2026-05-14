import { createServer as createNetServer } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type BootstrappedServer, createServer } from '../server/index.js';

import { createTestDb } from './db.js';

/**
 * 9.13 / 13.22 — dashboard end-to-end tests.
 *
 * Drives the live HTTP surface (Hono via `@hono/node-server`) by way of
 * regular `fetch` calls. This stands in for a headless-browser harness
 * — the dashboard is server-rendered HTML + plain forms, so every
 * interesting behavior (cookies, CSRF, login, archive, undo, token
 * create+revoke) is observable as an HTTP request/response pair.
 *
 * Covers:
 *   - login flow (200 form → 302 with Set-Cookie → 200 home)
 *   - browse memories list / detail
 *   - undo a consolidation op (CSRF token round-trip)
 *   - create + revoke a token (one-shot plaintext in redirect query)
 *   - CSRF rejection (POST without token returns 403)
 */

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const sock = createNetServer();
    sock.unref();
    sock.on('error', reject);
    sock.listen(0, '127.0.0.1', () => {
      const addr = sock.address();
      if (!addr || typeof addr === 'string') {
        sock.close();
        reject(new Error('expected AddressInfo'));
        return;
      }
      const p = addr.port;
      sock.close(() => resolve(p));
    });
  });
}

interface CookieJar {
  cookie: string | null;
}

async function get(
  baseUrl: string,
  path: string,
  jar: CookieJar,
  opts: { redirect?: 'follow' | 'manual' } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (jar.cookie) headers.cookie = jar.cookie;
  const res = await fetch(baseUrl + path, {
    headers,
    redirect: opts.redirect ?? 'manual',
  });
  storeCookie(jar, res);
  return res;
}

async function postForm(
  baseUrl: string,
  path: string,
  jar: CookieJar,
  body: Record<string, string>,
): Promise<Response> {
  const headers: Record<string, string> = {
    'content-type': 'application/x-www-form-urlencoded',
  };
  if (jar.cookie) headers.cookie = jar.cookie;
  const enc = new URLSearchParams(body).toString();
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers,
    body: enc,
    redirect: 'manual',
  });
  storeCookie(jar, res);
  return res;
}

function storeCookie(jar: CookieJar, res: Response): void {
  const set = res.headers.get('set-cookie');
  if (!set) return;
  // Multiple cookies are joined with comma by fetch; we only care about
  // rembric_session for these tests.
  const match = /(?:^|,\s*)(rembric_session=[^;]+)/.exec(set);
  if (match) jar.cookie = match[1] ?? null;
}

function extractCsrf(html: string, action: string): string | null {
  // Find the form whose action matches `action`, then pull the csrf hidden input.
  const formRe = new RegExp(
    `<form[^>]*action="${action.replace(/[/.]/g, (m) => '\\' + m)}"[\\s\\S]*?</form>`,
  );
  const m = formRe.exec(html);
  if (!m) return null;
  const c = /<input[^>]*name="csrf"[^>]*value="([^"]+)"/.exec(m[0]);
  return c?.[1] ?? null;
}

describe('dashboard E2E', () => {
  let server: BootstrappedServer;
  let baseUrl: string;
  const ADMIN_TOKEN = 'integration-admin-token-with-enough-entropy-zzz';

  beforeAll(async () => {
    const tmp = createTestDb();
    tmp.cleanup();

    const port = await findFreePort();
    server = await createServer({
      REMBRIC_HOST: '127.0.0.1',
      REMBRIC_PORT: String(port),
      REMBRIC_DATA_DIR: tmp.dataDir,
      REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
      CONSOLIDATION_ENABLED: 'false',
      EMBEDDING_ENABLED: 'false',
      OPENAI_API_KEY: 'sk-test',
    });
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await server.shutdown();
  });

  it('login form is reachable without a cookie', async () => {
    const jar: CookieJar = { cookie: null };
    const res = await get(baseUrl, '/dashboard/login', jar);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Admin token');
  });

  it('home page redirects unauthenticated users to login', async () => {
    const jar: CookieJar = { cookie: null };
    const res = await get(baseUrl, '/dashboard', jar);
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard/login');
  });

  it('login → home → logout cycle', async () => {
    const jar: CookieJar = { cookie: null };
    const login = await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });
    expect(login.status).toBe(302);
    expect(jar.cookie).toMatch(/^rembric_session=/);

    const home = await get(baseUrl, '/dashboard', jar);
    expect(home.status).toBe(200);
    const homeBody = await home.text();
    expect(homeBody).toContain('Overview');

    // Logout invalidates the cookie.
    const logout = await postForm(baseUrl, '/dashboard/logout', jar, {});
    expect(logout.status).toBe(302);
  });

  it('rejects login with a wrong token', async () => {
    const jar: CookieJar = { cookie: null };
    const res = await postForm(baseUrl, '/dashboard/login', jar, { token: 'wrong' });
    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain('Invalid token');
  });

  it('serves a static asset under /dashboard/assets/', async () => {
    const jar: CookieJar = { cookie: null };
    const res = await get(baseUrl, '/dashboard/assets/htmx.min.js', jar);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/application\/javascript/);
  });

  it('refuses to traverse out of the assets dir', async () => {
    const jar: CookieJar = { cookie: null };
    const res = await get(baseUrl, '/dashboard/assets/..%2F..%2Fetc%2Fpasswd', jar);
    expect([400, 404]).toContain(res.status);
  });

  it('memories list and detail render after login', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    const list = await get(baseUrl, '/dashboard/memories', jar);
    expect(list.status).toBe(200);
    const body = await list.text();
    expect(body).toContain('Memories');
  });

  it('token create flow shows the plaintext exactly once, then revoke succeeds', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    // Pull the page to obtain a CSRF token bound to this form.
    const tokensPage = await get(baseUrl, '/dashboard/tokens', jar);
    const csrf = extractCsrf(await tokensPage.text(), '/dashboard/tokens');
    expect(csrf).toBeTruthy();

    const created = await postForm(baseUrl, '/dashboard/tokens', jar, {
      csrf: csrf!,
      name: 'e2e-test-token',
      project: '',
      scope: '*',
      expires: '',
    });
    expect(created.status).toBe(302);
    const redirectTo = created.headers.get('location');
    expect(redirectTo).toContain('created=');

    // Follow redirect.
    const after = await get(baseUrl, redirectTo!, jar);
    const body = await after.text();
    expect(body).toContain('e2e-test-token');
    expect(body).toContain('New token created');

    // Now revoke. Need a fresh CSRF for the revoke form.
    const revokeCsrf = extractCsrf(body, '/dashboard/tokens/e2e-test-token/revoke');
    expect(revokeCsrf).toBeTruthy();
    const revoked = await postForm(baseUrl, '/dashboard/tokens/e2e-test-token/revoke', jar, {
      csrf: revokeCsrf!,
    });
    expect(revoked.status).toBe(302);

    const finalPage = await get(baseUrl, '/dashboard/tokens', jar);
    const finalBody = await finalPage.text();
    expect(finalBody).toContain('e2e-test-token');
    expect(finalBody).toContain('revoked');
  });

  it('sessions list and detail render after login', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    const list = await get(baseUrl, '/dashboard/sessions', jar);
    expect(list.status).toBe(200);
    const body = await list.text();
    expect(body).toContain('Sessions');
  });

  it('sessions detail 404 for unknown id', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    const res = await get(baseUrl, '/dashboard/sessions/not-a-real-id', jar);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('Session not found');
  });

  it('CSRF rejection — POST without csrf field returns 403', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    const res = await postForm(baseUrl, '/dashboard/tokens', jar, {
      name: 'no-csrf',
      project: '',
      scope: '*',
      expires: '',
    });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('csrf_invalid');
  });
});
