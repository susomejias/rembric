import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { DbHandle } from '../db/index.js';
import { createRepositories } from '../db/repositories/index.js';
import { type BootstrappedServer, createServer } from '../server/index.js';
import { ProjectsService } from '../services/projects.js';
import { REMBRIC_VERSION } from '../version.js';

import { createTestDb } from './db.js';
import { defaultProjectScope } from './default-project.js';
import { FakeEmbedder } from './embedder.js';

import { findFreePort } from './index.js';

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

interface MintedToken {
  status: number;
  plaintext: string | null;
  /** The tokens page as rendered after the redirect, or the error page body. */
  body: string;
}

async function mintTokenViaForm(
  baseUrl: string,
  jar: CookieJar,
  fields: Record<string, string>,
): Promise<MintedToken> {
  const page = await get(baseUrl, '/dashboard/tokens', jar);
  const csrf = extractCsrf(await page.text(), '/dashboard/tokens');
  const res = await postForm(baseUrl, '/dashboard/tokens', jar, {
    expires: '',
    ...fields,
    csrf: csrf ?? '',
  });
  if (res.status !== 302) {
    return { status: res.status, plaintext: null, body: await res.text() };
  }
  const location = res.headers.get('location') ?? '';
  const plaintext = new URL(location, baseUrl).searchParams.get('created');
  const after = await get(baseUrl, location, jar);
  return { status: res.status, plaintext, body: await after.text() };
}

async function apiPost(
  baseUrl: string,
  path: string,
  bearer: string,
  body: unknown,
): Promise<{ status: number; body: { ok: boolean; code?: string; message?: string } }> {
  const res = await fetch(baseUrl + path, {
    method: 'POST',
    headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    body: (await res.json()) as { ok: boolean; code?: string; message?: string },
  };
}

function tokenRow(html: string, name: string): string | null {
  const re = new RegExp(`<tr>\\s*<td>${name}</td>[\\s\\S]*?</tr>`);
  return re.exec(html)?.[0] ?? null;
}

/** Cell contents of a rendered `<tr>`, in column order, markup included. */
function cellsOf(row: string): string[] {
  return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => (m[1] ?? '').trim());
}

function textOf(cell: string): string {
  return cell.replace(/<[^>]*>/g, '').trim();
}

/** Labels of the login page's `.clients` footer, in render order. */
function loginClientLabels(html: string): string[] {
  const container = /<div class="clients\b[^"]*"[^>]*>([\s\S]*?)<\/div>/.exec(html)?.[1];
  if (container === undefined) return [];
  return [...container.matchAll(/<span class="bn"><\/span>([^<]*)<\/span>/g)].map((m) =>
    (m[1] ?? '').trim(),
  );
}

/** Second connection onto the running server's data dir, for fixtures and assertions. */
async function withDataDb<T>(dataDir: string, fn: (handle: DbHandle) => T): Promise<T> {
  const { createDb } = await import('../db/index.js');
  const handle = createDb({ dataDir });
  try {
    return fn(handle);
  } finally {
    handle.close();
  }
}

