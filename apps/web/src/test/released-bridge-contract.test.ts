import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as CoreModule from '@rembric/core';
import { projectScope } from '@rembric/db';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import * as resolveRoute from '../app/api/repositories/resolve/route';
import * as mcpRoute from '../app/mcp/[[...path]]/route';
import { resetMcpRateLimiterForTests } from '../lib/rate-limit';
import { getServices } from '../lib/services';

vi.mock('@rembric/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  const embedder = {
    modelId: 'released-bridge-contract-embedder',
    embed: (text: string) => {
      const vector = new Float32Array(actual.EMBEDDING_DIMS);
      vector[text.length % actual.EMBEDDING_DIMS] = 1;
      return Promise.resolve(vector);
    },
  };
  return { ...actual, loadEmbedder: () => Promise.resolve(embedder) };
});

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/mcp-bridge-0.45.1/', import.meta.url));
const BRIDGE_CLI = join(FIXTURE_DIR, 'cli.mjs');
const LINE_TIMEOUT_MS = 15_000;

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { close: () => void };
  __rembricMcpSurface?: unknown;
};
const globalForApp = globalThis as MutableGlobal;

function resetAppGlobals(): void {
  try {
    globalForApp.__rembricDb?.close();
  } catch {}
  delete globalForApp.__rembricServices;
  delete globalForApp.__rembricDb;
  delete globalForApp.__rembricMcpSurface;
}

type Method = 'GET' | 'POST' | 'DELETE';

async function toRequest(req: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  const method = req.method ?? 'GET';
  const hasBody = method !== 'GET' && method !== 'HEAD' && chunks.length > 0;
  return new Request(new URL(req.url ?? '/', origin), {
    method,
    headers,
    body: hasBody ? Buffer.concat(chunks) : undefined,
  });
}

async function route(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments[0] === 'mcp') {
    const handler = mcpRoute[request.method as Method] as typeof mcpRoute.POST | undefined;
    if (!handler) return new Response(null, { status: 405 });
    const path = segments.length > 1 ? segments.slice(1) : undefined;
    return handler(request, { params: Promise.resolve({ path }) });
  }
  if (url.pathname === '/api/repositories/resolve' && request.method === 'POST') {
    return resolveRoute.POST(request);
  }
  return new Response('not found', { status: 404 });
}

async function startServer(): Promise<{ server: Server; origin: string }> {
  let origin = '';
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const response = await route(await toRequest(req, origin));
        res.writeHead(response.status, Object.fromEntries(response.headers));
        const reader = response.body?.getReader();
        while (reader) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
        res.end();
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    })();
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected an AddressInfo');
  origin = `http://127.0.0.1:${address.port}`;
  return { server, origin };
}

