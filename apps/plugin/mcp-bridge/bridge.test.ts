import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildEndpoint,
  projectDirectorySource,
  resolveProjectDirectory,
  resolveSlug,
} from './slug.mjs';

const bridge = fileURLToPath(new URL('./cli.mjs', import.meta.url));
const children: ChildProcessWithoutNullStreams[] = [];

async function startBridge(env: Record<string, string | undefined>) {
  const child = spawn(process.execPath, [bridge], {
    env: { ...process.env, ...env },
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
    env: { ...process.env, ...env },
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
    expect(resolveSlug(directory, env)).toEqual({ slug: 'from-file', issue: null });
    expect(buildEndpoint('https://example.test///', 'from-file')).toBe(
      'https://example.test/mcp/from-file',
    );
  });

  it('falls through invalid and missing file slugs', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'mcp-bridge-'));
    await writeFile(join(directory, '.rembric'), 'PROJECT_SLUG=not_valid\n');
    expect(resolveSlug(directory, { REMBRIC_PROJECT_SLUG: 'fallback' }).slug).toBe('fallback');

    const empty = await mkdtemp(join(tmpdir(), 'mcp-bridge-'));
    expect(resolveSlug(empty, { REMBRIC_PROJECT_SLUG: 'not_valid' })).toEqual({
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
      REMBRIC_PROJECT_SLUG: undefined,
    });
    client.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} });
    await client.nextLine();

    expect(paths).toContain('/mcp');
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