describe('dashboard E2E', () => {
  let server: BootstrappedServer;
  let baseUrl: string;
  const ADMIN_TOKEN = 'integration-admin-token-with-enough-entropy-zzz';

  beforeAll(async () => {
    const tmp = createTestDb();
    tmp.cleanup();

    const port = await findFreePort();
    server = await createServer(
      {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: String(port),
        REMBRIC_DATA_DIR: tmp.dataDir,
        REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
        // Keep the suite hermetic — never call the real GitHub API.
        REMBRIC_UPDATE_CHECK: 'off',
      },
      { embedder: new FakeEmbedder() },
    );
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
    expect(body).toContain(`v${REMBRIC_VERSION}`);
  });

  it('login page names every client, in a stable order', async () => {
    const jar: CookieJar = { cookie: null };
    const res = await get(baseUrl, '/dashboard/login', jar);
    const labels = loginClientLabels(await res.text());
    // Non-vacuity control: an empty parse would satisfy any ordering assertion.
    expect(labels.length).toBeGreaterThan(0);
    expect(labels).toEqual(['CLAUDE CODE', 'OPENCODE', 'CODEX CLI', 'PI', 'HERMES', 'MCP CLIENTS']);
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
    expect(homeBody).toContain(`v${REMBRIC_VERSION}`);

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
      access: 'write',
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

  it('sessions list sorts active rows above ended ones regardless of age', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    const { createDb } = await import('../db/index.js');
    const { ProjectsService } = await import('../services/projects.js');
    const { AgentSessionsService } = await import('../services/agent-sessions.js');
    const { tokens: tokensSchema } = await import('../db/schema/tokens.js');
    const { eq } = await import('drizzle-orm');
    const dataDir = server.config.dataDir;
    const handle = createDb({ dataDir });
    const admin = handle.db.select().from(tokensSchema).where(eq(tokensSchema.name, 'admin')).get();
    const proj = new ProjectsService(createRepositories(handle.db)).create({
      slug: 'e2e-order-proj',
    });
    const agentSessions = new AgentSessionsService(createRepositories(handle.db), handle.db);
    // Older active session first, then a newer session that ends — plain
    // started_at DESC would render the ended one on top.
    const activeOld = agentSessions.start({ tokenId: admin!.id, projectId: proj.id, agent: 'e2e' });
    await new Promise((r) => setTimeout(r, 10));
    const endedNew = agentSessions.start({ tokenId: admin!.id, projectId: proj.id, agent: 'e2e' });
    agentSessions.end(endedNew.id, { tokenId: admin!.id });
    handle.close();

    const list = await get(baseUrl, '/dashboard/sessions', jar);
    expect(list.status).toBe(200);
    const body = await list.text();
    expect(body).not.toContain('<th>id</th>');
    const activeIdx = body.indexOf(`data-href="/dashboard/sessions/${activeOld.id}"`);
    const endedIdx = body.indexOf(`data-href="/dashboard/sessions/${endedNew.id}"`);
    expect(activeIdx).toBeGreaterThan(-1);
    expect(endedIdx).toBeGreaterThan(-1);
    expect(activeIdx).toBeLessThan(endedIdx);
  });

  it('sessions detail 404 for unknown id', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    const res = await get(baseUrl, '/dashboard/sessions/not-a-real-id', jar);
    expect(res.status).toBe(404);
    const body = await res.text();
    expect(body).toContain('Session not found');
  });

  it('sessions delete soft-deletes via the row form and undelete restores from detail view', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    // Seed a session row using the dashboard's own data dir.
    const { createDb } = await import('../db/index.js');
    const { ProjectsService } = await import('../services/projects.js');
    const { TokensService } = await import('../services/tokens.js');
    const { AgentSessionsService } = await import('../services/agent-sessions.js');
    const { tokens: tokensSchema } = await import('../db/schema/tokens.js');
    const { eq } = await import('drizzle-orm');
    const dataDir = server.config.dataDir;
    const handle = createDb({ dataDir });
    const tokensSvc = new TokensService(createRepositories(handle.db), handle.db);
    const admin = handle.db.select().from(tokensSchema).where(eq(tokensSchema.name, 'admin')).get();
    void tokensSvc;
    const proj = new ProjectsService(createRepositories(handle.db)).create({
      slug: 'e2e-del-proj',
    });
    const sess = new AgentSessionsService(createRepositories(handle.db), handle.db).start({
      tokenId: admin!.id,
      projectId: proj.id,
      agent: 'e2e',
    });
    handle.close();

    // Pull the list page to extract the CSRF token bound to this row's
    // Delete form.
    const list = await get(baseUrl, '/dashboard/sessions', jar);
    expect(list.status).toBe(200);
    const listBody = await list.text();
    const csrf = extractCsrf(listBody, `/dashboard/sessions/${sess.id}/delete`);
    expect(csrf).toBeTruthy();

    const deleted = await postForm(baseUrl, `/dashboard/sessions/${sess.id}/delete`, jar, {
      csrf: csrf!,
    });
    expect(deleted.status).toBe(302);
    expect(deleted.headers.get('location')).toContain(`deleted=${sess.id}`);

    // Default list hides the row; ?include_deleted=1 surfaces it.
    const after = await get(baseUrl, '/dashboard/sessions', jar);
    expect(await after.text()).not.toContain(sess.id);
    const withDeleted = await get(baseUrl, '/dashboard/sessions?include_deleted=1', jar);
    expect(await withDeleted.text()).toContain(sess.id);

    // Detail view shows the deleted flash and an Undelete button.
    const detail = await get(baseUrl, `/dashboard/sessions/${sess.id}`, jar);
    const detailBody = await detail.text();
    expect(detailBody).toContain('soft-deleted');
    const undeleteCsrf = extractCsrf(detailBody, `/dashboard/sessions/${sess.id}/undelete`);
    expect(undeleteCsrf).toBeTruthy();
    const undeleted = await postForm(baseUrl, `/dashboard/sessions/${sess.id}/undelete`, jar, {
      csrf: undeleteCsrf!,
    });
    expect(undeleted.status).toBe(302);
    expect(undeleted.headers.get('location')).toContain(`restored=${sess.id}`);

    const final = await get(baseUrl, '/dashboard/sessions', jar);
    expect(await final.text()).toContain(sess.id);
  });

  it('session delete without csrf returns 403', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });
    const res = await postForm(baseUrl, '/dashboard/sessions/anything/delete', jar, {});
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('csrf_invalid');
  });

  it('sessions abandon flips an active row to abandoned and surfaces the flash banner', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    const { createDb } = await import('../db/index.js');
    const { ProjectsService } = await import('../services/projects.js');
    const { AgentSessionsService } = await import('../services/agent-sessions.js');
    const { tokens: tokensSchema } = await import('../db/schema/tokens.js');
    const { eq } = await import('drizzle-orm');
    const dataDir = server.config.dataDir;
    const handle = createDb({ dataDir });
    const admin = handle.db.select().from(tokensSchema).where(eq(tokensSchema.name, 'admin')).get();
    const proj = new ProjectsService(createRepositories(handle.db)).create({
      slug: 'e2e-abandon-proj',
    });
    const agentSessions = new AgentSessionsService(createRepositories(handle.db), handle.db);
    const sess = agentSessions.start({
      tokenId: admin!.id,
      projectId: proj.id,
      agent: 'e2e',
    });
    handle.close();

    const list = await get(baseUrl, '/dashboard/sessions', jar);
    expect(list.status).toBe(200);
    const listBody = await list.text();
    const csrf = extractCsrf(listBody, `/dashboard/sessions/${sess.id}/abandon`);
    expect(csrf).toBeTruthy();

    const abandoned = await postForm(baseUrl, `/dashboard/sessions/${sess.id}/abandon`, jar, {
      csrf: csrf!,
    });
    expect(abandoned.status).toBe(302);
    expect(abandoned.headers.get('location')).toContain(`abandoned=${sess.id}`);

    const after = await get(baseUrl, `/dashboard/sessions?abandoned=${sess.id}`, jar);
    const afterBody = await after.text();
    expect(afterBody).toContain('marked as abandoned');

    const handle2 = createDb({ dataDir });
    const row = new AgentSessionsService(createRepositories(handle2.db), handle2.db).getById(
      sess.id,
    );
    handle2.close();
    expect(row?.status).toBe('abandoned');
    expect(row?.endedAt).toBeInstanceOf(Date);
  });

  it('a post with no parseable form body returns 403, not 500', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });
    const res = await fetch(`${baseUrl}/dashboard/sessions/anything/delete`, {
      method: 'POST',
      headers: { cookie: jar.cookie ?? '', 'content-type': 'application/json' },
      body: '{}',
      redirect: 'manual',
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('csrf_invalid');
  });

  it('sessions abandon without csrf returns 403', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });
    const res = await postForm(baseUrl, '/dashboard/sessions/anything/abandon', jar, {});
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('csrf_invalid');
  });

  it('judgments list view renders after login', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });
    const res = await get(baseUrl, '/dashboard/judgments', jar);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Judgments');
  });

  it('manual sweep button forces a consolidation run via CSRF round-trip', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    const page = await get(baseUrl, '/dashboard/consolidation', jar);
    expect(page.status).toBe(200);
    const pageBody = await page.text();
    const csrf = extractCsrf(pageBody, '/dashboard/consolidation/run');
    expect(csrf).toBeTruthy();
    expect(pageBody).not.toContain('<th>model</th>');

    const res = await postForm(baseUrl, '/dashboard/consolidation/run', jar, { csrf: csrf! });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard/consolidation');

    const after = await get(baseUrl, '/dashboard/consolidation', jar);
    const afterBody = await after.text();
    expect(afterBody).toContain('data-href="/dashboard/consolidation/');

    // Sweep run detail renders the legible summary and no Model card.
    const idMatch = /data-href="(\/dashboard\/consolidation\/[A-Z0-9]+)"/.exec(afterBody);
    expect(idMatch).toBeTruthy();
    const detail = await get(baseUrl, idMatch![1]!, jar);
    const detailBody = await detail.text();
    expect(detailBody).toMatch(/\d+ archived · \d+ orphaned/);
    expect(detailBody).not.toContain('<div class="label">Model</div>');
  });

  it('manual sweep without csrf returns 403 and runs nothing', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    const res = await postForm(baseUrl, '/dashboard/consolidation/run', jar, {});
    expect(res.status).toBe(403);
    expect(await res.text()).toContain('csrf_invalid');
  });

  it('manual sweep unauthenticated redirects to login', async () => {
    const jar: CookieJar = { cookie: null };
    const res = await postForm(baseUrl, '/dashboard/consolidation/run', jar, {});
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/dashboard/login');
  });

  it('home consolidation health shows the trigger model, no cron or model copy', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    const res = await get(baseUrl, '/dashboard', jar);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('ON SESSION START');
    expect(body).toContain('THROTTLED 24H / SCOPE');
    expect(body).toMatch(/RE-EXPOSED &gt; \d+[HD] · ORPHANED &gt;\s*\d+[HD]/);
    expect(body).not.toContain('NEXT RUN');
    expect(body).not.toContain('03:00 UTC');
    expect(body).not.toContain('MODEL ');
    expect(body).not.toContain('AUTO-PROMOTED');
  });

  it('projects page renders a create form and a POST mints the project', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    const page = await get(baseUrl, '/dashboard/projects', jar);
    expect(page.status).toBe(200);
    const pageBody = await page.text();
    expect(pageBody).toContain('Create project');

    const csrf = extractCsrf(pageBody, '/dashboard/projects/create');
    expect(csrf).toBeTruthy();

    const created = await postForm(baseUrl, '/dashboard/projects/create', jar, {
      csrf: csrf!,
      slug: 'e2e-created-project',
      displayName: 'E2E Created',
    });
    expect(created.status).toBe(302);
    expect(created.headers.get('location')).toContain('created=e2e-created-project');

    const after = await get(baseUrl, '/dashboard/projects?created=e2e-created-project', jar);
    const afterBody = await after.text();
    expect(afterBody).toContain('e2e-created-project');
    expect(afterBody).toContain('E2E Created');
  });

  it('consolidation scope cells render the project slug, not the raw ULID', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    // 'e2e-created-project' exists from the previous test; force a sweep so
    // a project-scoped run lands in the listing.
    const page = await get(baseUrl, '/dashboard/consolidation', jar);
    const csrf = extractCsrf(await page.text(), '/dashboard/consolidation/run');
    await postForm(baseUrl, '/dashboard/consolidation/run', jar, { csrf: csrf! });

    const list = await get(baseUrl, '/dashboard/consolidation', jar);
    const listBody = await list.text();
    expect(listBody).toContain('<td>e2e-created-project</td>');
    expect(listBody).not.toMatch(/<td>project:01[A-Z0-9]+<\/td>/);

    // Detail page shows the slug in the Scope stat card too.
    // Row-scoped: `[\s\S]*?` spanned rows, so the href captured was the first
    // row's rather than the one holding the cell.
    const rowRe =
      /<tr data-href="(\/dashboard\/consolidation\/[A-Z0-9]+)">(?:(?!<\/tr>)[\s\S])*?<td>e2e-created-project<\/td>/;
    const row = rowRe.exec(listBody);
    expect(row).toBeTruthy();
    const detail = await get(baseUrl, row![1]!, jar);
    const detailBody = await detail.text();
    expect(detailBody).toContain('e2e-created-project');
    expect(detailBody).not.toMatch(/<div class="value">project:01[A-Z0-9]+<\/div>/);
  });

  it('project create rejects an invalid slug with a flash error in the redirect', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    const page = await get(baseUrl, '/dashboard/projects', jar);
    const csrf = extractCsrf(await page.text(), '/dashboard/projects/create');
    expect(csrf).toBeTruthy();

    const res = await postForm(baseUrl, '/dashboard/projects/create', jar, {
      csrf: csrf!,
      slug: 'INVALID Slug!',
      displayName: '',
    });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/error=/);
  });

  it('CSRF rejection — POST without csrf field returns 403', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    const res = await postForm(baseUrl, '/dashboard/tokens', jar, {
      name: 'no-csrf',
      project: '',
      access: 'write',
      expires: '',
    });
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('csrf_invalid');
  });

  it('sidebar toggle flips the rbr-sb-collapsed cookie via POST /_sidebar/toggle', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });
    const homeBody = await (await get(baseUrl, '/dashboard', jar)).text();
    const csrf = extractCsrf(homeBody, '/dashboard/_sidebar/toggle');
    expect(csrf).toBeTruthy();

    // First toggle: no rbr-sb-collapsed cookie sent → handler treats as
    // expanded → sets rbr-sb-collapsed=1.
    const first = await postForm(baseUrl, '/dashboard/_sidebar/toggle', jar, { csrf: csrf! });
    expect(first.status).toBe(302);
    expect(first.headers.get('set-cookie') ?? '').toContain('rbr-sb-collapsed=1');

    // Second toggle: we send rbr-sb-collapsed=1 alongside the session
    // cookie → handler flips it to 0.
    const jarWithCollapsed: CookieJar = {
      cookie: `${jar.cookie}; rbr-sb-collapsed=1`,
    };
    const second = await postForm(baseUrl, '/dashboard/_sidebar/toggle', jarWithCollapsed, {
      csrf: csrf!,
    });
    expect(second.status).toBe(302);
    expect(second.headers.get('set-cookie') ?? '').toContain('rbr-sb-collapsed=0');
  });

  it('sidebar toggle rejects POST without CSRF token (403)', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });
    const res = await postForm(baseUrl, '/dashboard/_sidebar/toggle', jar, {});
    expect(res.status).toBe(403);
    const body = await res.text();
    expect(body).toContain('csrf_invalid');
  });

  it('home overview surfaces RECENT JUDGMENTS (empty then populated)', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    // Empty state: no judged relations yet.
    const before = await get(baseUrl, '/dashboard', jar);
    expect(before.status).toBe(200);
    const beforeBody = await before.text();
    expect(beforeBody).toContain('RECENT JUDGMENTS');
    expect(beforeBody).toContain('NEWEST FIRST');
    expect(beforeBody).toContain('NO JUDGMENTS YET');
    expect(beforeBody).not.toContain('NO PENDING JUDGMENTS YET');

    // Seed: two memories + a judged 'supersedes' relation between them.
    const { createDb } = await import('../db/index.js');
    const { MemoryService } = await import('../services/memory.js');
    const { RelationsService } = await import('../services/relations.js');
    const dataDir = server.config.dataDir;
    const handle = createDb({ dataDir });
    const memSvc = new MemoryService(createRepositories(handle.db), handle.db);
    const a = memSvc.save(
      { type: 'feedback', title: 'judged-row-source-title', content: 'judged-row-source-content' },
      defaultProjectScope(handle),
    );
    const b = memSvc.save(
      { type: 'feedback', title: 'judged-row-target-title', content: 'judged-row-target-content' },
      defaultProjectScope(handle),
    );
    const rel = new RelationsService(createRepositories(handle.db), handle.db).compare({
      sourceId: a.id,
      targetId: b.id,
      relation: 'supersedes',
      actor: 'e2e-test',
      kind: 'agent',
      confidence: 0.9,
      reason: 'e2e demo reason',
    });
    handle.close();

    // Populated state on home: row renders with the supersedes pill class
    // and the source/target title wrapped in memory-detail links (no bare
    // short ids).
    const after = await get(baseUrl, '/dashboard', jar);
    expect(after.status).toBe(200);
    const afterBody = await after.text();
    expect(afterBody).toContain('RECENT JUDGMENTS');
    expect(afterBody).not.toContain('NO JUDGMENTS YET');
    expect(afterBody).toContain('pill k-supersedes');
    expect(afterBody).toContain('judged-row-source-title');
    expect(afterBody).toContain('judged-row-target-title');
    expect(afterBody).toContain(`href="/dashboard/memories/${a.id}"`);
    expect(afterBody).toContain(`href="/dashboard/memories/${b.id}"`);
    expect(afterBody).toContain('agent');
    // Home tile: the verdict pill itself is NOT wrapped in an anchor — a
    // dedicated VIEW button in the row's .acts slot carries the detail link.
    expect(afterBody).toContain(`href="/dashboard/judgments/${rel.id}"`);
    expect(afterBody).toContain('VIEW');
    expect(afterBody).not.toContain(
      `<a\n                              href="/dashboard/judgments/${rel.id}"`,
    );
    // Stat strip: the PENDING JUDGMENTS card has been removed; the strip
    // is now grid-6 with no pending-judgments labelled card.
    expect(afterBody).toContain('grid-6');
    expect(afterBody).not.toContain('PENDING JUDGMENTS');

    // Same seed appears on /dashboard/judgments: source → target column
    // shows truncated title as memory-detail links, not bare short ids;
    // the verdict cell uses the shared verdictPill helper (k-supersedes);
    // rows are whole-row clickable (data-href) with the real detail anchor
    // on the created cell — no id column.
    const list = await get(baseUrl, '/dashboard/judgments', jar);
    expect(list.status).toBe(200);
    const listBody = await list.text();
    expect(listBody).toContain('judged-row-source-title');
    expect(listBody).toContain('judged-row-target-title');
    expect(listBody).toContain(`href="/dashboard/memories/${a.id}"`);
    expect(listBody).toContain(`href="/dashboard/memories/${b.id}"`);
    expect(listBody).toContain('pill k-supersedes');
    expect(listBody).toContain(`data-href="/dashboard/judgments/${rel.id}"`);
    expect(listBody).toContain(`<a href="/dashboard/judgments/${rel.id}">`);
    expect(listBody).not.toContain('<th>id</th>');

    // Judgment detail view: renders full content for both sides, the verdict
    // pill, reason text, back-link, and resolves 404 for unknown ids.
    const detail = await get(baseUrl, `/dashboard/judgments/${rel.id}`, jar);
    expect(detail.status).toBe(200);
    const detailBody = await detail.text();
    expect(detailBody).toContain('Rembric');
    expect(detailBody).toContain('Judgment');
    expect(detailBody).toContain('BACK TO JUDGMENTS');
    expect(detailBody).toContain('judged-row-source-content');
    expect(detailBody).toContain('judged-row-target-content');
    expect(detailBody).toContain('pill k-supersedes');
    expect(detailBody).toContain('e2e demo reason');
    expect(detailBody).toContain(`href="/dashboard/memories/${a.id}"`);
    expect(detailBody).toContain(`href="/dashboard/memories/${b.id}"`);

    const missing = await get(baseUrl, '/dashboard/judgments/non-existent-id-xyz', jar);
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain('Judgment not found');
  });

  it('memories review state: needs_review badge, filter, and detail card', async () => {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });

    const { createDb } = await import('../db/index.js');
    const { MemoryService } = await import('../services/memory.js');
    const handle = createDb({ dataDir: server.config.dataDir });
    const DAY = 24 * 60 * 60 * 1000;
    // `project` TTL is 3 months → 120d-old + unaffirmed = needs_review.
    const staleSvc = new MemoryService(
      createRepositories(handle.db),
      handle.db,
      () => new Date(Date.now() - 120 * DAY),
    );
    const freshSvc = new MemoryService(createRepositories(handle.db), handle.db);
    const stale = staleSvc.save(
      { type: 'project', title: 'reviewbadge-stale-marker', content: 'reviewbadge-stale-marker' },
      defaultProjectScope(handle),
    );
    const fresh = freshSvc.save(
      { type: 'project', title: 'reviewbadge-fresh-marker', content: 'reviewbadge-fresh-marker' },
      defaultProjectScope(handle),
    );
    // `reference` has no TTL → never needs review even when ancient.
    const ref = staleSvc.save(
      {
        type: 'reference',
        title: 'reviewbadge-reference-marker',
        content: 'reviewbadge-reference-marker',
      },
      defaultProjectScope(handle),
    );
    handle.close();

    // Filter: only the stale project row surfaces; fresh + no-TTL are excluded.
    const filtered = await get(baseUrl, '/dashboard/memories?review=needs_review', jar);
    expect(filtered.status).toBe(200);
    const fbody = await filtered.text();
    expect(fbody).toContain('reviewbadge-stale-marker');
    expect(fbody).toContain('pill needs_review');
    expect(fbody).not.toContain('reviewbadge-fresh-marker');
    expect(fbody).not.toContain('reviewbadge-reference-marker');

    // The list carries a dedicated review column (separate from status).
    const list = await get(baseUrl, '/dashboard/memories?review=needs_review', jar);
    expect(await list.text()).toContain('<th>review</th>');

    // Detail of the stale memory shows the review card; the fresh one does not
    // render the needs_review badge.
    const staleDetail = await get(baseUrl, `/dashboard/memories/${stale.id}`, jar);
    const sdBody = await staleDetail.text();
    expect(sdBody).toContain('Review');
    expect(sdBody).toContain('pill needs_review');
    expect(sdBody).toContain('Review after');

    const freshDetail = await get(baseUrl, `/dashboard/memories/${fresh.id}`, jar);
    expect(await freshDetail.text()).not.toContain('pill needs_review');

    // No-TTL reference: detail omits the review card entirely.
    const refDetail = await get(baseUrl, `/dashboard/memories/${ref.id}`, jar);
    expect(await refDetail.text()).not.toContain('pill needs_review');
  });

  describe('token create → authorize', () => {
    const ALPHA = 'alpha';
    const NEVER = 'never-selected';

    async function project(slug: string) {
      return withDataDb(server.config.dataDir, (handle) => {
        const svc = new ProjectsService(createRepositories(handle.db));
        return svc.findBySlug(slug) ?? svc.create({ slug });
      });
    }

    async function persisted(name: string) {
      return withDataDb(server.config.dataDir, (handle) =>
        createRepositories(handle.db).tokens.findByName(name),
      );
    }

    async function tokenCount() {
      return withDataDb(
        server.config.dataDir,
        (handle) => createRepositories(handle.db).tokens.listAll().length,
      );
    }

    async function loggedIn(): Promise<CookieJar> {
      const jar: CookieJar = { cookie: null };
      await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });
      return jar;
    }

    it('mints a project-scoped token that authorizes that project and no other', async () => {
      const jar = await loggedIn();
      const alpha = await project(ALPHA);
      await project(NEVER);

      const minted = await mintTokenViaForm(baseUrl, jar, {
        name: 'e2e-alpha-write',
        project: ALPHA,
        access: 'write',
      });
      expect(minted.status).toBe(302);
      expect(minted.plaintext).toBeTruthy();

      // Control: without it a 403 below could be a misconfigured endpoint.
      const admin = await apiPost(baseUrl, `/api/${ALPHA}/memory/recall`, ADMIN_TOKEN, {
        query: 'anything',
      });
      expect(admin.status).toBe(200);

      const own = await apiPost(baseUrl, `/api/${ALPHA}/memory/recall`, minted.plaintext!, {
        query: 'anything',
      });
      expect(own.status).toBe(200);

      // Control: a fix making `isAuthorized` unconditionally true fails here.
      const elsewhere = await apiPost(baseUrl, `/api/${NEVER}/memory/recall`, minted.plaintext!, {
        query: 'anything',
      });
      expect(elsewhere.status).toBe(403);
      expect(elsewhere.body.code).toBe('forbidden');

      const row = await persisted('e2e-alpha-write');
      expect(row?.scope).toBe(`project:${alpha.id}`);
      expect(row?.projectId).toBe(alpha.id);
    });

    it('mints a read-access project token that authorizes reads on that project only', async () => {
      const jar = await loggedIn();
      const alpha = await project(ALPHA);
      await project(NEVER);

      const minted = await mintTokenViaForm(baseUrl, jar, {
        name: 'e2e-alpha-read',
        project: ALPHA,
        access: 'read',
      });
      expect(minted.status).toBe(302);

      const read = await apiPost(baseUrl, `/api/${ALPHA}/memory/recall`, minted.plaintext!, {
        query: 'anything',
      });
      expect(read.status).toBe(200);

      const elsewhere = await apiPost(baseUrl, `/api/${NEVER}/memory/recall`, minted.plaintext!, {
        query: 'anything',
      });
      expect(elsewhere.status).toBe(403);
      expect(elsewhere.body.code).toBe('forbidden');

      const write = await apiPost(baseUrl, `/api/${ALPHA}/sessions`, minted.plaintext!, {
        id: 'e2e-read-arm-denied-session',
        agent: 'e2e',
      });
      expect(write.status).toBe(403);
      expect(write.body.code).toBe('forbidden');

      // Control: the write endpoint itself answers 200 for an admin token.
      const adminWrite = await apiPost(baseUrl, `/api/${ALPHA}/sessions`, ADMIN_TOKEN, {
        id: 'e2e-read-arm-control-session',
        agent: 'e2e',
      });
      expect(adminWrite.status).toBe(200);

      const row = await persisted('e2e-alpha-read');
      expect(row?.scope).toBe(`read:project:${alpha.id}`);
      expect(row?.projectId).toBe(alpha.id);
    });

    it('still mints the global arms when no project is selected', async () => {
      const jar = await loggedIn();

      const write = await mintTokenViaForm(baseUrl, jar, {
        name: 'e2e-global-write',
        project: '',
        access: 'write',
      });
      expect(write.status).toBe(302);
      const writeRow = await persisted('e2e-global-write');
      expect(writeRow?.scope).toBe('*');
      expect(writeRow?.projectId).toBeNull();

      const read = await mintTokenViaForm(baseUrl, jar, {
        name: 'e2e-global-read',
        project: '',
        access: 'read',
      });
      expect(read.status).toBe(302);
      const readRow = await persisted('e2e-global-read');
      expect(readRow?.scope).toBe('read:*');
      expect(readRow?.projectId).toBeNull();

      const row = tokenRow(read.body, 'e2e-global-read');
      expect(row).toBeTruthy();
      expect(textOf(cellsOf(row!)[2]!)).toBe('—');
    });

    it('lists the project as a slug, never as an id', async () => {
      const jar = await loggedIn();
      const alpha = await project(ALPHA);

      const minted = await mintTokenViaForm(baseUrl, jar, {
        name: 'e2e-list-project-cell',
        project: ALPHA,
        access: 'write',
      });
      expect(minted.status).toBe(302);
      expect(minted.body).toContain('<th>project</th>');

      const row = tokenRow(minted.body, 'e2e-list-project-cell');
      expect(row).toBeTruthy();
      const cells = cellsOf(row!);
      expect(textOf(cells[2]!)).toBe(ALPHA);
      expect(textOf(cells[2]!)).not.toBe(alpha.id);
      expect(minted.body).not.toMatch(/<td>project:01[A-Z0-9]+<\/td>/);
    });

    it('keeps showing the slug of a token bound to a project that was archived', async () => {
      const jar = await loggedIn();
      const proj = await project('archived-token-proj');

      const minted = await mintTokenViaForm(baseUrl, jar, {
        name: 'e2e-archived-proj-token',
        project: proj.slug,
        access: 'write',
      });
      expect(minted.status).toBe(302);

      await withDataDb(server.config.dataDir, (handle) =>
        new ProjectsService(createRepositories(handle.db)).archive(proj.id),
      );

      const list = await get(baseUrl, '/dashboard/tokens', jar);
      const row = tokenRow(await list.text(), 'e2e-archived-proj-token');
      expect(row).toBeTruthy();
      expect(textOf(cellsOf(row!)[2]!)).toBe(proj.slug);
    });

    it('marks a token whose project binding does not resolve as neither active nor revoked', async () => {
      const jar = await loggedIn();
      const alpha = await project(ALPHA);

      // Legacy shape: the scope names a project by slug and nothing binds
      // it to a row. The service can no longer produce this, so it is
      // inserted through the repository.
      await withDataDb(server.config.dataDir, (handle) => {
        const repos = createRepositories(handle.db);
        for (const [name, revokedAt] of [
          ['e2e-legacy-inert', null],
          ['e2e-legacy-inert-revoked', new Date()],
        ] as const) {
          repos.tokens.insert({
            id: ulid(),
            name,
            hash: 's1$00$00',
            scope: `project:${ALPHA}`,
            projectId: null,
            createdAt: new Date(),
            expiresAt: null,
            revokedAt,
          });
        }
      });

      const healthy = await mintTokenViaForm(baseUrl, jar, {
        name: 'e2e-resolvable-bound',
        project: ALPHA,
        access: 'write',
      });
      expect(healthy.status).toBe(302);
      const unbound = await mintTokenViaForm(baseUrl, jar, {
        name: 'e2e-resolvable-global',
        project: '',
        access: 'write',
      });
      expect(unbound.status).toBe(302);

      const body = unbound.body;

      const inert = cellsOf(tokenRow(body, 'e2e-legacy-inert')!);
      expect(inert[1]).toContain(`project:${ALPHA}`);
      expect(textOf(inert[2]!)).toBe('—');
      expect(inert[5]).toContain('inert');
      expect(inert[5]).not.toContain('active');
      expect(inert[5]).not.toContain('revoked');

      expect(cellsOf(tokenRow(body, 'e2e-legacy-inert-revoked')!)[5]).toContain('revoked');
      expect(cellsOf(tokenRow(body, 'e2e-legacy-inert-revoked')!)[5]).not.toContain('inert');

      // A resolvable project binding, and no binding at all, both stay active.
      const bound = cellsOf(tokenRow(body, 'e2e-resolvable-bound')!);
      expect(bound[1]).toContain(`project:${alpha.id}`);
      expect(bound[5]).toContain('active');
      expect(bound[5]).not.toContain('inert');
      expect(cellsOf(tokenRow(body, 'e2e-resolvable-global')!)[5]).toContain('active');
      expect(cellsOf(tokenRow(body, 'e2e-resolvable-global')!)[5]).not.toContain('inert');
    });

    it('states the minted scope and bound project in the one-time view', async () => {
      const jar = await loggedIn();
      const alpha = await project(ALPHA);

      const minted = await mintTokenViaForm(baseUrl, jar, {
        name: 'e2e-one-shot-scope',
        project: ALPHA,
        access: 'read',
      });
      expect(minted.status).toBe(302);

      const panel = /<div class="one-shot">[\s\S]*?<\/div>/.exec(minted.body)?.[0];
      expect(panel).toBeTruthy();
      expect(panel).toContain(minted.plaintext!);
      expect(panel).toContain(`read:project:${alpha.id}`);
      expect(panel).toContain(ALPHA);
    });

    it('refuses a create request carrying the retired scope field', async () => {
      const jar = await loggedIn();
      const before = await tokenCount();

      const page = await get(baseUrl, '/dashboard/tokens', jar);
      const csrf = extractCsrf(await page.text(), '/dashboard/tokens');
      const res = await postForm(baseUrl, '/dashboard/tokens', jar, {
        csrf: csrf ?? '',
        name: 'e2e-retired-scope-field',
        project: '',
        access: 'write',
        scope: '*',
        expires: '',
      });

      expect(res.status).toBe(400);
      expect(await res.text()).toContain('access');
      expect(await persisted('e2e-retired-scope-field')).toBeUndefined();
      expect(await tokenCount()).toBe(before);
    });

    // Refused, not defaulted: with no project selected, `write` composes `*`,
    // which is the only scope the dashboard login accepts — so a silent default
    // hands out an admin credential to a request that never asked for a verb.
    for (const [label, access] of [
      ['empty', ''],
      ['absent', undefined],
    ] as const) {
      it(`refuses a create request whose access field is ${label}`, async () => {
        const jar = await loggedIn();
        const before = await tokenCount();
        const name = `e2e-access-${label}`;

        const page = await get(baseUrl, '/dashboard/tokens', jar);
        const csrf = extractCsrf(await page.text(), '/dashboard/tokens');
        const res = await postForm(baseUrl, '/dashboard/tokens', jar, {
          csrf: csrf ?? '',
          name,
          project: '',
          ...(access === undefined ? {} : { access }),
          expires: '',
        });

        expect(res.status).toBe(400);
        expect(await persisted(name)).toBeUndefined();
        expect(await tokenCount()).toBe(before);
      });
    }

    it('CONTROL: an explicit access still mints', async () => {
      const jar = await loggedIn();
      const page = await get(baseUrl, '/dashboard/tokens', jar);
      const csrf = extractCsrf(await page.text(), '/dashboard/tokens');
      const res = await postForm(baseUrl, '/dashboard/tokens', jar, {
        csrf: csrf ?? '',
        name: 'e2e-access-explicit',
        project: '',
        access: 'write',
        expires: '',
      });

      expect(res.status).toBe(302);
      expect((await persisted('e2e-access-explicit'))?.scope).toBe('*');
    });
  });
});

