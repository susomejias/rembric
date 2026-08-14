import { createServer as createHttpServer, type Server } from 'node:http';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { findFreePort } from '../test/net.js';

import { McpTransportManager } from './transport.js';

/**
 * A raw MCP round trip with no auth, no Rembric tools, no `http.ts` — just
 * enough of the real edge that `onsessioninitialized` and `getOrCreate`'s
 * request-handling path actually run, which is what stamps and bumps
 * `lastSeenAt`.
 */
async function rpc(
  baseUrl: string,
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
): Promise<{ sessionId: string | null }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  if (sessionId) headers['mcp-session-id'] = sessionId;
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  await res.text();
  return { sessionId: res.headers.get('mcp-session-id') };
}

async function initSession(baseUrl: string): Promise<string> {
  const { sessionId } = await rpc(baseUrl, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'transport-test', version: '0' },
  });
  if (!sessionId) throw new Error('initialize did not return a session id');
  await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'mcp-session-id': sessionId },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  return sessionId;
}

let mgr: McpTransportManager;
let httpServer: Server;
let baseUrl: string;

beforeEach(async () => {
  mgr = new McpTransportManager(() => new McpServer({ name: 'transport-test', version: '0.0.0' }));
  httpServer = createHttpServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      const body = raw ? (JSON.parse(raw) as unknown) : undefined;
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      const transport = await mgr.getOrCreate(sessionId, { requestedSlug: null });
      await transport.handleRequest(req, res, body);
    })();
  });
  const port = await findFreePort();
  await new Promise<void>((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  mgr.close();
  await new Promise<void>((resolve) => httpServer.close(() => resolve()));
});

describe('McpTransportManager activity clock', () => {
  it('stamps lastSeenAt on initialize and bumps it on a later request for the same id', async () => {
    const sessionId = await initSession(baseUrl);
    const [afterInit] = [...mgr.entries()];
    expect(afterInit?.mcpSessionId).toBe(sessionId);

    await new Promise((resolve) => setTimeout(resolve, 5));
    await rpc(baseUrl, 'tools/list', {}, sessionId);

    const [afterList] = [...mgr.entries()];
    expect(afterList?.lastSeenAt).toBeGreaterThan(afterInit!.lastSeenAt);
  });

  it('does not advance a different transport’s clock', async () => {
    const a = await initSession(baseUrl);
    const b = await initSession(baseUrl);
    const before = new Map([...mgr.entries()].map((e) => [e.mcpSessionId, e.lastSeenAt]));

    await new Promise((resolve) => setTimeout(resolve, 5));
    await rpc(baseUrl, 'tools/list', {}, a);

    const after = new Map([...mgr.entries()].map((e) => [e.mcpSessionId, e.lastSeenAt]));
    expect(after.get(a)).toBeGreaterThan(before.get(a)!);
    expect(after.get(b)).toBe(before.get(b));
  });

  it('has() reports exactly the ids the manager holds', async () => {
    const sessionId = await initSession(baseUrl);
    expect(mgr.has(sessionId)).toBe(true);
    expect(mgr.has('unknown-id')).toBe(false);
  });

  it('evict() closes and removes the pair, and is idempotent', async () => {
    const sessionId = await initSession(baseUrl);
    expect(mgr.evict(sessionId)).toBe(true);
    expect(mgr.has(sessionId)).toBe(false);
    expect(mgr.evict(sessionId)).toBe(false);
  });

  // Design Risk 2 / Open Question 3, measured rather than reasoned: the SDK
  // client opens a standalone GET SSE stream on connect. That GET is itself a
  // `getOrCreate` hit (bumps lastSeenAt once), but MERELY holding it open
  // issues no further request, so a client idle on the request clock while
  // still holding the stream open reads as stale under condition (b).
  it('a standalone SSE stream held open bumps lastSeenAt once at open, not while merely held', async () => {
    const clientTransport = new StreamableHTTPClientTransport(new URL(baseUrl));
    const client = new Client({ name: 'sse-hold-test', version: '0.0.0' }, { capabilities: {} });
    await client.connect(clientTransport);
    // connect() resolves once `initialize` completes, but `notifications/initialized`
    // and the standalone GET both fire shortly after — let all of connection setup
    // settle before taking the baseline, or this reads setup's own bumps as proof
    // of nothing.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const [afterConnect] = [...mgr.entries()];
    expect(afterConnect).toBeDefined();

    await new Promise((resolve) => setTimeout(resolve, 50));
    const [stillHeld] = [...mgr.entries()];
    expect(stillHeld?.lastSeenAt).toBe(afterConnect!.lastSeenAt);

    await client.close();
  });
});
