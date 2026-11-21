import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { processStartToken, publishHostBinding } from './rembric-host-binding.mjs';
import { buildEndpoint, resolveSlug } from './rembric-project.mjs';
import { projectDirectorySource, resolveProjectDirectory } from './slug.mjs';

// A git hook exports GIT_DIR, which would point the git calls in these tests at the real repository.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

const bridge = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const children: ChildProcessWithoutNullStreams[] = [];

// The test runner's PWD is this repository; a bridge started there would resolve its .rembric.
const neutralDir = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-bridge-neutral-')));
// The bridge reads host bindings under its home; the real one may hold an ancestor's binding.
const neutralHome = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-bridge-home-')));
afterAll(() => {
  rmSync(neutralDir, { recursive: true, force: true });
  rmSync(neutralHome, { recursive: true, force: true });
});

async function startBridge(
  env: Record<string, string | undefined>,
  launch: { command: string; args: string[] } = { command: process.execPath, args: [bridge] },
) {
  const child = spawn(launch.command, launch.args, {
    cwd: neutralDir,
    env: { ...process.env, PWD: neutralDir, HOME: neutralHome, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  child.stdout.on('data', () => {
    while (true) {
      const newline = stdout.indexOf('\n');
      if (newline < 0) break;
      lines.push(stdout.slice(0, newline));
      stdout = stdout.slice(newline + 1);
      wake?.();
      wake = undefined;
    }
  });
  return {
    child,
    get stderr() {
      return stderr;
    },
    async nextLine() {
      while (!lines.length) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      return JSON.parse(lines.shift() as string) as Record<string, unknown>;
    },
    send(message: Record<string, unknown>) {
      child.stdin.write(`${JSON.stringify(message)}\n`);
    },
    sendRaw(raw: string) {
      child.stdin.write(`${raw}\n`);
    },
  };
}

async function runBridgeProcess(env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, [bridge], {
    cwd: neutralDir,
    env: { ...process.env, PWD: neutralDir, HOME: neutralHome, ...env },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [code] = (await once(child, 'exit')) as [number | null, string | null];
  return { code, stderr };
}

async function listen(server: ReturnType<typeof createServer>) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode !== null || child.signalCode !== null) continue;
    child.kill('SIGTERM');
    await once(child, 'exit').catch(() => {});
  }
});

describe('slug resolution', () => {
  it('uses the directory cascade and the file slug before the environment fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-bridge-'));
    await writeFile(join(directory, '.rembric'), 'PROJECT_SLUG=from-file\n');
    const env = { CLAUDE_PROJECT_DIR: '', PWD: directory, REMBRIC_PROJECT_SLUG: 'from-env' };

    expect(resolveProjectDirectory(env, '/wrong')).toBe(directory);
    expect(projectDirectorySource(env)).toBe('PWD');
    expect(resolveSlug(directory, env)).toMatchObject({ slug: 'from-file', issue: null });
    expect(buildEndpoint('https://example.test///', 'from-file')).toBe(
      'https://example.test/mcp/from-file',
    );
  });

  it('falls through invalid and missing file slugs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-bridge-'));
    await writeFile(join(directory, '.rembric'), 'PROJECT_SLUG=not_valid\n');
    expect(resolveSlug(directory, { REMBRIC_PROJECT_SLUG: 'fallback' }).slug).toBe('fallback');

    const empty = await mkdtemp(join(tmpdir(), 'mcp-bridge-'));
    expect(resolveSlug(empty, { REMBRIC_PROJECT_SLUG: 'not_valid' })).toMatchObject({
      slug: null,
      issue: 'not_valid in REMBRIC_PROJECT_SLUG is invalid',
    });
    expect(buildEndpoint('http://example.test', null)).toBe('http://example.test/mcp');
  });

  it('reports an invalid file slug while using the valid environment fallback', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-bridge-'));
    await writeFile(join(directory, '.rembric'), 'PROJECT_SLUG=not_valid\n');
    const paths: string[] = [];
    const server = createServer(async (request, response) => {
      paths.push(request.url ?? '');
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number };
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
      CLAUDE_PROJECT_DIR: directory,
      REMBRIC_PROJECT_SLUG: 'fallback',
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();

    expect(paths).toContain('/mcp/fallback');
    expect(client.stderr).toContain(
      `PROJECT_SLUG="not_valid" in ${join(directory, '.rembric')} is invalid`,
    );
    client.child.stdin.end();
    server.close();
  });

  it('reports a missing slug and uses the path-less endpoint', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-bridge-'));
    const paths: string[] = [];
    const fingerprintHeaders: unknown[] = [];
    const server = createServer(async (request, response) => {
      paths.push(request.url ?? '');
      if (request.url === '/mcp') {
        fingerprintHeaders.push(request.headers['x-rembric-repo-fingerprint']);
      }
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number };
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
      CLAUDE_PROJECT_DIR: directory,
      REMBRIC_PROJECT_SLUG: undefined,
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();

    expect(paths).toContain('/mcp');
    expect(paths).not.toContain('/api/repositories/resolve');
    expect(fingerprintHeaders).toEqual([undefined]);
    const fallback = client.stderr
      .split('\n')
      .filter((line) => line.includes(`No .rembric in ${directory}`));
    expect(fallback).toHaveLength(1);
    expect(fallback[0]).toContain('.rembric file containing PROJECT_SLUG=<slug>');
    expect(fallback[0]).toContain('REMBRIC_PROJECT_SLUG');
    expect(fallback[0]).toContain("server's default project");
    client.child.stdin.end();
    server.close();
  });
});