describe('dashboard E2E — self-update surface', () => {
  let server: BootstrappedServer;
  let baseUrl: string;
  const ADMIN_TOKEN = 'integration-admin-token-with-enough-entropy-upd';

  // Mutable capability the fake detector reads — tests flip quadrants.
  const capability = {
    current: { state: 'manual', reason: 'no-socket' } as Record<string, unknown>,
  };

  beforeAll(async () => {
    const [{ createTestDb }, { FakeEmbedder }] = [
      await import('./db.js'),
      await import('./embedder.js'),
    ];
    const { UpdateCheckService } = await import('../services/update-check.js');
    const { SelfUpdateOrchestrator } = await import('../services/self-update/orchestrator.js');

    const tmp = createTestDb();
    tmp.cleanup();
    const port = await findFreePort();

    const fakeFetch = (() =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              tag_name: 'server-v9.9.9',
              body: '## New features\n- e2e changelog entry',
              html_url: 'https://github.com/susomejias/rembric/releases/tag/server-v9.9.9',
              published_at: '2026-06-01T00:00:00Z',
              prerelease: false,
              draft: false,
            },
          ]),
          { status: 200 },
        ),
      )) as typeof fetch;
    const updates = new UpdateCheckService({ enabled: true, fetchImpl: fakeFetch });
    await updates.refresh();

    // Duck-typed stand-in for CapabilityDetector; tests mutate `capability.current`.
    const fakeDetector = {
      detect: () => Promise.resolve(capability.current),
      detectCached: () => Promise.resolve(capability.current),
    } as unknown as ConstructorParameters<typeof SelfUpdateOrchestrator>[0]['capability'];
    const selfUpdate = new SelfUpdateOrchestrator({
      capability: fakeDetector,
      engineFactory: () => {
        throw new Error('engine must not be reached in these tests');
      },
      backup: () => {
        throw new Error('backup must not be reached in these tests');
      },
      log: () => {},
    });

    server = await createServer(
      {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: String(port),
        REMBRIC_DATA_DIR: tmp.dataDir,
        REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
      },
      { embedder: new FakeEmbedder(), updates, selfUpdate },
    );
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await server.shutdown();
  });

  async function login(): Promise<CookieJar> {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });
    return jar;
  }

  it('renders the update badge and the per-version modal on every page', async () => {
    capability.current = { state: 'manual', reason: 'no-socket' };
    const jar = await login();
    const home = await get(baseUrl, '/dashboard', jar);
    const body = await home.text();
    expect(body).toContain('sb-update');
    expect(body).toContain('UPDATE v9.9.9');
    expect(body).toContain('id="rbr-update"');
    expect(body).toContain('data-version="9.9.9"');
    expect(body).toContain('e2e changelog entry');

    const memories = await get(baseUrl, '/dashboard/memories', jar);
    expect(await memories.text()).toContain('sb-update');
  });

  it('manual quadrant: copy-paste command + docs link, no update button', async () => {
    capability.current = { state: 'manual', reason: 'no-socket' };
    const jar = await login();
    const page = await get(baseUrl, '/dashboard/update', jar);
    const body = await page.text();
    expect(body).toContain('docker compose pull');
    expect(body).toContain('docs/updates.md');
    expect(body).not.toContain('action="/dashboard/update/start"');
  });

  it('pinned quadrant: explanation instead of button', async () => {
    capability.current = {
      state: 'pinned',
      reason: 'pinned-tag',
      containerId: 'abc',
      imageRepo: 'ghcr.io/susomejias/rembric',
      imageTag: '0.21.1',
    };
    const jar = await login();
    const page = await get(baseUrl, '/dashboard/update', jar);
    const body = await page.text();
    expect(body).toContain('IMAGE TAG PINNED');
    expect(body).toContain(':0.21.1');
    expect(body).not.toContain('action="/dashboard/update/start"');
  });

  it('available quadrant: danger-tone confirm form with CSRF', async () => {
    capability.current = {
      state: 'available',
      reason: 'ok',
      containerId: 'abc',
      imageRepo: 'ghcr.io/susomejias/rembric',
      imageTag: 'latest',
    };
    const jar = await login();
    const page = await get(baseUrl, '/dashboard/update', jar);
    const body = await page.text();
    expect(body).toContain('action="/dashboard/update/start"');
    expect(body).toContain('data-confirm-tone="danger"');
    expect(body).toContain('back up the database');
    expect(extractCsrf(body, '/dashboard/update/start')).toBeTruthy();
  });

  it('start without CSRF returns 403', async () => {
    const jar = await login();
    const res = await postForm(baseUrl, '/dashboard/update/start', jar, {});
    expect(res.status).toBe(403);
  });

  it('start is refused with no side effects when capability is not available', async () => {
    capability.current = { state: 'manual', reason: 'no-socket' };
    const jar = await login();
    const page = await get(baseUrl, '/dashboard/update', jar);
    // The form is not rendered, but a handcrafted POST must also bounce.
    // Mint a CSRF via the modal on a page where the form exists? It does
    // not — so reuse the sidebar-toggle pattern: pull CSRF from the
    // available quadrant first, then flip to manual.
    capability.current = {
      state: 'available',
      reason: 'ok',
      containerId: 'abc',
      imageRepo: 'ghcr.io/susomejias/rembric',
      imageTag: 'latest',
    };
    const armed = await get(baseUrl, '/dashboard/update', jar);
    const csrf = extractCsrf(await armed.text(), '/dashboard/update/start');
    expect(csrf).toBeTruthy();
    capability.current = { state: 'manual', reason: 'no-socket' };
    const res = await postForm(baseUrl, '/dashboard/update/start', jar, { csrf: csrf! });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('err=not_available');
    void page;
  });

  it('version probe answers the running version behind the session', async () => {
    const jar = await login();
    const res = await get(baseUrl, '/dashboard/update/version', jar);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: REMBRIC_VERSION });

    const anon: CookieJar = { cookie: null };
    const unauth = await get(baseUrl, '/dashboard/update/version', anon);
    expect([302, 401]).toContain(unauth.status);
  });

  it('status endpoint reports idle before any run', async () => {
    const jar = await login();
    const res = await get(baseUrl, '/dashboard/update/status', jar);
    expect(res.status).toBe(200);
    const status = (await res.json()) as { phase: string };
    expect(status.phase).toBe('idle');
  });
});

