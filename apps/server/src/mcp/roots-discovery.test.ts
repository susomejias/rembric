import type { RequestOptions } from '@modelcontextprotocol/sdk/shared/protocol.js';
import {
  ErrorCode,
  McpError,
  type ListRootsResult,
  type RequestId,
} from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { SessionRouter } from '../server/session-router.js';

import {
  deriveSlugFromUri,
  ensureRootsDiscoveryRun,
  isDiscoveryRun,
  markRefreshPending,
  maybeDiscoverViaRoots,
  type RootsDiscoveryContext,
  type RootsDiscoveryDeps,
} from './roots-discovery.js';

describe('deriveSlugFromUri', () => {
  it('extracts the basename from a file:// URI', () => {
    expect(deriveSlugFromUri('file:///home/me/rembric')).toBe('rembric');
    expect(deriveSlugFromUri('file:///Users/x/repos/web-api')).toBe('web-api');
  });

  it('lowercases mixed-case directory names', () => {
    expect(deriveSlugFromUri('file:///home/me/Mi-Proyecto')).toBe('mi-proyecto');
  });

  it('replaces non-[a-z0-9-] characters with hyphens', () => {
    expect(deriveSlugFromUri('file:///home/me/My.Proj.v2')).toBe('my-proj-v2');
    expect(deriveSlugFromUri('file:///home/me/foo_bar')).toBe('foo-bar');
  });

  it('collapses runs of hyphens and trims edges', () => {
    expect(deriveSlugFromUri('file:///home/me/__weird__name__')).toBe('weird-name');
    expect(deriveSlugFromUri('file:///home/me/--leading--trailing--')).toBe('leading-trailing');
  });

  it('accepts plain paths without the file:// prefix', () => {
    expect(deriveSlugFromUri('/home/me/rembric')).toBe('rembric');
  });

  it('returns null for empty / unusable basenames', () => {
    expect(deriveSlugFromUri('file:///')).toBe(null);
    expect(deriveSlugFromUri('')).toBe(null);
    expect(deriveSlugFromUri('file:///home/me/!!!')).toBe(null);
  });

  it('rejects slugs longer than 64 characters', () => {
    const long = 'a'.repeat(70);
    expect(deriveSlugFromUri(`file:///tmp/${long}`)).toBe(null);
  });

  it('strips trailing slashes', () => {
    expect(deriveSlugFromUri('file:///home/me/rembric/')).toBe('rembric');
  });
});

/**
 * Outcome classification and single-flight bookkeeping. The once-only discovery
 * slot is consumed by an ANSWER, never by an attempt: the projects spec makes
 * the difference load-bearing, because a consumed slot misscopes the connection
 * for its whole life and no verb reassigns what it wrote.
 */
