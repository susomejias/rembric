import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { ProjectsService } from '@rembric/core';
import type * as CoreModule from '@rembric/core';
import { createRepositories } from '@rembric/db';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { DELETE, GET, POST } from '../app/mcp/[[...path]]/route';
import { getServices } from '../lib/services';

import { defaultProject } from './default-project.js';

/**
 * Routing-level coverage for roots discovery, over the real Next `/mcp` route
 * handler.
 *
 * The arm below that asserts the client's optional standalone GET stream never
 * reaches the server needs a server-side request log. That boundary is the
 * adapter that
 * hands the SDK's request to `route.ts`, so `httpLog` records exactly what the
 * handler received (and, unlike a socket-level log, could not be confused by a
 * GET Next itself answered before the handler).
 *
 * `loadEmbedder` is replaced as in `mcp-transport.test.ts`: the service graph is
 * the production one, only the ONNX factory is swapped for the deterministic,
 * offline fixture.
 */

vi.mock('@rembric/core', async (importOriginal) => {
  const actual = await importOriginal<typeof CoreModule>();
  const { FakeEmbedder } = await import('./embedder.js');
  return { ...actual, loadEmbedder: () => Promise.resolve(new FakeEmbedder()) };
});

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { raw: { close: () => void }; close: () => void };
  __rembricMcpSurface?: { close?: () => Promise<void> };
  __rembricSessionRouter?: unknown;
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
  delete globalForApp.__rembricMcpSurface;
  delete globalForApp.__rembricSessionRouter;
}

const ORIGIN = 'http://127.0.0.1:8787';

/** Drive the real route handler with the request the SDK would have sent. */
function routeFetch(url: string | URL, init?: RequestInit): Promise<Response> {
  const pathname = new URL(url).pathname;
  const segments = pathname.split('/').filter((s) => s.length > 0);
  const rest = segments.slice(1);
  const method = (init?.method ?? 'GET').toUpperCase();
  const request = new Request(url, init);
  const handler = method === 'GET' ? GET : method === 'DELETE' ? DELETE : POST;
  return handler(request, { params: Promise.resolve(rest.length > 0 ? { path: rest } : {}) });
}

