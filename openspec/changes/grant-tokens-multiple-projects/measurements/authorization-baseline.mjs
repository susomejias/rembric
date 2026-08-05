/**
 * Pre-change authorization baseline for `grant-tokens-multiple-projects`.
 *
 * Usage (from the repo root):
 *   pnpm --filter @rembric/server exec tsx \
 *     openspec/changes/grant-tokens-multiple-projects/measurements/authorization-baseline.mjs
 *
 * The whole change rests on "no existing token's behaviour moves". That is only
 * provable against a matrix captured on the boundaries a real caller uses,
 * BEFORE any production line changes — so this script is committed and the
 * after-run (task 8.1) is a re-run of it, never a re-derivation.
 *
 * Instruments, kept distinct because they are not interchangeable:
 *   - minting goes through the dashboard form (POST /dashboard/tokens), so the
 *     persisted scope string is the one the real producer writes, not one a
 *     direct TokensService.create call composed;
 *   - the admin gate is POST /dashboard/login;
 *   - MCP goes through the SDK's StreamableHTTPClientTransport, because a direct
 *     handler call bypasses the tool's zod schema and proves nothing about it;
 *   - the HTTP surface is POST /api/<slug>/sessions.
 *
 * Every cell records the HTTP status AND the structured error code: a change
 * turning `forbidden` into `project_required` moves behaviour at an unchanged
 * status, and a status-only matrix would call that identical.
 */

import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Resolved through `apps/server/node_modules` rather than as a bare specifier:
// this file lives outside the package, and pnpm gives each package its own
// node_modules, so a bare import here cannot resolve.
import { Client } from '../../../../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js';
import { StreamableHTTPClientTransport } from '../../../../apps/server/node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.js';

import { createServer } from '../../../../apps/server/src/server/index.js';
import { FakeEmbedder } from '../../../../apps/server/src/test/embedder.js';

const ADMIN_TOKEN = 'baseline-admin-token';
const OUT_DIR = new URL('.', import.meta.url).pathname;

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = createNetServer();
    s.unref();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

/** Raw HTTP so the matrix records what the wire actually returned. */
function http(baseUrl, method, path, { headers = {}, body } = {}) {
  const url = new URL(path, baseUrl);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers },
      (res) => {
        let text = '';
        res.on('data', (c) => (text += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: text }));
      },
    );
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

const form = (obj) => new URLSearchParams(obj).toString();

/** `POST /api/<slug>/sessions` requires an id matching ^[A-Za-z0-9_-]{8,128}$. */
let sessionSeq = 0;
const sessionId = () => `baseline-session-${String(++sessionSeq).padStart(4, '0')}`;
const FORM_CT = { 'content-type': 'application/x-www-form-urlencoded' };

/**
 * The CSRF token is issued per form NAME, so one form's token is rejected by
 * another's handler. Match the action attribute exactly: the admin bootstrap
 * token is itself a `tokens` row, so `/dashboard/tokens` also renders a revoke
 * form whose action merely *contains* the create form's path and comes first.
 */
const csrfFrom = (html, action) => {
  const target = html
    .split('<form')
    .slice(1)
    .find((f) => f.includes(`action="${action}"`));
  return target ? (/name="csrf"\s+value="([^"]+)"/.exec(target)?.[1] ?? null) : null;
};

/**
 * One MCP probe. Returns `{ok}` on success, or the structured `code` the tool
 * put in its error body — which is the half a status-only matrix would lose.
 */
