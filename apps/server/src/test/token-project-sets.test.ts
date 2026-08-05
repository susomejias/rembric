import { createServer as createNetServer } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { eq } from 'drizzle-orm';
import { ulid } from 'ulid';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { memory } from '../db/schema/memory.js';
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

  /** A successful tool call's payload. Throws on a refusal, so a denial cannot read as an empty list. */
  async function mcpPayload(
    path: string,
    token: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const client = new Client({ name: 'set-scope-probe', version: '0.0.0' }, { capabilities: {} });
    const transport = new StreamableHTTPClientTransport(new URL(path, baseUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    await client.connect(transport);
    try {
      const res = (await client.callTool({ name: tool, arguments: args })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
        content?: Array<{ type: string; text?: string }>;
      };
      const text = res.content?.find((c) => c.type === 'text')?.text ?? '';
      expect(res.isError, `${tool} on ${path} was refused: ${text}`).not.toBe(true);
      return res.structuredContent ?? {};
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

  function removeMember(tokenId: string, projectId: string): void {
    const info = server.dbHandle.raw
      .prepare('DELETE FROM token_projects WHERE token_id = ? AND project_id = ?')
      .run(tokenId, projectId);
    expect(info.changes, 'no membership row was removed').toBe(1);
  }

  /**
   * Re-label an already-minted token, so a shape the typed producer cannot yet
   * compose still has a plaintext that authenticates. `tokens.scope` is a text
   * column and the CHECK admits any scope string alongside a NULL binding.
   */
  function relabelScope(name: string, scope: string): string {
    const row = persisted(name);
    expect(row, `token ${name} was not persisted`).toBeDefined();
    server.dbHandle.db
      .update(tokensTable)
      .set({ scope, projectId: null })
      .where(eq(tokensTable.name, name))
      .run();
    return row!.id;
  }

  function countRows(table: 'tokens' | 'token_projects' | 'projects'): number {
    const row = server.dbHandle.raw.prepare(`SELECT count(*) AS n FROM ${table}`).get() as {
      n: number;
    };
    return row.n;
  }

  function tableExists(name: string): boolean {
    return (
      server.dbHandle.raw
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`)
        .get(name) !== undefined
    );
  }

  /** A row the service can no longer compose, inserted for its rendering alone. */
  function insertTokenRow(values: { name: string; scope: string; revoked?: boolean }): void {
    createRepositories(server.dbHandle.db).tokens.insert({
      id: ulid(),
      name: values.name,
      hash: 's1$00$00',
      scope: values.scope,
      projectId: null,
      createdAt: new Date(),
      expiresAt: null,
      revokedAt: values.revoked === true ? new Date() : null,
    });
  }

  function tokenRow(html: string, name: string): string {
    const row = new RegExp(`<tr>\\s*<td>${name}</td>[\\s\\S]*?</tr>`).exec(html)?.[0];
    expect(row, `no token row named ${name}`).toBeTruthy();
    return row!;
  }

  function cellsOf(row: string): string[] {
    return [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => (m[1] ?? '').trim());
  }

  function textOf(cell: string): string {
    return cell
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function memoryCount(projectId: string): number {
    return server.dbHandle.db
      .select({ id: memory.id })
      .from(memory)
      .where(eq(memory.projectId, projectId))
      .all().length;
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

    it('reads but does not write its members when the set is read-only', async () => {
      const jar = await loggedIn();
      const readSet = await mintPlaintext(jar, {
        name: 'set-read-only',
        projects: [alpha.slug, gamma.slug],
        access: 'read',
      });
      const row = persisted('set-read-only');
      expect(row!.scope).toBe('read:projects');
      expect(row!.projectId).toBeNull();

      const before = memoryCount(alpha.id);
      expect(await mcpRead(`/mcp/${alpha.slug}`, readSet)).toEqual({ ok: true });
      expect(await mcpWrite(`/mcp/${alpha.slug}`, readSet, 'read-set')).toEqual({
        ok: false,
        code: 'forbidden',
      });
      expect(await apiSession(alpha.slug, readSet)).toEqual({ status: 403, code: 'forbidden' });
      expect(memoryCount(alpha.id), 'a refused write persisted a row').toBe(before);

      // Down to the single member the requirement names. A one-member set is
      // not mintable from the form, which mints the single-project arm there.
      removeMember(row!.id, gamma.id);
      expect(memberIds(row!.id)).toEqual([alpha.id]);
      expect(await mcpRead(`/mcp/${alpha.slug}`, readSet)).toEqual({ ok: true });
      expect(await mcpWrite(`/mcp/${alpha.slug}`, readSet, 'read-set-single')).toEqual({
        ok: false,
        code: 'forbidden',
      });
      expect(memoryCount(alpha.id)).toBe(before);
    });

    it('loses a removed member on the next request with the credential cache already warm', async () => {
      const jar = await loggedIn();
      const set = await mintPlaintext(jar, {
        name: 'set-membership-freshness',
        projects: [alpha.slug, gamma.slug],
        access: 'write',
      });
      const row = persisted('set-membership-freshness');

      // This request is what warms the plaintext → token id cache, so the
      // refusal below is answered on the cached-lookup path — the one whose
      // permission to persist indefinitely rests on re-reading authorization
      // state every time.
      expect(await mcpRead(`/mcp/${gamma.slug}`, set)).toEqual({ ok: true });

      removeMember(row!.id, gamma.id);

      expect(await mcpRead(`/mcp/${gamma.slug}`, set)).toEqual({ ok: false, code: 'forbidden' });
      expect(await apiSession(gamma.slug, set)).toEqual({ status: 403, code: 'forbidden' });
      expect(await mcpRead(`/mcp/${alpha.slug}`, set)).toEqual({ ok: true });
      expect(await mcpWrite(`/mcp/${alpha.slug}`, set, 'still-a-member')).toEqual({ ok: true });
    });

    it('authorizes nothing while its set is empty', async () => {
      const jar = await loggedIn();
      const home = defaultProject(server.dbHandle);
      const star = await mintPlaintext(jar, {
        name: 'empty-set-control-star',
        projects: [],
        access: 'write',
      });
      const empty = await mintPlaintext(jar, {
        name: 'empty-set-subject',
        projects: [],
        access: 'write',
      });
      // Never given a member, so its whole reach would have to come from the
      // scope string — which is the thing that must authorize nothing.
      relabelScope('empty-set-subject', 'projects');

      expect(await login(empty)).toBe(401);
      for (const path of ['/mcp', `/mcp/${alpha.slug}`, `/mcp/${home.slug}`]) {
        expect(await mcpRead(path, empty), `${path} read`).toEqual({
          ok: false,
          code: 'forbidden',
        });
        expect(await mcpWrite(path, empty, 'empty-set'), `${path} write`).toEqual({
          ok: false,
          code: 'forbidden',
        });
      }
      for (const slug of [alpha.slug, home.slug]) {
        expect(await apiSession(slug, empty), slug).toEqual({ status: 403, code: 'forbidden' });
      }

      expect(await login(star)).toBe(302);
      for (const path of ['/mcp', `/mcp/${alpha.slug}`, `/mcp/${home.slug}`]) {
        expect(await mcpRead(path, star), `control ${path} read`).toEqual({ ok: true });
        expect(await mcpWrite(path, star, 'empty-set-control'), `control ${path} write`).toEqual({
          ok: true,
        });
      }
      for (const slug of [alpha.slug, home.slug]) {
        expect(await apiSession(slug, star), `control ${slug}`).toEqual({
          status: 200,
          code: null,
        });
      }
    });

    it('is the filter behind both project tools, and sees exactly its members', async () => {
      const jar = await loggedIn();
      const set = await mintPlaintext(jar, {
        name: 'set-project-tools',
        projects: [alpha.slug, gamma.slug],
        access: 'write',
      });
      const home = defaultProject(server.dbHandle);

      // `project.list` filters on `isAuthorized` (`mcp/project-tools.ts`), so a
      // set token sees exactly its members. The absences are what make the two
      // present slugs evidence of a filter rather than of a list.
      const listed = await mcpPayload('/mcp', set, 'project.list', {});
      const slugs = (listed.projects as Array<{ slug: string }>).map((p) => p.slug);
      expect(slugs.sort()).toEqual([alpha.slug, gamma.slug].sort());
      expect(slugs).not.toContain(beta.slug);
      expect(slugs).not.toContain(home.slug);

      // `project.use`'s read gate is that same function, on a fresh transport
      // per call so neither answer is a switch-confirmation.
      expect(await mcpCall('/mcp', set, 'project.use', { slug: gamma.slug })).toEqual({ ok: true });
      expect(await mcpCall('/mcp', set, 'project.use', { slug: beta.slug })).toEqual({
        ok: false,
        code: 'forbidden',
      });
    });

    it('cannot create the project it would need to reach', async () => {
      const jar = await loggedIn();
      const set = await mintPlaintext(jar, {
        name: 'set-autocreate',
        projects: [alpha.slug, gamma.slug],
        access: 'write',
      });
      const star = await mintPlaintext(jar, {
        name: 'set-autocreate-control-star',
        projects: [],
        access: 'write',
      });
      const projects = new ProjectsService(createRepositories(server.dbHandle.db));
      expect(projects.findBySlug('brand-new')).toBeUndefined();

      // The path-less connection: a path-scoped one refuses `project.use` with
      // `scope_locked` before the autocreate gate is reached.
      expect(
        await mcpCall('/mcp', set, 'project.use', { slug: 'brand-new', autocreate: true }),
      ).toEqual({ ok: false, code: 'forbidden' });
      expect(projects.findBySlug('brand-new')).toBeUndefined();

      expect(
        await mcpCall('/mcp', star, 'project.use', { slug: 'brand-new', autocreate: true }),
      ).toEqual({ ok: true });
      expect(projects.findBySlug('brand-new')).toBeDefined();

      const row = persisted('set-autocreate');
      expect(row!.scope).toBe('projects');
    });
  });

  describe('the dashboard states what a set token reaches', () => {
    it('lists every member slug, and marks a memberless set apart from an unresolvable row', async () => {
      const jar = await loggedIn();
      // Submitted out of order, so the ascending assertion is about the render
      // rather than about the submission.
      const minted = await mint(jar, {
        name: 'list-set',
        projects: [gamma.slug, alpha.slug],
        access: 'write',
      });
      expect(minted.status).toBe(302);

      insertTokenRow({ name: 'list-empty-set', scope: 'projects' });
      insertTokenRow({ name: 'list-empty-set-revoked', scope: 'projects', revoked: true });
      // The legacy shape: a scope naming a project by slug with nothing bound.
      insertTokenRow({ name: 'list-unresolvable', scope: `project:${alpha.slug}` });

      const body = await (await get('/dashboard/tokens', jar)).text();

      const set = cellsOf(tokenRow(body, 'list-set'));
      const project = textOf(set[2]!);
      expect(project).toContain(alpha.slug);
      expect(project).toContain(gamma.slug);
      expect(project.indexOf(alpha.slug), 'members are not slug-ascending').toBeLessThan(
        project.indexOf(gamma.slug),
      );
      expect(set[2]).not.toContain(alpha.id);
      expect(set[2]).not.toContain(gamma.id);
      expect(set[5]).toContain('active');

      const empty = cellsOf(tokenRow(body, 'list-empty-set'));
      const unresolvable = cellsOf(tokenRow(body, 'list-unresolvable'));
      expect(textOf(empty[2]!)).toBe('—');
      expect(textOf(unresolvable[2]!)).toBe('—');
      expect(textOf(empty[5]!)).toBe('no projects');
      expect(textOf(unresolvable[5]!)).toBe('inert');
      expect(textOf(empty[5]!)).not.toBe(textOf(unresolvable[5]!));

      expect(textOf(cellsOf(tokenRow(body, 'list-empty-set-revoked'))[5]!)).toBe('revoked');
    });

    it('names the minted scope and every project in the one-time view', async () => {
      const jar = await loggedIn();
      const minted = await mint(jar, {
        name: 'one-shot-set',
        projects: [alpha.slug, gamma.slug],
        access: 'write',
      });
      expect(minted.status).toBe(302);

      const panel = /<div class="one-shot">[\s\S]*?<\/div>/.exec(minted.body)?.[0];
      expect(panel, 'no one-time-view panel').toBeTruthy();
      expect(panel).toContain(minted.plaintext!);
      expect(panel).toContain('<code>projects</code>');
      expect(panel).toContain(alpha.slug);
      expect(panel).toContain(gamma.slug);
      expect(panel, 'the panel reports a count instead of the members').not.toMatch(
        /\b2 projects\b/i,
      );
    });

    it('keeps a single selection on the single-project arm rather than a one-member set', async () => {
      const jar = await loggedIn();
      await mintPlaintext(jar, {
        name: 'single-selection',
        projects: [beta.slug],
        access: 'write',
      });

      const row = persisted('single-selection');
      expect(row!.scope).toBe(`project:${beta.id}`);
      expect(row!.projectId).toBe(beta.id);
      expect(tableExists('token_projects'), 'token_projects does not exist').toBe(true);
      expect(memberIds(row!.id), 'a single selection became a one-member set').toEqual([]);
    });

    it('answers a crafted submission naming one slug twice without a server error', async () => {
      const jar = await loggedIn();

      // The checkbox list cannot produce this; a crafted POST can, and the
      // composite primary key of `token_projects` answers a repeated slug with
      // SQLITE_CONSTRAINT_PRIMARYKEY — a 500 — if the selection is not deduped.
      const crafted = await mint(jar, {
        name: 'crafted-duplicate-slug',
        projects: [alpha.slug, alpha.slug],
        access: 'write',
      });
      expect(crafted.status, crafted.body.slice(0, 300)).toBe(302);
      const row = persisted('crafted-duplicate-slug');
      expect(row!.scope).toBe(`project:${alpha.id}`);
      expect(memberIds(row!.id), 'one slug twice became a set').toEqual([]);

      // Two DISTINCT slugs in the same test, so the collapse above is the
      // duplicate being dropped rather than the handler ignoring extra values.
      await mintPlaintext(jar, {
        name: 'crafted-duplicate-control',
        projects: [alpha.slug, gamma.slug],
        access: 'write',
      });
      const control = persisted('crafted-duplicate-control');
      expect(control!.scope).toBe('projects');
      expect(memberIds(control!.id)).toEqual([alpha.id, gamma.id].sort());
    });

    it('creates neither a token nor a membership row nor a project when one selected slug is invalid', async () => {
      const jar = await loggedIn();
      expect(tableExists('token_projects'), 'token_projects does not exist').toBe(true);
      const before = {
        tokens: countRows('tokens'),
        members: countRows('token_projects'),
        projects: countRows('projects'),
      };

      // The NEW slug leads: a selection the handler autocreates before it
      // reaches the invalid one. With an already-existing slug in that position
      // there is nothing to leak and the projects count cannot move.
      const fresh = 'never-minted-project';
      expect(
        new ProjectsService(createRepositories(server.dbHandle.db)).findBySlug(fresh),
      ).toBeUndefined();

      const res = await mint(jar, {
        name: 'invalid-member-slug',
        projects: [fresh, 'INVALID Slug!'],
        access: 'write',
      });

      expect(res.status).toBe(400);
      expect(res.body).toContain('flash error');
      expect(persisted('invalid-member-slug')).toBeUndefined();
      expect(countRows('tokens')).toBe(before.tokens);
      expect(countRows('token_projects')).toBe(before.members);
      expect(countRows('projects'), 'a refused mint autocreated a project').toBe(before.projects);
    });
  });
});