describe('stdio to HTTP transport', () => {
  it.each(['REMBRIC_SERVER_URL', 'REMBRIC_API_TOKEN'])(
    'fails fast when %s is missing without making an HTTP request',
    async (missing) => {
      let requests = 0;
      const server = createServer(() => {
        requests += 1;
      });
      const base = await listen(server);
      const result = await runBridgeProcess({
        REMBRIC_SERVER_URL: missing === 'REMBRIC_SERVER_URL' ? undefined : base,
        REMBRIC_API_TOKEN: missing === 'REMBRIC_API_TOKEN' ? undefined : 'secret-token',
      });

      expect(result.code).not.toBe(0);
      expect(result.stderr).toBe(`[rembric-bridge] Missing ${missing}. Configure the plugin.\n`);
      expect(requests).toBe(0);
      server.close();
    },
  );

  it('passes initialize through verbatim and echoes the session id a sessionful server assigned', async () => {
    const requests: {
      path: string;
      body: string;
      session: string | undefined;
      authorization: string | undefined;
    }[] = [];
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      requests.push({
        path: request.url ?? '',
        body,
        session: request.headers['mcp-session-id'] as string | undefined,
        authorization: request.headers.authorization,
      });
      if (request.url === '/healthz') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      const message = JSON.parse(body) as { id?: number; method?: string };
      if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', 's1');
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: '2025-06-18' },
          }),
        );
        return;
      }
      if (message.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: message.id,
          result: { content: [{ type: 'text', text: 'ok' }] },
        }),
      );
    });
    const base = await listen(server);
    const project = await mkdtemp(join(tmpdir(), 'mcp-bridge-'));
    await writeFile(join(project, '.rembric'), 'PROJECT_SLUG=demo\n');
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
      CLAUDE_PROJECT_DIR: project,
      PWD: '',
    });

    const initializeRaw =
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"claude-code","version":"9.9.9"}}}';
    client.sendRaw(initializeRaw);
    expect(await client.nextLine()).toMatchObject({
      id: 1,
      result: { protocolVersion: '2025-06-18' },
    });
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'memory.get_batch', arguments: {} },
    });
    expect(await client.nextLine()).toMatchObject({
      id: 2,
      result: { content: [{ text: 'ok' }] },
    });

    expect(requests.filter((request) => request.path === '/healthz')).toHaveLength(1);
    expect(requests.every((request) => request.authorization === 'Bearer secret-token')).toBe(true);
    const mcpRequests = requests.filter((request) => request.path.startsWith('/mcp/demo'));
    expect(mcpRequests[0].body).toBe(initializeRaw);
    expect(mcpRequests.map((request) => JSON.parse(request.body).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(mcpRequests.map((request) => request.session)).toEqual([undefined, 's1', 's1']);
    expect(client.stderr).not.toContain('secret-token');
    if (existsSync('/proc')) {
      if (client.child.pid === undefined) throw new Error('bridge subprocess has no pid');
      expect(readFileSync(`/proc/${client.child.pid}/cmdline`, 'utf8')).not.toContain(
        'secret-token',
      );
    }
    expect(requests.every((request) => request.path !== '/.well-known')).toBe(true);

    client.child.stdin.end();
    server.close();
  });

  it('takes the session id only from initialize, and a repeated initialize sends none', async () => {
    const requests: { method?: string; session: string | undefined }[] = [];
    let initializeCount = 0;
    const server = createServer(async (request, response) => {
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method?: string;
      };
      requests.push({
        method: message.method,
        session: request.headers['mcp-session-id'] as string | undefined,
      });
      if (message.method === 'initialize') {
        initializeCount += 1;
        response.setHeader('mcp-session-id', `s${initializeCount}`);
      } else {
        response.setHeader('mcp-session-id', 'not-assigned-by-initialize');
      }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} });
    await client.nextLine();

    expect(requests).toEqual([
      { method: 'initialize', session: undefined },
      { method: 'initialize', session: undefined },
      { method: 'tools/call', session: 's2' },
      { method: 'tools/call', session: 's2' },
    ]);
    client.child.stdin.end();
    server.close();
  });

  it('sends no session id to a server that assigns none', async () => {
    const requests: { method?: string; session: string | undefined }[] = [];
    const server = createServer(async (request, response) => {
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.31.0' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method?: string;
      };
      requests.push({
        method: message.method,
        session: request.headers['mcp-session-id'] as string | undefined,
      });
      if (message.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
        return;
      }
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } }));
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
    expect(await client.nextLine()).toMatchObject({ id: 2, result: { ok: true } });

    expect(requests).toEqual([
      { method: 'initialize', session: undefined },
      { method: 'notifications/initialized', session: undefined },
      { method: 'tools/call', session: undefined },
    ]);
    client.child.stdin.end();
    server.close();
  });

  it('propagates a 404 from an older server unchanged, without re-initializing or retrying', async () => {
    const methods: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.20.0' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method?: string;
      };
      methods.push(message.method ?? '');
      if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', 's1');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      } else if (message.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
      } else {
        response.statusCode = 404;
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            error: { code: -32001, message: 'Session not found' },
          }),
        );
      }
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });

    expect(await client.nextLine()).toEqual({
      jsonrpc: '2.0',
      id: 2,
      error: { code: -32001, message: 'Session not found' },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    expect(client.stderr).toContain('server version 0.20.0 is older than this plugin expects');
    client.child.stdin.end();
    server.close();
  });

  it('does not relay a server-initiated request to the host', async () => {
    const posted: Record<string, unknown>[] = [];
    const server = createServer(async (request, response) => {
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method?: string;
      };
      posted.push(message);
      if (message.method === 'initialize') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      } else if (message.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
      } else {
        response.setHeader('content-type', 'text/event-stream');
        response.write(
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: 'srv-1', method: 'roots/list', params: {} })}\n\n`,
        );
        response.end(
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { content: [{ type: 'text', text: 'done' }] } })}\n\n`,
        );
      }
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} });

    expect(await client.nextLine()).toMatchObject({
      id: 3,
      result: { content: [{ text: 'done' }] },
    });
    expect(posted.map((message) => message.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    client.child.stdin.end();
    server.close();
  });

  it.each([400, 401])('propagates %i without retrying or re-initializing', async (status) => {
    const methods: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method?: string;
      };
      methods.push(message.method ?? '');
      if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', 's1');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      } else if (message.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
      } else {
        response.statusCode = status;
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: status } }));
      }
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
    expect(await client.nextLine()).toMatchObject({ id: 2, error: { code: status } });
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    client.child.stdin.end();
    server.close();
  });

  it('uses the negotiated protocol version for later requests', async () => {
    const versions: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      versions.push(String(request.headers['mcp-protocol-version']));
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method?: string;
      };
      if (message.method === 'initialize') {
        response.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: { protocolVersion: '2025-11-25' },
          }),
        );
      } else if (message.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
      } else {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { ok: true } }));
      }
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
    expect(await client.nextLine()).toMatchObject({ id: 2, result: { ok: true } });
    expect(versions).toEqual(['2025-06-18', '2025-11-25', '2025-11-25']);
    client.child.stdin.end();
    server.close();
  });

  it('lets cancelled notifications reach a server while a tool SSE stream is open', async () => {
    let cancellationSeen = false;
    let streamResponse: ServerResponse | undefined;
    const server = createServer(async (request, response) => {
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method?: string;
      };
      if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', 's1');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      } else if (message.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
      } else if (message.method === 'notifications/cancelled') {
        cancellationSeen = true;
        response.statusCode = 202;
        response.end();
        streamResponse?.end(
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, result: { cancelled: true } })}\n\n`,
        );
      } else {
        streamResponse = response;
        response.setHeader('content-type', 'text/event-stream');
        response.write(': open\n\n');
      }
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
    await new Promise((resolve) => setTimeout(resolve, 20));
    client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
    expect(await client.nextLine()).toMatchObject({ id: 2, result: { cancelled: true } });
    expect(cancellationSeen).toBe(true);
    client.child.stdin.end();
    server.close();
  });

  it('exits when stdin closes during a held-open SSE response', async () => {
    let toolRequestSeen: () => void = () => {};
    const toolRequest = new Promise<void>((resolve) => {
      toolRequestSeen = resolve;
    });
    const server = createServer(async (request, response) => {
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method?: string;
      };
      if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', 's1');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      } else if (message.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
      } else {
        toolRequestSeen();
        response.setHeader('content-type', 'text/event-stream');
      }
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
    await toolRequest;
    client.child.stdin.end();
    const [code] = (await Promise.race([
      once(client.child, 'exit') as Promise<[number | null, string | null]>,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('bridge did not exit')), 500),
      ),
    ])) as [number | null, string | null];
    expect(code).toBe(0);
    server.close();
  });

  it('keeps concurrent request IDs independent', async () => {
    const server = createServer(async (request, response) => {
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method?: string;
      };
      if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', 's1');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      } else if (message.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
      } else {
        setTimeout(
          () =>
            response.end(
              JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { id: message.id } }),
            ),
          message.id === 2 ? 60 : 5,
        );
      }
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} });
    // Concurrent requests may reach the server in any order; the bridge guarantees response correlation, not arrival order.
    const responses = [await client.nextLine(), await client.nextLine()];
    const byId = new Map(responses.map((response) => [response.id, response] as const));
    expect([...byId.keys()].sort((left, right) => Number(left) - Number(right))).toEqual([2, 3]);
    expect(byId.get(2)).toMatchObject({ id: 2, result: { id: 2 } });
    expect(byId.get(3)).toMatchObject({ id: 3, result: { id: 3 } });
    client.child.stdin.end();
    server.close();
  });

  it('correlates a null-id HTTP failure without re-initializing', async () => {
    const methods: string[] = [];
    const server = createServer(async (request, response) => {
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: null;
        method?: string;
      };
      methods.push(message.method ?? '');
      if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', 's1');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      } else if (message.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
      } else {
        response.statusCode = 404;
        response.end('unknown session');
      }
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: null, method: 'tools/call', params: {} });
    expect(await client.nextLine()).toMatchObject({
      id: null,
      error: { code: -32000, message: expect.stringContaining('HTTP 404') },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(methods).toEqual(['initialize', 'notifications/initialized', 'tools/call']);
    client.child.stdin.end();
    server.close();
  });

  it.each([401, 429])('exits promptly for a non-RPC notification response (%i)', async (status) => {
    const server = createServer((request, response) => {
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      response.statusCode = status;
      response.end('server rejected the notification');
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: {} });
    expect(await client.nextLine()).toMatchObject({ id: 1, error: { code: -32000 } });
    client.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 9 } });
    const [code] = (await once(client.child, 'exit')) as [number | null, string | null];
    expect(code).not.toBe(0);
    server.close();
  });

  it('correlates a fetch refusal and an SSE disconnect', async () => {
    let closeAfterSse = false;
    const server = createServer(async (request, response) => {
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method?: string;
      };
      if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', 's1');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      } else if (message.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
      } else if (message.id === 2) {
        response.setHeader('content-type', 'text/event-stream');
        closeAfterSse = true;
        response.destroy();
      } else {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      }
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
    expect(await client.nextLine()).toMatchObject({ id: 2, error: { code: -32000 } });
    expect(closeAfterSse).toBe(true);
    server.close();
    await new Promise<void>((resolve) => server.once('close', resolve));
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} });
    expect(await client.nextLine()).toMatchObject({ id: 3, error: { code: -32000 } });
    client.send({ jsonrpc: '2.0', method: 'notifications/cancelled' });
    const [code] = (await once(client.child, 'exit')) as [number | null, string | null];
    expect(code).not.toBe(0);
  });
});

describe('host-declared session header', () => {
  async function recordingServer() {
    const requests: { method: string; id: number | undefined; session: string | undefined }[] = [];
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      if (request.url === '/healthz') {
        response.statusCode = 404;
        response.end();
        return;
      }
      const message = JSON.parse(Buffer.concat(chunks).toString()) as {
        id?: number;
        method: string;
      };
      requests.push({
        method: message.method,
        id: message.id,
        session: request.headers['x-rembric-session'] as string | undefined,
      });
      if (message.id === undefined) {
        response.statusCode = 202;
        response.end();
        return;
      }
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
    });
    return { server, base: await listen(server), requests };
  }

  async function exchange(
    home: string,
    base: string,
    publishBetween?: () => void,
    launch?: { command: string; args: string[] },
  ) {
    const client = await startBridge(
      {
        REMBRIC_SERVER_URL: base,
        REMBRIC_API_TOKEN: 'secret-token',
        REMBRIC_PROJECT_SLUG: 'demo',
        HOME: home,
      },
      launch,
    );
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'a' } });
    await client.nextLine();
    publishBetween?.();
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'b' } });
    await client.nextLine();
    client.child.stdin.end();
    await once(client.child, 'exit');
  }

  function scratchHome() {
    return realpathSync(mkdtempSync(join(tmpdir(), 'mcp-bridge-host-')));
  }

  it('sends the binding of its parent process on every request, initialize included', async () => {
    const home = scratchHome();
    expect(publishHostBinding({ pid: process.pid, sessionId: 'host-session-1', home })).toBe(true);
    const { server, base, requests } = await recordingServer();
    await exchange(home, base);
    expect(requests.map((request) => request.method).sort()).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'tools/call',
    ]);
    expect(requests.map((request) => request.session)).toEqual(Array(4).fill('host-session-1'));
    server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('picks up a re-published binding on the next request without restarting', async () => {
    const home = scratchHome();
    publishHostBinding({ pid: process.pid, sessionId: 'host-session-1', home });
    const { server, base, requests } = await recordingServer();
    await exchange(home, base, () =>
      publishHostBinding({ pid: process.pid, sessionId: 'host-session-2', home }),
    );
    const byId = (id: number) => requests.find((request) => request.id === id)?.session;
    expect([byId(1), byId(2), byId(3)]).toEqual([
      'host-session-1',
      'host-session-1',
      'host-session-2',
    ]);
    server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('omits the header when its host is not bound, or the binding names another process start', async () => {
    const home = scratchHome();
    const { server, base, requests } = await recordingServer();
    await exchange(home, base);
    expect(processStartToken(process.pid)).not.toBeNull();
    publishHostBinding({
      pid: process.pid,
      sessionId: 'host-session-1',
      start: 'Thu Jan 1 00:00:00 1970',
      home,
    });
    await exchange(home, base);
    expect(requests).toHaveLength(8);
    expect(requests.every((request) => request.session === undefined)).toBe(true);
    server.close();
    rmSync(home, { recursive: true, force: true });
  });
  it('skips a shell launcher between itself and its host', async () => {
    const home = scratchHome();
    publishHostBinding({ pid: process.pid, sessionId: 'host-session-1', home });
    const { server, base, requests } = await recordingServer();
    await exchange(home, base, undefined, {
      command: '/bin/sh',
      args: ['-c', '"$0" "$1"; exit $?', process.execPath, bridge],
    });
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.session === 'host-session-1')).toBe(true);
    server.close();
    rmSync(home, { recursive: true, force: true });
  });

  it('omits the header when its own host is unbound, even though an outer host is bound', async () => {
    const home = scratchHome();
    publishHostBinding({ pid: process.pid, sessionId: 'host-session-1', home });
    const { server, base, requests } = await recordingServer();
    await exchange(home, base, undefined, {
      command: process.execPath,
      args: [
        '-e',
        "const c = require('node:child_process').spawn(process.argv[1], [process.argv[2]], { stdio: 'inherit' }); c.on('exit', (code) => process.exit(code ?? 1));",
        process.execPath,
        bridge,
      ],
    });
    expect(requests).toHaveLength(4);
    expect(requests.every((request) => request.session === undefined)).toBe(true);
    server.close();
    rmSync(home, { recursive: true, force: true });
  });
});

describe('project resolution inside a git work tree', () => {
  const GIT_ENV = {
    ...process.env,
    GIT_AUTHOR_NAME: 'Fixture Author',
    GIT_AUTHOR_EMAIL: 'author@example.test',
    GIT_COMMITTER_NAME: 'Fixture Committer',
    GIT_COMMITTER_EMAIL: 'committer@example.test',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
  };
  const scratch = realpathSync(mkdtempSync(join(tmpdir(), 'mcp-bridge-git-')));
  let counter = 0;

  afterAll(() => rmSync(scratch, { recursive: true, force: true }));

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
  }

  function repository(remote?: string) {
    counter += 1;
    const repo = join(scratch, `repo-${counter}`);
    mkdirSync(repo, { recursive: true });
    git(repo, 'init', '-q', '-b', 'main');
    writeFileSync(join(repo, 'a.txt'), 'a\n');
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'root');
    if (remote) git(repo, 'remote', 'add', 'origin', remote);
    return { repo, root: git(repo, 'rev-parse', 'HEAD') };
  }

  type Seen = { path: string; fingerprint: string | undefined; raw: string };

  async function stub(reply: { status: number; body: unknown } | 'hang') {
    const seen: Seen[] = [];
    const server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString();
      seen.push({
        path: request.url ?? '',
        fingerprint: request.headers['x-rembric-repo-fingerprint'] as string | undefined,
        raw: `${JSON.stringify(request.headers)}${raw}`,
      });
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.31.0' }));
        return;
      }
      if (request.url === '/api/repositories/resolve') {
        if (reply === 'hang') return;
        response.statusCode = reply.status;
        response.setHeader('content-type', 'application/json');
        response.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
        return;
      }
      const message = JSON.parse(raw) as { id?: number };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
    });
    const base = await listen(server);
    return { base, seen, server };
  }

  const mcpOf = (seen: Seen[]) =>
    seen.filter((s) => s.path === '/mcp' || s.path.startsWith('/mcp/'));

  async function connected(base: string, projectDir: string, extra: Record<string, string> = {}) {
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
      CLAUDE_PROJECT_DIR: projectDir,
      REMBRIC_PROJECT_SLUG: undefined,
      ...extra,
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    await client.nextLine();
    return client;
  }

  it('a bound fingerprint path-scopes the URL and every forwarded request carries the header', async () => {
    const { repo, root } = repository();
    const { base, seen, server } = await stub({
      status: 200,
      body: { ok: true, outcome: 'bound', slug: 'shop' },
    });
    const client = await connected(base, repo);

    const mcp = mcpOf(seen);
    expect(mcp).toHaveLength(2);
    expect(mcp.every((s) => s.path === '/mcp/shop' && s.fingerprint === root)).toBe(true);
    expect(client.stderr).toContain(`url=${base}/mcp/shop`);
    client.child.stdin.end();
    server.close();
  });

  it('an unbound fingerprint connects path-less with the header and says the repository is unbound', async () => {
    const { repo, root } = repository();
    const { base, seen, server } = await stub({
      status: 200,
      body: { ok: true, outcome: 'unbound', reason: 'not_bound' },
    });
    const client = await connected(base, repo);

    const mcp = mcpOf(seen);
    expect(mcp).toHaveLength(2);
    expect(mcp.every((s) => s.path === '/mcp' && s.fingerprint === root)).toBe(true);
    expect(client.stderr).toContain('not bound to a project');
    expect(client.stderr).not.toContain("server's default project");
    client.child.stdin.end();
    server.close();
  });

  it.each([
    ['a server without the resolve endpoint', { status: 404, body: 'Not Found' }],
    [
      'an ambiguous repository',
      { status: 409, body: { ok: false, code: 'repository_ambiguous', slugs: ['a', 'b'] } },
    ],
    ['a resolve endpoint that never answers', 'hang' as const],
  ])('%s gets no connection and one diagnostic', async (_label, reply) => {
    const { repo } = repository();
    const { base, seen, server } = await stub(reply);
    const result = await runBridgeProcess({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
      CLAUDE_PROJECT_DIR: repo,
      REMBRIC_PROJECT_SLUG: undefined,
      REMBRIC_RESOLVE_TIMEOUT_MS: '200',
    });

    expect(result.code).not.toBe(0);
    expect(mcpOf(seen)).toEqual([]);
    const lines = result.stderr.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('.rembric');
    if (reply !== 'hang' && reply.status === 404)
      expect(lines[0]).toContain('update the Rembric server');
    server.closeAllConnections();
    server.close();
  });

  it('the nearest .rembric up to the checkout root path-scopes a subdirectory, header included', async () => {
    const { repo, root } = repository();
    writeFileSync(join(repo, '.rembric'), 'PROJECT_SLUG=shop\n');
    mkdirSync(join(repo, 'packages', 'api'), { recursive: true });
    const { base, seen, server } = await stub({
      status: 200,
      body: { ok: true, outcome: 'explicit', slug: 'shop', conflict: null },
    });
    const client = await connected(base, join(repo, 'packages', 'api'));

    const mcp = mcpOf(seen);
    expect(mcp.every((s) => s.path === '/mcp/shop' && s.fingerprint === root)).toBe(true);
    client.child.stdin.end();
    server.close();
  });

  it('a credential in a remote reaches neither the server nor stderr', async () => {
    const { repo } = repository('https://user:secret@git.example.com/acme/shop.git');
    const { base, seen, server } = await stub({
      status: 200,
      body: { ok: true, outcome: 'unbound', reason: 'not_bound' },
    });
    const client = await connected(base, repo);

    expect(seen.find((s) => s.path === '/api/repositories/resolve')?.raw).toContain(
      'git.example.com/acme/shop',
    );
    expect(seen.map((s) => s.raw).join('\n')).not.toContain('secret@');
    expect(seen.map((s) => s.raw).join('\n')).not.toContain(':secret');
    expect(client.stderr).not.toContain('secret');
    client.child.stdin.end();
    server.close();
  });
});