async function mcpCall(baseUrl, path, token, tool, args) {
  const client = new Client({ name: 'baseline', version: '0' }, { capabilities: {} });
  const transport = new StreamableHTTPClientTransport(new URL(path, baseUrl), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  try {
    await client.connect(transport);
  } catch (err) {
    // Refused at authentication, before any tool dispatch.
    const m = /\b(\d{3})\b/.exec(String(err));
    return {
      transport: 'refused',
      status: m ? Number(m[1]) : null,
      detail: String(err).slice(0, 120),
    };
  }
  try {
    const res = await client.callTool({ name: tool, arguments: args });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    if (!res.isError) return { ok: true };
    let code = null;
    try {
      code = JSON.parse(text).code ?? null;
    } catch {
      code = text.slice(0, 80);
    }
    return { ok: false, code };
  } catch (err) {
    return { ok: false, code: `threw: ${String(err).slice(0, 80)}` };
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'rembric-baseline-'));
  const port = await freePort();
  const server = await createServer(
    {
      REMBRIC_HOST: '127.0.0.1',
      REMBRIC_PORT: String(port),
      REMBRIC_DATA_DIR: dataDir,
      REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
    },
    { embedder: new FakeEmbedder() },
  );
  const baseUrl = `http://127.0.0.1:${port}`;

  try {
    // Admin dashboard session, so the operator forms are reachable.
    const login = await http(baseUrl, 'POST', '/dashboard/login', {
      headers: FORM_CT,
      body: form({ token: ADMIN_TOKEN }),
    });
    const cookie = (login.headers['set-cookie'] ?? []).map((c) => c.split(';')[0]).join('; ');
    if (!cookie) throw new Error(`admin login did not set a cookie (status ${login.status})`);

    // 1.1 — seed the two projects through the operator's own form, so nothing
    // in this script depends on a service shape it could get wrong.
    const projPage = await http(baseUrl, 'GET', '/dashboard/projects', { headers: { cookie } });
    const projCsrf = csrfFrom(projPage.body, '/dashboard/projects/create');
    if (!projCsrf) throw new Error('no CSRF token on the project-create form');
    for (const slug of ['alpha', 'home']) {
      const r = await http(baseUrl, 'POST', '/dashboard/projects/create', {
        headers: { ...FORM_CT, cookie },
        body: form({ slug, csrf: projCsrf }),
      });
      if (r.status !== 302) throw new Error(`project ${slug} not created: status ${r.status}`);
    }

    const page = await http(baseUrl, 'GET', '/dashboard/tokens', { headers: { cookie } });
    const csrf = csrfFrom(page.body, '/dashboard/tokens');
    if (!csrf) throw new Error('no CSRF token on the mint form');

    const SHAPES = [
      { label: '*', name: 'baseline-star', project: '', access: 'write' },
      { label: 'read:*', name: 'baseline-read-star', project: '', access: 'read' },
      {
        label: 'project:<alpha>',
        name: 'baseline-project-alpha',
        project: 'alpha',
        access: 'write',
      },
      {
        label: 'read:project:<alpha>',
        name: 'baseline-read-project-alpha',
        project: 'alpha',
        access: 'read',
      },
    ];

    const minted = [];
    for (const shape of SHAPES) {
      const res = await http(baseUrl, 'POST', '/dashboard/tokens', {
        headers: { ...FORM_CT, cookie },
        body: form({
          name: shape.name,
          project: shape.project,
          access: shape.access,
          csrf,
        }),
      });
      // The mint redirects and carries the plaintext in the Location query
      // string; the one-time view renders it from there.
      if (res.status !== 302 || !res.headers.location) {
        throw new Error(
          `mint failed for ${shape.label}: status ${res.status} body=${res.body.slice(0, 200)}`,
        );
      }
      const plaintext = new URL(res.headers.location, baseUrl).searchParams.get('created');
      if (!plaintext) {
        throw new Error(`no plaintext for ${shape.label} at ${res.headers.location}`);
      }
      minted.push({ ...shape, plaintext });
    }

    // 1.1 — the scope string the real producer persisted, read back from the
    // page the operator reads. Scraping the rendered list keeps the instrument
    // on the same side of the boundary as the mint that produced it.
    const listPage = await http(baseUrl, 'GET', '/dashboard/tokens', { headers: { cookie } });
    const persisted = [...listPage.body.matchAll(/<tr[\s\S]*?<\/tr>/g)]
      .map((m) => m[0])
      .filter((row) => row.includes('baseline-'))
      .map((row) => {
        const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((c) =>
          c[1].replace(/<[^>]+>/g, '').trim(),
        );
        return cells.slice(0, 4);
      });

    // ---- 1.2 / 1.3 the matrix ----
    const SURFACES = [
      [
        'login',
        (t) =>
          http(baseUrl, 'POST', '/dashboard/login', {
            headers: FORM_CT,
            body: form({ token: t }),
          }).then((r) => ({ status: r.status })),
      ],
      ['/mcp read', (t) => mcpCall(baseUrl, '/mcp', t, 'memory.search', { query: 'baseline' })],
      [
        '/mcp write',
        (t) =>
          mcpCall(baseUrl, '/mcp', t, 'memory.save', {
            type: 'project',
            title: 'baseline write probe',
            content: 'baseline write probe',
          }),
      ],
      [
        '/mcp/alpha read',
        (t) => mcpCall(baseUrl, '/mcp/alpha', t, 'memory.search', { query: 'baseline' }),
      ],
      [
        '/mcp/alpha write',
        (t) =>
          mcpCall(baseUrl, '/mcp/alpha', t, 'memory.save', {
            type: 'project',
            title: 'baseline write probe',
            content: 'baseline write probe',
          }),
      ],
      [
        '/mcp/home read',
        (t) => mcpCall(baseUrl, '/mcp/home', t, 'memory.search', { query: 'baseline' }),
      ],
      [
        '/mcp/home write',
        (t) =>
          mcpCall(baseUrl, '/mcp/home', t, 'memory.save', {
            type: 'project',
            title: 'baseline write probe',
            content: 'baseline write probe',
          }),
      ],
      [
        'POST /api/alpha/sessions',
        (t) =>
          http(baseUrl, 'POST', '/api/alpha/sessions', {
            headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
            body: JSON.stringify({ id: sessionId(), agent: 'baseline' }),
          }).then((r) => ({ status: r.status, code: safeCode(r.body) })),
      ],
      [
        'POST /api/home/sessions',
        (t) =>
          http(baseUrl, 'POST', '/api/home/sessions', {
            headers: { authorization: `Bearer ${t}`, 'content-type': 'application/json' },
            body: JSON.stringify({ id: sessionId(), agent: 'baseline' }),
          }).then((r) => ({ status: r.status, code: safeCode(r.body) })),
      ],
    ];

    const ARMS = [
      ...minted.map((m) => ({ label: m.label, token: m.plaintext })),
      { label: 'invalid bearer', token: 'rmb_not-a-real-token' },
    ];

    const matrix = {};
    for (const arm of ARMS) {
      matrix[arm.label] = {};
      for (const [name, probe] of SURFACES) {
        matrix[arm.label][name] = await probe(arm.token);
      }
    }

    // A control that must pass before the matrix is worth anything: the admin
    // `*` token has to SUCCEED on every write and on both session posts. Its
    // refusal would mean the probe is malformed, and a malformed write probe is
    // indistinguishable from a real denial — every write cell would read
    // "denied" and an after-run would diff clean while proving nothing.
    const admin = matrix['*'];
    for (const surface of ['/mcp write', '/mcp/alpha write', '/mcp/home write']) {
      if (admin[surface]?.ok !== true) {
        throw new Error(
          `probe malformed, not a denial: '*' was refused on ${surface} — ${JSON.stringify(admin[surface])}`,
        );
      }
    }
    for (const surface of ['POST /api/alpha/sessions', 'POST /api/home/sessions']) {
      if (![200, 201].includes(admin[surface]?.status)) {
        throw new Error(
          `probe malformed, not a denial: '*' was refused on ${surface} — ${JSON.stringify(admin[surface])}`,
        );
      }
    }

    // ---- 1.4 non-vacuity: an "identical" diff over an all-refused matrix proves nothing ----
    const isSuccess = (cell) =>
      cell.ok === true || cell.status === 200 || cell.status === 302 || cell.status === 201;
    const successCells = Object.values(matrix)
      .flatMap((row) => Object.values(row))
      .filter(isSuccess).length;
    const totalCells = ARMS.length * SURFACES.length;

    const out = {
      capturedAt: new Date().toISOString(),
      baseCommit: process.env.BASELINE_BASE_COMMIT ?? null,
      persisted,
      matrix,
      nonVacuity: { successCells, totalCells },
    };
    writeFileSync(
      join(OUT_DIR, 'authorization-baseline.json'),
      JSON.stringify(out, null, 2) + '\n',
    );

    console.log(JSON.stringify({ persisted, nonVacuity: out.nonVacuity }, null, 2));
    for (const [arm, row] of Object.entries(matrix)) {
      console.log(`\n${arm}`);
      for (const [surface, cell] of Object.entries(row)) {
        console.log(`  ${surface.padEnd(26)} ${JSON.stringify(cell)}`);
      }
    }
    if (successCells === 0) throw new Error('baseline is vacuous: no cell succeeded');
  } finally {
    await server.shutdown();
    rmSync(dataDir, { recursive: true, force: true });
  }
}

const safeCode = (body) => {
  try {
    return JSON.parse(body).code ?? null;
  } catch {
    return null;
  }
};

await main();