function isolatedGitEnv(home: string): NodeJS.ProcessEnv {
  return {
    NODE_ENV: process.env.NODE_ENV,
    PATH: process.env['PATH'],
    HOME: home,
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig-none'),
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function spawnReleasedBridge(cwd: string, home: string, env: Record<string, string>) {
  const child = spawn(process.execPath, [BRIDGE_CLI], {
    cwd,
    env: { ...isolatedGitEnv(home), PWD: cwd, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let stdout = '';
  let stderr = '';
  const lines: string[] = [];
  let wake: (() => void) | undefined;
  let exit = 'running';
  child.on('exit', (code, signal) => {
    exit = `exited code=${code} signal=${signal}`;
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
    let newline = stdout.indexOf('\n');
    while (newline >= 0) {
      lines.push(stdout.slice(0, newline));
      stdout = stdout.slice(newline + 1);
      newline = stdout.indexOf('\n');
    }
    wake?.();
  });
  async function nextMessage(): Promise<Record<string, unknown>> {
    const deadline = Date.now() + LINE_TIMEOUT_MS;
    while (lines.length === 0) {
      if (Date.now() > deadline) throw new Error(`no bridge output (${exit}); stderr:\n${stderr}`);
      await new Promise<void>((resolve) => {
        wake = resolve;
        setTimeout(resolve, 250);
      });
    }
    return JSON.parse(lines.shift() as string) as Record<string, unknown>;
  }
  function send(message: Record<string, unknown>): void {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  async function request(id: number, method: string, params: Record<string, unknown>) {
    send({ jsonrpc: '2.0', id, method, params });
    const reply = await nextMessage();
    expect(reply['id'], `reply to ${method}; stderr:\n${stderr}`).toBe(id);
    return reply;
  }
  return {
    request,
    send,
    get stderr() {
      return stderr;
    },
  };
}

async function initialize(bridge: ReturnType<typeof spawnReleasedBridge>) {
  const init = await bridge.request(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'released-bridge-contract', version: '0.0.0' },
  });
  expect(init['error'], bridge.stderr).toBeUndefined();
  bridge.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return init['result'] as { protocolVersion: string };
}

async function currentSlug(bridge: ReturnType<typeof spawnReleasedBridge>, id: number) {
  const reply = await bridge.request(id, 'tools/call', { name: 'project.current', arguments: {} });
  const result = reply['result'] as {
    isError?: boolean;
    content?: unknown;
    structuredContent?: { slug?: string };
  };
  expect(result.isError ?? false, `${JSON.stringify(result.content)}\n${bridge.stderr}`).toBe(
    false,
  );
  return result.structuredContent?.slug;
}

const children: ChildProcessWithoutNullStreams[] = [];
let dataDir: string;
let workDir: string;
let home: string;
let server: Server;
let origin: string;

beforeAll(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'rembric-released-bridge-data-'));
  home = realpathSync(mkdtempSync(join(tmpdir(), 'rembric-released-bridge-home-')));
  process.env['REMBRIC_DATA_DIR'] = dataDir;
  resetAppGlobals();
  ({ server, origin } = await startServer());
});

beforeEach(() => {
  workDir = realpathSync(mkdtempSync(join(tmpdir(), 'rembric-released-bridge-work-')));
});

afterEach(() => {
  for (const child of children.splice(0)) child.kill('SIGKILL');
  rmSync(workDir, { recursive: true, force: true });
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  resetAppGlobals();
  resetMcpRateLimiterForTests();
  delete process.env['REMBRIC_DATA_DIR'];
  for (const dir of [dataDir, home]) rmSync(dir, { recursive: true, force: true });
});

describe('the frozen @rembric/mcp-bridge@0.45.1 against the current server', () => {
  it('the fixture is byte-identical to the published tarball', () => {
    const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, 'checksums.json'), 'utf8')) as {
      version: string;
      sha256: Record<string, string>;
    };
    expect(manifest.version).toBe('0.45.1');
    const modules = readdirSync(FIXTURE_DIR)
      .filter((name) => name.endsWith('.mjs'))
      .sort();
    expect(modules).toEqual(Object.keys(manifest.sha256).sort());
    for (const name of modules) {
      const digest = createHash('sha256')
        .update(readFileSync(join(FIXTURE_DIR, name)))
        .digest('hex');
      expect(digest, name).toBe(manifest.sha256[name]);
    }
  });

  it('initializes, lists tools and calls a tool in the slug-selected project', async () => {
    const services = getServices();
    const shop = services.projects.create({ slug: 'shop' });
    const token = services.tokens.create({
      name: 'released-bridge',
      project: shop,
      access: 'write',
    });

    const bridge = spawnReleasedBridge(workDir, home, {
      REMBRIC_SERVER_URL: origin,
      REMBRIC_API_TOKEN: token.plaintext,
      REMBRIC_PROJECT_SLUG: 'shop',
    });

    const init = await initialize(bridge);
    expect(init.protocolVersion).toBe('2025-06-18');

    const list = await bridge.request(2, 'tools/list', {});
    const tools = (list['result'] as { tools: { name: string }[] }).tools.map((tool) => tool.name);
    expect(tools).toContain('project.current');
    expect(tools).toContain('memory.save');

    expect(await currentSlug(bridge, 3)).toBe('shop');
    expect(bridge.stderr).toContain(`url=${origin}/mcp/shop`);
  });

  it('resolves its project from a bound repository fingerprint', async () => {
    const services = getServices();
    const repo = services.projects.create({ slug: 'repo-shop' });
    const token = services.tokens.create({
      name: 'released-bridge-repo',
      project: repo,
      access: 'write',
    });
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: workDir, env: isolatedGitEnv(home), stdio: 'ignore' });
    git('init', '-q');
    git('remote', 'add', 'origin', 'https://github.com/acme/shop.git');
    git(
      '-c',
      'user.name=t',
      '-c',
      'user.email=t@example.com',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'root',
    );

    const released = (await import(join(FIXTURE_DIR, 'rembric-project.mjs'))) as {
      inspectRepository: (dir: string) => Promise<{ fingerprint: string | null }>;
    };
    const saved = { ...process.env };
    Object.assign(process.env, isolatedGitEnv(home));
    const repository = await released.inspectRepository(workDir).finally(() => {
      process.env = saved;
    });
    expect(repository.fingerprint).toMatch(/^[0-9a-f]{40}$|^[0-9a-f]{64}$/);
    services.repositoryBindings.bind({
      fingerprint: repository.fingerprint as string,
      projectId: repo.id,
      createdBy: 'test',
    });

    const bridge = spawnReleasedBridge(workDir, home, {
      REMBRIC_SERVER_URL: origin,
      REMBRIC_API_TOKEN: token.plaintext,
    });

    await initialize(bridge);
    const current = await bridge.request(2, 'tools/call', {
      name: 'project.current',
      arguments: {},
    });
    const content = (
      current['result'] as {
        structuredContent: { slug: string; repository?: { fingerprint: string | null } };
      }
    ).structuredContent;
    expect(content.slug).toBe('repo-shop');
    expect(content.repository?.fingerprint).toBe(repository.fingerprint);
    expect(bridge.stderr).toContain(`url=${origin}/mcp/repo-shop`);
  });

  it('is accepted when it reports an unavailable fingerprint from a repository without commits', async () => {
    const services = getServices();
    const fresh = services.projects.create({ slug: 'fresh-repo' });
    const created = services.tokens.create({
      name: 'released-bridge-unavailable',
      project: fresh,
      access: 'write',
    });
    execFileSync('git', ['init', '-q'], {
      cwd: workDir,
      env: isolatedGitEnv(home),
      stdio: 'ignore',
    });
    writeFileSync(join(workDir, '.rembric'), 'PROJECT_SLUG=fresh-repo\n');

    const bridge = spawnReleasedBridge(workDir, home, {
      REMBRIC_SERVER_URL: origin,
      REMBRIC_API_TOKEN: created.plaintext,
    });

    await initialize(bridge);
    const current = await bridge.request(2, 'tools/call', {
      name: 'project.current',
      arguments: {},
    });
    const result = current['result'] as {
      isError?: boolean;
      structuredContent: { slug: string; repository?: { fingerprint: string | null } };
    };
    expect(result.isError ?? false, bridge.stderr).toBe(false);
    expect(result.structuredContent.slug).toBe('fresh-repo');
    expect(result.structuredContent.repository).toBeDefined();
    expect(result.structuredContent.repository?.fingerprint).toBeNull();
  });

  it('declares the host session so a save attaches to it', async () => {
    const services = getServices();
    const notes = services.projects.create({ slug: 'notes' });
    const created = services.tokens.create({
      name: 'released-bridge-session',
      project: notes,
      access: 'write',
    });
    const other = services.agentSessions.start({
      tokenId: created.token.id,
      projectId: notes.id,
      agent: 'pi',
    });
    const declared = services.agentSessions.start({
      tokenId: created.token.id,
      projectId: notes.id,
      agent: 'pi',
    });
    expect(other.id).not.toBe(declared.id);

    const binding = (await import(join(FIXTURE_DIR, 'rembric-host-binding.mjs'))) as {
      publishHostBinding: (options: { pid: number; sessionId: string; home: string }) => boolean;
    };
    expect(binding.publishHostBinding({ pid: process.pid, sessionId: declared.id, home })).toBe(
      true,
    );

    const bridge = spawnReleasedBridge(workDir, home, {
      REMBRIC_SERVER_URL: origin,
      REMBRIC_API_TOKEN: created.plaintext,
      REMBRIC_PROJECT_SLUG: 'notes',
    });
    await initialize(bridge);
    const saved = await bridge.request(2, 'tools/call', {
      name: 'memory.save',
      arguments: { type: 'project', title: 'contract probe', content: 'attached', tags: ['probe'] },
    });
    const savedResult = saved['result'] as { isError?: boolean; structuredContent: { id: string } };
    expect(savedResult.isError ?? false, bridge.stderr).toBe(false);

    const [memory] = services.memory.getMany(
      [savedResult.structuredContent.id],
      projectScope(notes.id),
    );
    expect(memory?.sessionId).toBe(declared.id);
  });
});