describe('roots discovery routing (in-process route handler)', () => {
  let dataDir: string;
  let adminToken: string;
  let services: ReturnType<typeof getServices>;
  /** Every request the route handler received, in arrival order. */
  const httpLog: string[] = [];

  interface ToolResult {
    content: Array<{ type: string; text?: string }>;
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
  }

  function readJson(result: ToolResult): unknown {
    const first = result.content.find((c) => c.type === 'text');
    if (!first?.text) return null;
    try {
      return JSON.parse(first.text);
    } catch {
      return first.text;
    }
  }

  beforeAll(() => {
    resetAppGlobals();
    dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-roots-'));
    process.env['REMBRIC_DATA_DIR'] = dataDir;
    delete process.env['REMBRIC_PUBLIC_URL'];
    services = getServices();
    adminToken = services.tokens.create({ name: 'roots-routing-admin', scope: '*' }).plaintext;
    httpLog.length = 0;
  });

  afterAll(async () => {
    await globalForApp.__rembricMcpSurface?.close?.();
    await new Promise((resolve) => setImmediate(resolve));
    resetAppGlobals();
    delete process.env['REMBRIC_DATA_DIR'];
    rmSync(dataDir, { recursive: true, force: true });
  });

  function createProject(slug: string): { id: string; slug: string } {
    return new ProjectsService(createRepositories(services.db.db)).create({ slug });
  }

  interface RootsConnection {
    client: Client;
    clientMethods: string[];
    rootsCalls: () => number;
    /** Change what the client's `roots/list` handler answers; `null` = empty list. */
    setRoot: (uri: string | null) => void;
  }

  async function connectRoots(opts: {
    rootUri: string;
    advertiseRoots?: boolean;
    listChanged?: boolean;
    suppressStandaloneStream?: boolean;
    dropFirstRootsList?: boolean;
    /** Answer this many `roots/list` requests, then go silent forever. */
    answerLimit?: number;
  }): Promise<RootsConnection> {
    const clientMethods: string[] = [];
    const guardedFetch: FetchLike = (url, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      clientMethods.push(method);
      if (opts.suppressStandaloneStream === true && method === 'GET') {
        // 405 is the SDK's "this server offers no GET stream" path, taken
        // without raising: the route never sees the GET, so no standalone
        // server→client stream is ever registered.
        return Promise.resolve(new Response(null, { status: 405 }));
      }
      httpLog.push(`${method} ${new URL(url).pathname}`);
      return routeFetch(url, init);
    };
    const advertiseRoots = opts.advertiseRoots !== false;
    const transport = new StreamableHTTPClientTransport(new URL(`${ORIGIN}/mcp`), {
      fetch: guardedFetch,
      requestInit: { headers: { Authorization: `Bearer ${adminToken}` } },
    });
    const roots = opts.listChanged === true ? { listChanged: true } : {};
    const client = new Client(
      { name: 'roots-routing-client', version: '0.0.0' },
      { capabilities: advertiseRoots ? { roots } : {} },
    );
    let calls = 0;
    let rootUri: string | null = opts.rootUri;
    if (advertiseRoots) {
      client.setRequestHandler(ListRootsRequestSchema, async () => {
        calls += 1;
        const silentFrom = opts.answerLimit;
        if (
          (opts.dropFirstRootsList === true && calls === 1) ||
          (silentFrom !== undefined && calls > silentFrom)
        ) {
          // No answer of ANY kind, so the server's own budget expires. A
          // rejection would instead be an answer, which legitimately consumes
          // the once-only discovery slot.
          await new Promise(() => {});
        }
        return rootUri === null ? { roots: [] } : { roots: [{ uri: rootUri, name: rootUri }] };
      });
    }
    await client.connect(transport);
    return {
      client,
      clientMethods,
      rootsCalls: () => calls,
      setRoot: (uri) => {
        rootUri = uri;
      },
    };
  }

  async function contextScope(client: Client): Promise<string> {
    const result = (await client.callTool({
      name: 'memory.context',
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    return (readJson(result) as { scope: string }).scope;
  }

  interface CurrentProject {
    slug: string | null;
    projectId: string | null;
    source: string;
    suggestedSlugs: string[];
  }

  async function projectCurrent(client: Client): Promise<CurrentProject> {
    const result = (await client.callTool({
      name: 'project.current',
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    return readJson(result) as CurrentProject;
  }

  /** End-to-end tool-call latency at the SDK client — the only instrument used below. */
  async function timedScope(client: Client): Promise<{ scope: string; ms: number }> {
    const started = performance.now();
    const scope = await contextScope(client);
    return { scope, ms: performance.now() - started };
  }

  it('resolves the discovered project on the first connection a server serves', async () => {
    const project = createProject('routing-cold-arm');
    const { client } = await connectRoots({ rootUri: `file:///tmp/${project.slug}` });
    expect(await contextScope(client)).toBe(`project:${project.id}`);
    await client.close();
  });

  it('completes discovery while the client never opens the standalone stream', async () => {
    const project = createProject('routing-no-standalone');
    const from = httpLog.length;
    const { client, clientMethods } = await connectRoots({
      rootUri: `file:///tmp/${project.slug}`,
      suppressStandaloneStream: true,
    });
    const scope = await contextScope(client);
    const mine = httpLog.slice(from);

    expect(clientMethods, 'the client did attempt the standalone GET').toContain('GET');
    expect(mine.filter((line) => line.startsWith('GET /mcp'))).toEqual([]);
    // The instrument is live: this connection's POSTs did reach the server.
    expect(mine.some((line) => line.startsWith('POST /mcp'))).toBe(true);
    expect(scope).toBe(`project:${project.id}`);

    await client.close();
  });

  it('retries discovery on the next tool call when the first roots/list got no answer', async () => {
    const dflt = defaultProject(services.db);
    const project = createProject('routing-unanswered-first');
    const { client, rootsCalls } = await connectRoots({
      rootUri: `file:///tmp/${project.slug}`,
      dropFirstRootsList: true,
    });

    expect(await contextScope(client)).toBe(`project:${dflt.id}`);
    expect(rootsCalls()).toBe(1);

    expect(await contextScope(client)).toBe(`project:${project.id}`);
    expect(rootsCalls()).toBe(2);

    const current = readJson(
      (await client.callTool({ name: 'project.current', arguments: {} })) as ToolResult,
    ) as { projectId: string | null };
    expect(current.projectId).toBe(project.id);

    await client.close();
  });

  // Control: without it, "the discovered project" above could be the default
  // project under another name.
  it('resolves the default project when the client advertises no roots capability', async () => {
    const dflt = defaultProject(services.db);
    const project = createProject('routing-not-discovered');
    const { client, rootsCalls } = await connectRoots({
      rootUri: `file:///tmp/${project.slug}`,
      advertiseRoots: false,
    });
    expect(await contextScope(client)).toBe(`project:${dflt.id}`);
    expect(rootsCalls()).toBe(0);
    await client.close();
  });

  /**
   * `notifications/roots/list_changed`. The notification's POST is answered 202
   * only after the server transport has dispatched it, so no arm below needs to
   * wait for the flag to land.
   */
  describe('roots/list_changed lifecycle', () => {
    // Control for every arm below: it passes on both sides of the change, so a
    // harness that never reaches the discovery path is distinguishable from a
    // correct one.
    it('asks once and suggests nothing across three scope-resolving calls', async () => {
      const project = createProject('probe-control');
      const { client, rootsCalls } = await connectRoots({
        rootUri: `file:///tmp/${project.slug}`,
        listChanged: true,
      });
      for (let i = 0; i < 3; i += 1) {
        expect(await contextScope(client)).toBe(`project:${project.id}`);
      }
      expect(rootsCalls()).toBe(1);
      expect(await projectCurrent(client)).toMatchObject({
        projectId: project.id,
        source: 'roots',
        suggestedSlugs: [],
      });
      await client.close();
    });

    it('leaves an unrelated transport untouched when another one emits list_changed', async () => {
      const pa = createProject('probe-d2-a');
      const pb = createProject('probe-d2-b');
      const a = await connectRoots({ rootUri: `file:///tmp/${pa.slug}`, listChanged: true });
      const b = await connectRoots({ rootUri: `file:///tmp/${pb.slug}`, listChanged: true });
      expect(await contextScope(a.client)).toBe(`project:${pa.id}`);
      expect(await contextScope(b.client)).toBe(`project:${pb.id}`);
      const before = await projectCurrent(b.client);
      expect(before).toMatchObject({ projectId: pb.id, source: 'roots', suggestedSlugs: [] });
      expect(b.rootsCalls()).toBe(1);

      await a.client.sendRootsListChanged();

      expect(await contextScope(b.client)).toBe(`project:${pb.id}`);
      expect(b.rootsCalls(), 'B was re-asked because A changed folders').toBe(1);
      expect(await projectCurrent(b.client)).toEqual(before);

      await a.client.close();
      await b.client.close();
    });

    it('refreshes the emitting transport suggestions without switching its project', async () => {
      const oldProject = createProject('probe-d1-old');
      const newProject = createProject('probe-d1-new');
      const a = await connectRoots({
        rootUri: `file:///tmp/${oldProject.slug}`,
        listChanged: true,
      });
      expect(await contextScope(a.client)).toBe(`project:${oldProject.id}`);
      expect((await projectCurrent(a.client)).suggestedSlugs).toEqual([]);

      a.setRoot(`file:///tmp/${newProject.slug}`);
      await a.client.sendRootsListChanged();

      expect(await projectCurrent(a.client)).toMatchObject({
        projectId: oldProject.id,
        source: 'roots',
        suggestedSlugs: [newProject.slug],
      });
      expect(a.rootsCalls()).toBe(2);
      await a.client.close();
    });

    it('spends one roots/list budget in total for a list_changed the client never answers', async () => {
      const project = createProject('probe-gone-quiet');
      const a = await connectRoots({
        rootUri: `file:///tmp/${project.slug}`,
        listChanged: true,
        answerLimit: 1,
      });
      expect(await contextScope(a.client)).toBe(`project:${project.id}`);
      const warm = await timedScope(a.client);
      expect(warm.scope).toBe(`project:${project.id}`);
      expect(warm.ms, 'warm baseline must not touch the budget').toBeLessThan(500);
      expect(a.rootsCalls()).toBe(1);

      await a.client.sendRootsListChanged();

      // The first call after the notification may spend one budget — the
      // accepted cost of one attempt per notification.
      const first = await timedScope(a.client);
      const second = await timedScope(a.client);
      expect(first.scope).toBe(`project:${project.id}`);
      expect(second.scope).toBe(`project:${project.id}`);
      expect(
        second.ms,
        `warm ${warm.ms.toFixed(0)}ms, first-after ${first.ms.toFixed(0)}ms, ` +
          `roots/list count ${a.rootsCalls()}`,
      ).toBeLessThan(500);
      expect(a.rootsCalls()).toBe(2);
      expect(await projectCurrent(a.client)).toMatchObject({
        projectId: project.id,
        source: 'roots',
      });
      await a.client.close();
    }, 30_000);

    it('suggests an existing project on refresh without activating it', async () => {
      const dflt = defaultProject(services.db);
      const target = createProject('probe-refresh-target');
      const a = await connectRoots({
        rootUri: 'file:///tmp/probe-refresh-unknown',
        listChanged: true,
      });
      expect(await contextScope(a.client)).toBe(`project:${dflt.id}`);
      expect(await projectCurrent(a.client)).toMatchObject({
        projectId: dflt.id,
        source: 'default',
        suggestedSlugs: ['probe-refresh-unknown'],
      });

      a.setRoot(`file:///tmp/${target.slug}`);
      await a.client.sendRootsListChanged();

      expect(await projectCurrent(a.client)).toMatchObject({
        projectId: dflt.id,
        source: 'default',
        suggestedSlugs: [target.slug],
      });
      expect(a.rootsCalls()).toBe(2);
      await a.client.close();
    });

    it('clears a stale suggestion when the refreshed roots are empty', async () => {
      const a = await connectRoots({ rootUri: 'file:///tmp/probe-stale-empty', listChanged: true });
      expect((await projectCurrent(a.client)).suggestedSlugs).toEqual(['probe-stale-empty']);

      a.setRoot(null);
      await a.client.sendRootsListChanged();

      expect((await projectCurrent(a.client)).suggestedSlugs).toEqual([]);
      await a.client.close();
    });

    it('clears a stale suggestion when no slug can be derived from the refreshed roots', async () => {
      const a = await connectRoots({ rootUri: 'file:///tmp/probe-stale-bad', listChanged: true });
      expect((await projectCurrent(a.client)).suggestedSlugs).toEqual(['probe-stale-bad']);

      a.setRoot('file:///');
      await a.client.sendRootsListChanged();

      expect((await projectCurrent(a.client)).suggestedSlugs).toEqual([]);
      await a.client.close();
    });

    it('runs ordinary discovery for a list_changed that precedes any answered discovery', async () => {
      const dflt = defaultProject(services.db);
      const project = createProject('probe-unanswered-then-changed');
      const a = await connectRoots({
        rootUri: `file:///tmp/${project.slug}`,
        listChanged: true,
        dropFirstRootsList: true,
      });
      expect(await contextScope(a.client)).toBe(`project:${dflt.id}`);
      expect(a.rootsCalls()).toBe(1);

      await a.client.sendRootsListChanged();

      expect(await contextScope(a.client)).toBe(`project:${project.id}`);
      // One request for that tool call, not one for discovery and one for the refresh.
      expect(a.rootsCalls()).toBe(2);
      expect(await projectCurrent(a.client)).toMatchObject({
        projectId: project.id,
        source: 'roots',
      });
      await a.client.close();
    }, 30_000);

    it('delivers the refreshing roots/list while the client never opens the standalone stream', async () => {
      const oldProject = createProject('probe-refresh-nostream-old');
      const newProject = createProject('probe-refresh-nostream-new');
      const from = httpLog.length;
      const a = await connectRoots({
        rootUri: `file:///tmp/${oldProject.slug}`,
        listChanged: true,
        suppressStandaloneStream: true,
      });
      expect(await contextScope(a.client)).toBe(`project:${oldProject.id}`);

      a.setRoot(`file:///tmp/${newProject.slug}`);
      await a.client.sendRootsListChanged();
      const after = await projectCurrent(a.client);
      const mine = httpLog.slice(from);

      expect(a.clientMethods, 'the client did attempt the standalone GET').toContain('GET');
      expect(mine.filter((line) => line.startsWith('GET /mcp'))).toEqual([]);
      expect(mine.some((line) => line.startsWith('POST /mcp'))).toBe(true);
      expect(after).toMatchObject({
        projectId: oldProject.id,
        suggestedSlugs: [newProject.slug],
      });
      await a.client.close();
    });
  });
});