describe('dashboard E2E — manual update check', () => {
  let server: BootstrappedServer;
  let baseUrl: string;
  const ADMIN_TOKEN = 'integration-admin-token-with-enough-entropy-chk';

  // Mutable release feed the fake fetch serves — tests flip outcomes.
  const feed = { mode: 'old' as 'old' | 'new' | 'fail' };

  beforeAll(async () => {
    const { UpdateCheckService } = await import('../services/update-check.js');
    const { SelfUpdateOrchestrator } = await import('../services/self-update/orchestrator.js');

    const tmp = createTestDb();
    tmp.cleanup();
    const port = await findFreePort();

    const fakeFetch = (() => {
      if (feed.mode === 'fail') return Promise.reject(new Error('offline'));
      const tag = feed.mode === 'new' ? 'server-v9.9.9' : 'server-v0.0.1';
      return Promise.resolve(
        new Response(
          JSON.stringify([
            {
              tag_name: tag,
              body: '## manual-check changelog',
              html_url: 'https://github.com/susomejias/rembric/releases',
              published_at: '2026-06-01T00:00:00Z',
              prerelease: false,
              draft: false,
            },
          ]),
          { status: 200 },
        ),
      );
    }) as typeof fetch;
    const updates = new UpdateCheckService({ enabled: true, fetchImpl: fakeFetch });

    const fakeDetector = {
      detect: () => Promise.resolve({ state: 'manual', reason: 'no-socket' }),
      detectCached: () => Promise.resolve({ state: 'manual', reason: 'no-socket' }),
    } as unknown as ConstructorParameters<typeof SelfUpdateOrchestrator>[0]['capability'];
    const selfUpdate = new SelfUpdateOrchestrator({
      capability: fakeDetector,
      engineFactory: () => {
        throw new Error('engine must not be reached in these tests');
      },
      backup: () => {
        throw new Error('backup must not be reached in these tests');
      },
      log: () => {},
    });

    server = await createServer(
      {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: String(port),
        REMBRIC_DATA_DIR: tmp.dataDir,
        REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
      },
      { embedder: new FakeEmbedder(), updates, selfUpdate },
    );
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await server.shutdown();
  });

  async function login(): Promise<CookieJar> {
    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });
    return jar;
  }

  async function armCsrf(jar: CookieJar): Promise<string> {
    const page = await get(baseUrl, '/dashboard/update', jar);
    const csrf = extractCsrf(await page.text(), '/dashboard/update/check');
    expect(csrf).toBeTruthy();
    return csrf!;
  }

  it('renders the quiet UP TO DATE slot in sidebar and mobile bar when no update is known', async () => {
    const jar = await login();
    const home = await get(baseUrl, '/dashboard', jar);
    const body = await home.text();
    expect(body.match(/sb-update is-quiet/g)?.length).toBeGreaterThanOrEqual(2);
    expect(body).toContain('UP TO DATE ›');
    expect(body).not.toContain('id="rbr-update"');
  });

  it('up-to-date page offers CHECK NOW with CSRF and shows last-checked', async () => {
    const jar = await login();
    const page = await get(baseUrl, '/dashboard/update', jar);
    const body = await page.text();
    expect(body).toContain('UP TO DATE');
    expect(body).toContain('action="/dashboard/update/check"');
    expect(body).toContain('CHECK NOW');
    expect(body).toContain('LAST CHECKED');
    // Read-only action — no confirmation modal on the form itself.
    const formTag = /<form[^>]*action="\/dashboard\/update\/check"[^>]*>/.exec(body)?.[0];
    expect(formTag).toBeTruthy();
    expect(formTag).not.toContain('data-confirm');
    expect(extractCsrf(body, '/dashboard/update/check')).toBeTruthy();
  });

  it('check without CSRF returns 403', async () => {
    const jar = await login();
    const res = await postForm(baseUrl, '/dashboard/update/check', jar, {});
    expect(res.status).toBe(403);
  });

  it('manual check walks none → error → update', async () => {
    const jar = await login();

    feed.mode = 'old';
    let res = await postForm(baseUrl, '/dashboard/update/check', jar, { csrf: await armCsrf(jar) });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('checked=none');
    let body = await (await get(baseUrl, '/dashboard/update?checked=none', jar)).text();
    expect(body).toContain('no newer release is known');

    feed.mode = 'fail';
    res = await postForm(baseUrl, '/dashboard/update/check', jar, { csrf: await armCsrf(jar) });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('checked=error');
    body = await (await get(baseUrl, '/dashboard/update?checked=error', jar)).text();
    expect(body).toContain('could not reach GitHub');

    feed.mode = 'new';
    res = await postForm(baseUrl, '/dashboard/update/check', jar, { csrf: await armCsrf(jar) });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).not.toContain('checked=');
    body = await (await get(baseUrl, '/dashboard/update', jar)).text();
    expect(body).toContain('v9.9.9');
    expect(body).toContain('manual-check changelog');
    expect(body).not.toContain('action="/dashboard/update/check"');
    expect(body).toContain('sb-update');
    expect(body).not.toContain('is-quiet');
  });
});