describe('maybeDiscoverViaRoots outcome classification', () => {
  const TOKEN = 'tk_roots_unit';
  let seq = 0;

  interface Harness {
    deps: RootsDiscoveryDeps;
    router: SessionRouter;
    ctx: RootsDiscoveryContext;
    listRootsCalls: () => number;
    lastOptions: () => RequestOptions | undefined;
  }

  function harness(opts: {
    roots?: boolean;
    listRoots?: () => Promise<ListRootsResult>;
    toolCallRequestId?: RequestId;
  }): Harness {
    const router = new SessionRouter();
    let calls = 0;
    let lastOptions: RequestOptions | undefined;
    const server = {
      server: {
        getClientCapabilities: () => (opts.roots === false ? {} : { roots: {} }),
        listRoots: (_params: undefined, options?: RequestOptions) => {
          calls += 1;
          lastOptions = options;
          return (opts.listRoots ?? (() => Promise.resolve({ roots: [] })))();
        },
      },
    };
    const projects = {
      findBySlug: (slug: string) => (slug === 'known' ? { id: 'p-known', slug } : undefined),
      getById: (id: string) => (id === 'p-known' ? { id, slug: 'known' } : undefined),
    };
    seq += 1;
    return {
      // Only the members the discovery path reads: the real McpServer and
      // ProjectsService drag a transport and a database in behind them.
      deps: { server, router, projects } as unknown as RootsDiscoveryDeps,
      router,
      ctx: {
        tokenId: TOKEN,
        mcpSessionId: `sess-${seq}`,
        pathSlug: null,
        toolCallRequestId: opts.toolCallRequestId,
      },
      listRootsCalls: () => calls,
      lastOptions: () => lastOptions,
    };
  }

  it('consumes the slot when the client answers with a root naming a project', async () => {
    const h = harness({
      listRoots: () => Promise.resolve({ roots: [{ uri: 'file:///x/known' }] }),
    });
    await maybeDiscoverViaRoots(h.deps, h.ctx);
    expect(isDiscoveryRun(h.deps.server, h.ctx.tokenId, h.ctx.mcpSessionId)).toBe(true);
    expect(h.router.get(h.ctx.tokenId, h.ctx.mcpSessionId)?.projectId).toBe('p-known');
  });

  it('consumes the slot when the client answers with an empty root list', async () => {
    const h = harness({ listRoots: () => Promise.resolve({ roots: [] }) });
    await maybeDiscoverViaRoots(h.deps, h.ctx);
    expect(isDiscoveryRun(h.deps.server, h.ctx.tokenId, h.ctx.mcpSessionId)).toBe(true);
  });

  it('consumes the slot when the client returns a JSON-RPC error', async () => {
    const h = harness({
      listRoots: () => Promise.reject(new McpError(ErrorCode.MethodNotFound, 'no roots here')),
    });
    await maybeDiscoverViaRoots(h.deps, h.ctx);
    expect(isDiscoveryRun(h.deps.server, h.ctx.tokenId, h.ctx.mcpSessionId)).toBe(true);
  });

  it('consumes the slot when the client advertises no roots capability', async () => {
    const h = harness({ roots: false });
    await maybeDiscoverViaRoots(h.deps, h.ctx);
    expect(isDiscoveryRun(h.deps.server, h.ctx.tokenId, h.ctx.mcpSessionId)).toBe(true);
    expect(h.listRootsCalls()).toBe(0);
  });

  it('leaves the slot unconsumed when the request times out', async () => {
    const h = harness({
      listRoots: () =>
        Promise.reject(McpError.fromError(ErrorCode.RequestTimeout, 'Request timed out')),
    });
    await maybeDiscoverViaRoots(h.deps, h.ctx);
    expect(isDiscoveryRun(h.deps.server, h.ctx.tokenId, h.ctx.mcpSessionId)).toBe(false);
  });

  it('leaves the slot unconsumed when the transport cannot route the request', async () => {
    const h = harness({
      listRoots: () => Promise.reject(new Error('No connection established for request ID: 7')),
    });
    await maybeDiscoverViaRoots(h.deps, h.ctx);
    expect(isDiscoveryRun(h.deps.server, h.ctx.tokenId, h.ctx.mcpSessionId)).toBe(false);
  });

  it('stamps the in-flight tool call id on the request, and omits it when there is none', async () => {
    const stamped = harness({ toolCallRequestId: 42 });
    await maybeDiscoverViaRoots(stamped.deps, stamped.ctx);
    expect(stamped.lastOptions()?.relatedRequestId).toBe(42);

    const unstamped = harness({});
    await maybeDiscoverViaRoots(unstamped.deps, unstamped.ctx);
    expect(unstamped.lastOptions()).toBeDefined();
    expect('relatedRequestId' in (unstamped.lastOptions() ?? {})).toBe(false);
  });

  it('holds the router promise only while an attempt is in flight', async () => {
    let release: (result: ListRootsResult) => void = () => undefined;
    const h = harness({
      listRoots: () =>
        new Promise<ListRootsResult>((resolve) => {
          release = resolve;
        }),
    });
    const run = ensureRootsDiscoveryRun(h.deps, h.ctx);
    expect(h.router.getDiscoveryPromise(h.ctx.tokenId, h.ctx.mcpSessionId)).toBeDefined();
    release({ roots: [{ uri: 'file:///x/known' }] });
    await run;
    expect(h.router.getDiscoveryPromise(h.ctx.tokenId, h.ctx.mcpSessionId)).toBeUndefined();
  });

  it('retries on the next call after an attempt that produced no answer', async () => {
    let attempt = 0;
    const h = harness({
      listRoots: () => {
        attempt += 1;
        return attempt === 1
          ? Promise.reject(McpError.fromError(ErrorCode.RequestTimeout, 'Request timed out'))
          : Promise.resolve({ roots: [{ uri: 'file:///x/known' }] });
      },
    });
    await ensureRootsDiscoveryRun(h.deps, h.ctx);
    expect(h.router.get(h.ctx.tokenId, h.ctx.mcpSessionId)?.projectId).toBeUndefined();

    await ensureRootsDiscoveryRun(h.deps, h.ctx);
    expect(h.listRootsCalls()).toBe(2);
    expect(h.router.get(h.ctx.tokenId, h.ctx.mcpSessionId)?.projectId).toBe('p-known');
  });

  it('collapses two concurrent first callers onto one request', async () => {
    let release: (result: ListRootsResult) => void = () => undefined;
    const h = harness({
      listRoots: () =>
        new Promise<ListRootsResult>((resolve) => {
          release = resolve;
        }),
    });
    const both = Promise.all([
      ensureRootsDiscoveryRun(h.deps, h.ctx),
      ensureRootsDiscoveryRun(h.deps, h.ctx),
    ]);
    release({ roots: [{ uri: 'file:///x/known' }] });
    await both;
    expect(h.listRootsCalls()).toBe(1);
  });

  /**
   * Two DISTINCT fake servers: reusing one for "two transports" would share the
   * state record and silently invert what these arms assert.
   */
  describe('per-transport ownership of the state record', () => {
    it('a refresh pending on one transport does not reach another', async () => {
      let aRoot = 'file:///x/known';
      const a = harness({ listRoots: () => Promise.resolve({ roots: [{ uri: aRoot }] }) });
      const b = harness({
        listRoots: () => Promise.resolve({ roots: [{ uri: 'file:///x/known' }] }),
      });
      await ensureRootsDiscoveryRun(a.deps, a.ctx);
      await ensureRootsDiscoveryRun(b.deps, b.ctx);
      expect(a.listRootsCalls()).toBe(1);
      expect(b.listRootsCalls()).toBe(1);

      aRoot = 'file:///x/elsewhere';
      markRefreshPending(a.deps.server);

      await ensureRootsDiscoveryRun(b.deps, b.ctx);
      expect(b.listRootsCalls(), 'B was re-asked for A’s notification').toBe(1);
      expect(b.router.get(b.ctx.tokenId, b.ctx.mcpSessionId)?.pendingSuggestedSlugs).toEqual([]);

      await ensureRootsDiscoveryRun(a.deps, a.ctx);
      expect(a.listRootsCalls()).toBe(2);
      const entry = a.router.get(a.ctx.tokenId, a.ctx.mcpSessionId);
      expect(entry?.pendingSuggestedSlugs).toEqual(['elsewhere']);
      expect(entry?.projectId).toBe('p-known');
    });

    it('drops the state record with the server that owns it', async () => {
      const h = harness({
        listRoots: () => Promise.resolve({ roots: [{ uri: 'file:///x/known' }] }),
      });
      await maybeDiscoverViaRoots(h.deps, h.ctx);
      expect(isDiscoveryRun(h.deps.server, h.ctx.tokenId, h.ctx.mcpSessionId)).toBe(true);
      // A new connection reusing the same identity tuple starts cold, so no
      // sentinel outlives the transport it describes.
      const reconnected = harness({
        listRoots: () => Promise.resolve({ roots: [{ uri: 'file:///x/known' }] }),
      });
      expect(isDiscoveryRun(reconnected.deps.server, h.ctx.tokenId, h.ctx.mcpSessionId)).toBe(
        false,
      );
    });
  });
});
