import { createServer as createNetServer } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import type { Project } from '../db/schema/projects.js';
import { tokens as tokensTable } from '../db/schema/tokens.js';
import { type BootstrappedServer, createServer } from '../server/index.js';
import { ProjectsService } from '../services/projects.js';

import { createTestDb } from './db.js';
import { defaultProject } from './default-project.js';
import { FakeEmbedder } from './embedder.js';

/**
 * Authorization over a token's reach, exercised on the four boundaries a real
 * caller uses and never on a handler directly: the dashboard mint form
 * (`POST /dashboard/tokens`) so the persisted scope string is the one the real
 * producer writes, `POST /dashboard/login` and `POST /admin/*` for the admin
 * gates, the MCP SDK's `StreamableHTTPClientTransport` (a direct handler call
 * would bypass the tool's zod schema), and `POST /api/<slug>/sessions`.
 *
 * Every refusal asserted here is paired with a success on the same instrument.
 * A malformed probe is indistinguishable from a denial: a `memory.save` whose
 * `type` is outside `MEMORY_TYPES`, or a session POST without an `id` matching
 * `^[A-Za-z0-9_-]{8,128}$`, is refused before authorization is ever consulted.
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
        reject(new Error('expected an AddressInfo'));
        return;
      }
      const { port } = addr;
      sock.close(() => resolve(port));
    });
  });
}

interface Jar {
  cookie: string | null;
}

type FormEntries = Array<[string, string]>;

/**
 * A refusal at authentication is a materially different shape from a
 * tool-level denial, and the SDK surfaces it as a thrown transport error whose
 * text carries the JSON body but no status — so the status is measured with a
 * raw POST instead of guessed from the throw.
 */
type McpOutcome =
  | { ok: true }
  | { ok: false; code: string | null }
  | { ok: false; refusedAtAuth: true; code: string | null };

const ADMIN_TOKEN = 'set-scope-admin-token-with-enough-entropy-zz';
const READ_TOOL = 'memory.search';
const WRITE_TOOL = 'memory.save';
const INVALID_BEARER = 'rmb_not-a-real-token';

const readArgs = { query: 'setscopeprobe' };
const writeArgs = (marker: string): Record<string, unknown> => ({
  type: 'project',
  title: `set scope probe ${marker}`.slice(0, 100),
  content: `setscopeprobe ${marker}`,
});

