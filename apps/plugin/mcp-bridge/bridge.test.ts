import { once } from 'node:events';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
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
    expect(client.stderr).toContain(`No .rembric in ${directory}`);
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

  it('passes initialize through and recovers exactly once from a terminated session', async () => {
    const requests: {
      path: string;
      body: string;
      session: string | undefined;
      authorization: string | undefined;
    }[] = [];
    let session = 's1';
    let initializeCount = 0;
    let toolAttempts = 0;
    const server = createServer(async (request: IncomingMessage, response: ServerResponse) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString();
      requests.push({
        path: request.url ?? '',
        body,
        session: request.headers['mcp-session-id'],
        authorization: request.headers.authorization,
      });
      if (request.url === '/healthz') {
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      const message = JSON.parse(body) as { id?: number; method?: string };
      if (message.method === 'initialize') {
        initializeCount += 1;
        session = initializeCount === 1 ? 's1' : 's2';
        response.setHeader('mcp-session-id', session);
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
      toolAttempts += 1;
      if (toolAttempts === 1) {
        response.statusCode = 404;
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001 } }));
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
      params: { name: 'memory.get', arguments: {} },
    });
    expect(await client.nextLine()).toMatchObject({ id: 2, result: { content: [{ text: 'ok' }] } });

    expect(requests.filter((request) => request.path === '/healthz')).toHaveLength(1);
    expect(requests.every((request) => request.authorization === 'Bearer secret-token')).toBe(true);
    expect(requests.filter((request) => request.path?.startsWith('/mcp/demo'))).toHaveLength(6);
    const mcpRequests = requests.filter((request) => request.path?.startsWith('/mcp/demo'));
    expect(mcpRequests[0].body).toBe(initializeRaw);
    expect(mcpRequests[3].body).toBe(initializeRaw);
    expect(JSON.parse(mcpRequests[0].body).params.clientInfo).toEqual({
      name: 'claude-code',
      version: '9.9.9',
    });
    expect(mcpRequests.map((request) => JSON.parse(request.body).method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(mcpRequests.map((request) => request.session)).toEqual([
      undefined,
      's1',
      's1',
      undefined,
      's2',
      's2',
    ]);
    expect(client.stderr).not.toContain('secret-token');
    if (client.child.pid === undefined) throw new Error('bridge subprocess has no pid');
    expect(readFileSync(`/proc/${client.child.pid}/cmdline`, 'utf8')).not.toContain('secret-token');
    expect(requests.every((request) => request.path !== '/.well-known')).toBe(true);

    client.child.stdin.end();
    server.close();
  });

  it('propagates a second 404 without a third attempt or second recovery', async () => {
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
        response.setHeader(
          'mcp-session-id',
          `s${methods.filter((method) => method === 'initialize').length}`,
        );
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      } else if (message.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
      } else {
        response.statusCode = 404;
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001 } }));
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
      error: { code: -32001 },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(methods).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    expect(methods.filter((method) => method === 'initialize')).toHaveLength(2);
    expect(methods.filter((method) => method === 'tools/call')).toHaveLength(2);
    client.child.stdin.end();
    server.close();
  });

  it('does not recover a 404 received by initialize', async () => {
    let mcpRequests = 0;
    const server = createServer(async (request, response) => {
      if (request.url === '/healthz') {
        response.end(JSON.stringify({ version: '0.28.2' }));
        return;
      }
      mcpRequests += 1;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const message = JSON.parse(Buffer.concat(chunks).toString()) as { id?: number };
      response.statusCode = 404;
      response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001 } }));
    });
    const base = await listen(server);
    const client = await startBridge({
      REMBRIC_SERVER_URL: base,
      REMBRIC_API_TOKEN: 'secret-token',
    });
    client.sendRaw(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"clientInfo":{"name":"host","version":"1"}}}',
    );

    expect(await client.nextLine()).toMatchObject({ id: 1, error: { code: -32001 } });
    expect(mcpRequests).toBe(1);
    client.child.stdin.end();
    server.close();
  });

  it('relays a server-initiated roots request and posts the host response', async () => {
    let streamResponse: ServerResponse | undefined;
    let rootAnswer: Record<string, unknown> | undefined;
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
      if (!message.method && message.id === 2) {
        rootAnswer = message as Record<string, unknown>;
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
        streamResponse?.end(
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'done' }] } })}\n\n`,
        );
      } else if (message.method === 'initialize') {
        response.setHeader('mcp-session-id', 's1');
        response.setHeader('content-type', 'application/json');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      } else if (message.method === 'notifications/initialized') {
        response.statusCode = 202;
        response.end();
      } else if (message.method === 'roots/list') {
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      } else {
        streamResponse = response;
        response.setHeader('content-type', 'text/event-stream');
        response.write(
          `data: ${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'roots/list', params: {} })}\n\n`,
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
    expect(await client.nextLine()).toMatchObject({ id: 2, method: 'roots/list' });
    client.send({ jsonrpc: '2.0', id: 2, result: { roots: [{ uri: 'file:///project' }] } });
    expect(await client.nextLine()).toMatchObject({
      id: 3,
      result: { content: [{ text: 'done' }] },
    });
    expect(rootAnswer).toMatchObject({ id: 2, result: { roots: [{ uri: 'file:///project' }] } });
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

  it('uses the negotiated protocol version for recovery and later requests', async () => {
    const versions: string[] = [];
    let initializeCount = 0;
    let toolCount = 0;
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
        initializeCount += 1;
        response.setHeader('mcp-session-id', `s${initializeCount}`);
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
      } else if (message.method === 'tools/call' && toolCount++ === 0) {
        response.statusCode = 404;
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001 } }));
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
    expect(versions).toEqual([
      '2025-06-18',
      '2025-11-25',
      '2025-11-25',
      '2025-11-25',
      '2025-11-25',
      '2025-11-25',
    ]);
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

  it('does not restore a stale session after concurrent 404 recovery', async () => {
    const requests: { id?: number; method?: string; session?: string }[] = [];
    let initializeCount = 0;
    let releaseLateResponse: () => void = () => {};
    const lateResponse = new Promise<void>((resolve) => {
      releaseLateResponse = resolve;
    });
    let notificationSeen: () => void = () => {};
    const notification = new Promise<void>((resolve) => {
      notificationSeen = resolve;
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
      requests.push({
        id: message.id,
        method: message.method,
        session: request.headers['mcp-session-id'],
      });
      if (message.method === 'initialize') {
        initializeCount += 1;
        response.setHeader('mcp-session-id', `s${initializeCount}`);
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
      } else if (message.method === 'notifications/initialized') {
        notificationSeen();
        response.statusCode = 202;
        response.end();
      } else if (message.id === 2) {
        await lateResponse;
        response.setHeader('mcp-session-id', 's1');
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { id: 2 } }));
      } else if (message.id === 3 && requests.filter(({ id }) => id === 3).length === 1) {
        response.statusCode = 404;
        response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32001 } }));
      } else {
        response.end(
          JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { id: message.id } }),
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
    await notification;
    client.send({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: {} });
    client.send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: {} });

    expect(await client.nextLine()).toMatchObject({ id: 3, result: { id: 3 } });
    releaseLateResponse();
    expect(await client.nextLine()).toMatchObject({ id: 2, result: { id: 2 } });
    client.send({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: {} });
    expect(await client.nextLine()).toMatchObject({ id: 4, result: { id: 4 } });

    expect(requests).toEqual([
      { id: 1, method: 'initialize', session: undefined },
      { id: undefined, method: 'notifications/initialized', session: 's1' },
      { id: 2, method: 'tools/call', session: 's1' },
      { id: 3, method: 'tools/call', session: 's1' },
      { id: 1, method: 'initialize', session: undefined },
      { id: undefined, method: 'notifications/initialized', session: 's2' },
      { id: 3, method: 'tools/call', session: 's2' },
      { id: 4, method: 'tools/call', session: 's2' },
    ]);
    expect(requests.filter(({ id }) => id === 3)).toHaveLength(2);
    expect(requests.filter(({ method }) => method === 'initialize')).toHaveLength(2);
    client.child.stdin.end();
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
    expect(await client.nextLine()).toMatchObject({ id: 3, result: { id: 3 } });
    expect(await client.nextLine()).toMatchObject({ id: 2, result: { id: 2 } });
    client.child.stdin.end();
    server.close();
  });

  it('correlates a null-id recovery failure', async () => {
    let initializeCount = 0;
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
      if (message.method === 'initialize') {
        initializeCount += 1;
        if (initializeCount === 1) {
          response.setHeader('mcp-session-id', 's1');
          response.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }));
        } else {
          response.statusCode = 401;
          response.end('Unauthorized');
        }
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
    expect(await client.nextLine()).toMatchObject({ id: null, error: { code: -32000 } });
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