describe('dashboard E2E — zero-action compatibility', () => {
  // openspec/specs/self-update: a deployment without the Docker socket and
  // without any new configuration boots and operates identically, with the
  // feature in its degraded form and no badge when the check is off.
  let server: BootstrappedServer;
  let baseUrl: string;
  const ADMIN_TOKEN = 'integration-admin-token-with-enough-entropy-zac';

  beforeAll(async () => {
    const { createTestDb } = await import('./db.js');
    const { FakeEmbedder } = await import('./embedder.js');
    const tmp = createTestDb();
    tmp.cleanup();
    const port = await findFreePort();
    server = await createServer(
      {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: String(port),
        REMBRIC_DATA_DIR: tmp.dataDir,
        REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
        REMBRIC_UPDATE_CHECK: 'off',
      },
      { embedder: new FakeEmbedder() },
    );
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await server.shutdown();
  });

  it('boots and serves healthz, dashboard and MCP surfaces with no update chrome', async () => {
    const health = await fetch(`${baseUrl}/healthz`, {
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(health.status).toBe(200);

    const jar: CookieJar = { cookie: null };
    await postForm(baseUrl, '/dashboard/login', jar, { token: ADMIN_TOKEN });
    const home = await get(baseUrl, '/dashboard', jar);
    expect(home.status).toBe(200);
    const body = await home.text();
    expect(body).toContain(`v${REMBRIC_VERSION}`);
    expect(body).not.toContain('sb-update');
    expect(body).not.toContain('id="rbr-update"');

    // The update page itself degrades to the disabled notice — no
    // manual-check form, no claim about being up to date.
    const page = await get(baseUrl, '/dashboard/update', jar);
    expect(page.status).toBe(200);
    const pageBody = await page.text();
    expect(pageBody).toContain('UPDATE CHECK DISABLED');
    expect(pageBody).not.toContain('action="/dashboard/update/check"');
    expect(pageBody).not.toContain('UP TO DATE');
  });
});