describe('token project sets', () => {
  let server: BootstrappedServer;
  let baseUrl: string;
  let alpha: Project;
  let beta: Project;
  let gamma: Project;
  let sessionSeq = 0;

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
        REMBRIC_UPDATE_CHECK: 'off',
        // Every probe shares one network identity, so the default threshold of
        // ten failed authentications would answer 429 where a test asserts 401.
        AUTH_LOCKOUT_MAX_FAILURES: '10000',
      },
      { embedder: new FakeEmbedder() },
    );
    baseUrl = `http://127.0.0.1:${port}`;

    const projects = new ProjectsService(createRepositories(server.dbHandle.db));
    alpha = projects.findBySlug('alpha') ?? projects.create({ slug: 'alpha' });
    beta = projects.findBySlug('beta') ?? projects.create({ slug: 'beta' });
    gamma = projects.findBySlug('gamma') ?? projects.create({ slug: 'gamma' });
  }, 30_000);

  afterAll(async () => {
    await server.shutdown();
  });

  async function get(path: string, jar: Jar): Promise<Response> {
    const headers: Record<string, string> = {};
    if (jar.cookie) headers.cookie = jar.cookie;
    const res = await fetch(baseUrl + path, { headers, redirect: 'manual' });
    storeCookie(jar, res);
    return res;
  }

  async function postForm(path: string, jar: Jar, entries: FormEntries): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/x-www-form-urlencoded',
    };
    if (jar.cookie) headers.cookie = jar.cookie;
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers,
      body: new URLSearchParams(entries).toString(),
      redirect: 'manual',
    });
    storeCookie(jar, res);
    return res;
  }

  function storeCookie(jar: Jar, res: Response): void {
    const set = res.headers.get('set-cookie');
    if (!set) return;
    const match = /(?:^|,\s*)(rembric_session=[^;]+)/.exec(set);
    if (match) jar.cookie = match[1] ?? null;
  }

  async function loggedIn(): Promise<Jar> {
    const jar: Jar = { cookie: null };
    const res = await postForm('/dashboard/login', jar, [['token', ADMIN_TOKEN]]);
    expect(res.status, 'admin login').toBe(302);
    expect(jar.cookie).toMatch(/^rembric_session=/);
    return jar;
  }

  /**
   * The CSRF token is issued per form name, so one form's token is rejected by
   * another's handler. The action is matched with its closing quote: the
   * bootstrap admin token is itself a `tokens` row, so `/dashboard/tokens` also
   * renders a revoke form whose action merely contains the create form's path
   * and comes first in the document.
   */
  function csrfFor(html: string, action: string): string {
    const fragment = html
      .split('<form')
      .slice(1)
      .find((f) => f.includes(`action="${action}"`));
    expect(fragment, `no form with action="${action}"`).toBeDefined();
    const csrf = /name="csrf"\s+value="([^"]+)"/.exec(fragment!)?.[1];
    expect(csrf, `no csrf input on action="${action}"`).toBeTruthy();
    return csrf!;
  }

  interface Minted {
    status: number;
    /** Present only on a 302: the mint answers with the plaintext in `Location`. */
    plaintext: string | null;
    /** The tokens page after the redirect, or the flash-error page. */
    body: string;
  }

  async function mint(
    jar: Jar,
    fields: { name: string; projects: string[]; access: string },
  ): Promise<Minted> {
    const page = await get('/dashboard/tokens', jar);
    const csrf = csrfFor(await page.text(), '/dashboard/tokens');
    const entries: FormEntries = [
      ['csrf', csrf],
      ['name', fields.name],
      ['access', fields.access],
      ['expires', ''],
    ];
    if (fields.projects.length === 0) entries.push(['project', '']);
    for (const slug of fields.projects) entries.push(['project', slug]);

    const res = await postForm('/dashboard/tokens', jar, entries);
    if (res.status !== 302) {
      return { status: res.status, plaintext: null, body: await res.text() };
    }
    const location = res.headers.get('location') ?? '';
    const plaintext = new URL(location, baseUrl).searchParams.get('created');
    const after = await get(location, jar);
    return { status: res.status, plaintext, body: await after.text() };
  }

  async function mintPlaintext(
    jar: Jar,
    fields: { name: string; projects: string[]; access: string },
  ): Promise<string> {
    const minted = await mint(jar, fields);
    expect(minted.status, `mint ${fields.name}: ${minted.body.slice(0, 300)}`).toBe(302);
    expect(minted.plaintext, `mint ${fields.name} carried no plaintext`).toBeTruthy();
    return minted.plaintext!;
  }

  async function mcpCall(
    path: string,
    token: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpOutcome> {
    const client = new Client({ name: 'set-scope-probe', version: '0.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(path, baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    try {
      await client.connect(transport);
    } catch (err) {
      return {
        ok: false,
        refusedAtAuth: true,
        code: /"code":"([^"]+)"/.exec(String(err))?.[1] ?? null,
      };
    }
    try {
      const res = (await client.callTool({ name: tool, arguments: args })) as {
        isError?: boolean;
        content?: Array<{ type: string; text?: string }>;
      };
      if (!res.isError) return { ok: true };
      const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
      try {
        return { ok: false, code: (JSON.parse(text) as { code?: string }).code ?? null };
      } catch {
        return { ok: false, code: text.slice(0, 120) };
      }
    } finally {
      await client.close().catch(() => {});
    }
  }

  const mcpRead = (path: string, token: string): Promise<McpOutcome> =>
    mcpCall(path, token, READ_TOOL, readArgs);
  const mcpWrite = (path: string, token: string, marker: string): Promise<McpOutcome> =>
    mcpCall(path, token, WRITE_TOOL, writeArgs(marker));

  /** The status the MCP surface answers before any tool dispatch. */
  async function mcpAuthStatus(
    path: string,
    token: string,
  ): Promise<{ status: number; code: string | null }> {
    const res = await fetch(baseUrl + path, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'set-scope-probe', version: '0.0.0' },
        },
      }),
    });
    const text = await res.text();
    return { status: res.status, code: /"code":"([^"]+)"/.exec(text)?.[1] ?? null };
  }

  async function apiSession(
    slug: string,
    token: string,
  ): Promise<{ status: number; code: string | null }> {
    const res = await fetch(`${baseUrl}/api/${slug}/sessions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        id: `set-scope-session-${String(++sessionSeq).padStart(4, '0')}`,
        agent: 'set-scope-probe',
      }),
    });
    const body = (await res.json()) as { code?: string };
    return { status: res.status, code: body.code ?? null };
  }

  async function login(token: string): Promise<number> {
    const res = await postForm('/dashboard/login', { cookie: null }, [['token', token]]);
    return res.status;
  }

  async function adminRoute(token: string): Promise<{ status: number; code: string | null }> {
    const res = await fetch(`${baseUrl}/admin/consolidation/run`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    const body = (await res.json()) as { code?: string };
    return { status: res.status, code: body.code ?? null };
  }

  function persisted(name: string) {
    return server.dbHandle.db.select().from(tokensTable).where(eq(tokensTable.name, name)).get();
  }

  function allProjects(): Project[] {
    return new ProjectsService(createRepositories(server.dbHandle.db)).list(true);
  }

  /** Member project ids of a token, ascending. Throws while the table is absent. */
  function memberIds(tokenId: string): string[] {
    const rows = server.dbHandle.raw
      .prepare(
        'SELECT project_id AS projectId FROM token_projects WHERE token_id = ? ORDER BY project_id',
      )
      .all(tokenId) as Array<{ projectId: string }>;
    return rows.map((r) => r.projectId);
  }

  describe('controls that must hold on both sides of the change', () => {
    it('an admin token reaches a project over MCP and HTTP and opens a dashboard session', async () => {
      const jar = await loggedIn();
      const star = await mintPlaintext(jar, {
        name: 'control-star',
        projects: [],
        access: 'write',
      });
      expect(persisted('control-star')?.scope).toBe('*');

      expect(await mcpRead(`/mcp/${alpha.slug}`, star)).toEqual({ ok: true });
      expect(await mcpWrite(`/mcp/${alpha.slug}`, star, 'control-star')).toEqual({ ok: true });
      expect(await apiSession(alpha.slug, star)).toEqual({ status: 200, code: null });
      expect(await login(star)).toBe(302);
    });

    it('a project-scoped token is denied another project, and authorized on its own', async () => {
      const jar = await loggedIn();
      const forAlpha = await mintPlaintext(jar, {
        name: 'control-alpha-only',
        projects: [alpha.slug],
        access: 'write',
      });
      expect(persisted('control-alpha-only')?.scope).toBe(`project:${alpha.id}`);

      // The pairing is the point: without these three the refusals below are
      // indistinguishable from a malformed probe, and an `isAuthorized` that
      // returned true unconditionally would pass every other test in the file.
      expect(await mcpRead(`/mcp/${alpha.slug}`, forAlpha)).toEqual({ ok: true });
      expect(await mcpWrite(`/mcp/${alpha.slug}`, forAlpha, 'control-alpha')).toEqual({ ok: true });
      expect(await apiSession(alpha.slug, forAlpha)).toEqual({ status: 200, code: null });

      const home = defaultProject(server.dbHandle);
      expect(await mcpRead(`/mcp/${home.slug}`, forAlpha)).toEqual({
        ok: false,
        code: 'forbidden',
      });
      expect(await mcpWrite(`/mcp/${home.slug}`, forAlpha, 'control-home')).toEqual({
        ok: false,
        code: 'forbidden',
      });
      expect(await apiSession(home.slug, forAlpha)).toEqual({ status: 403, code: 'forbidden' });
    });

    it('an invalid bearer is refused on every surface', async () => {
      const home = defaultProject(server.dbHandle);
      // Clears the shared identity's failure record before the run, so the
      // statuses below are authentication answers rather than lockout answers.
      await loggedIn();

      expect(await login(INVALID_BEARER)).toBe(401);
      for (const path of ['/mcp', `/mcp/${alpha.slug}`, `/mcp/${home.slug}`]) {
        expect(await mcpAuthStatus(path, INVALID_BEARER), path).toEqual({
          status: 401,
          code: 'token_invalid',
        });
        expect(await mcpRead(path, INVALID_BEARER), `${path} read`).toEqual({
          ok: false,
          refusedAtAuth: true,
          code: 'token_invalid',
        });
        expect(await mcpWrite(path, INVALID_BEARER, 'invalid'), `${path} write`).toEqual({
          ok: false,
          refusedAtAuth: true,
          code: 'token_invalid',
        });
      }
      for (const slug of [alpha.slug, home.slug]) {
        expect(await apiSession(slug, INVALID_BEARER), slug).toEqual({
          status: 401,
          code: 'token_invalid',
        });
      }
    });
  });

  describe('a token minted over several projects', () => {
    it('persists the set literal, no single-project binding, and one membership row per project', async () => {
      const jar = await loggedIn();
      await mintPlaintext(jar, {
        name: 'set-mint-shape',
        projects: [alpha.slug, gamma.slug],
        access: 'write',
      });

      const row = persisted('set-mint-shape');
      expect(row).toBeDefined();
      expect(row!.scope).toBe('projects');
      expect(row!.projectId).toBeNull();
      expect(memberIds(row!.id)).toEqual([alpha.id, gamma.id].sort());
    });

    it('reaches every member and is denied every non-member, including the path-less connection', async () => {
      const jar = await loggedIn();
      const set = await mintPlaintext(jar, {
        name: 'set-reach',
        projects: [alpha.slug, gamma.slug],
        access: 'write',
      });

      for (const member of [alpha, gamma]) {
        expect(await mcpRead(`/mcp/${member.slug}`, set), `${member.slug} read`).toEqual({
          ok: true,
        });
        expect(
          await mcpWrite(`/mcp/${member.slug}`, set, member.slug),
          `${member.slug} write`,
        ).toEqual({ ok: true });
      }
      expect(await apiSession(alpha.slug, set)).toEqual({ status: 200, code: null });

      // Asserted in the same test as the reach above, never a separate one that
      // could be skipped: the successes are what prove these probes well-formed.
      expect(await mcpRead(`/mcp/${beta.slug}`, set)).toEqual({ ok: false, code: 'forbidden' });
      expect(await mcpWrite(`/mcp/${beta.slug}`, set, 'beta')).toEqual({
        ok: false,
        code: 'forbidden',
      });
      expect(await mcpRead('/mcp', set)).toEqual({ ok: false, code: 'forbidden' });
      expect(await mcpWrite('/mcp', set, 'pathless')).toEqual({ ok: false, code: 'forbidden' });
      expect(await apiSession(beta.slug, set)).toEqual({ status: 403, code: 'forbidden' });
    });

    it('is not an admin token even when its set names every project', async () => {
      const jar = await loggedIn();
      const every = allProjects();
      expect(every.length, 'a one-project set would not test breadth').toBeGreaterThanOrEqual(3);

      const star = await mintPlaintext(jar, {
        name: 'escalation-control-star',
        projects: [],
        access: 'write',
      });
      const set = await mintPlaintext(jar, {
        name: 'escalation-set-every-project',
        projects: every.map((p) => p.slug),
        access: 'write',
      });

      // The `*` control first: without it a refusal below cannot be told from a
      // gate that refuses everything.
      expect(await login(star)).toBe(302);
      expect(await adminRoute(star)).toMatchObject({ status: 200 });

      expect(await login(set)).toBe(401);
      expect(await adminRoute(set)).toEqual({ status: 403, code: 'forbidden' });

      // Breadth is what the refusals above have to be about, so the subject has
      // to actually be a set over every project.
      const row = persisted('escalation-set-every-project');
      expect(row!.scope).toBe('projects');
      expect(memberIds(row!.id)).toEqual(every.map((p) => p.id).sort());
    });
  });
});
