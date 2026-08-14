import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTestDb } from '../test/db.js';
import { FakeEmbedder } from '../test/embedder.js';
import { findFreePort } from '../test/net.js';

import { type BootstrappedServer, createServer } from './index.js';

/**
 * mcp-api delta: "A request naming an unknown MCP session MUST be refused
 * with 404 and MUST NOT construct a server."
 */
describe('unknown mcp-session-id refusal', () => {
  let server: BootstrappedServer;
  let baseUrl: string;
  let serverConstructions: number;
  const ADMIN_TOKEN = 'unknown-session-test-admin-token-with-entropy';

  beforeAll(async () => {
    const tmp = createTestDb();
    tmp.cleanup();
    const port = await findFreePort();
    serverConstructions = 0;
    server = await createServer(
      {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: String(port),
        REMBRIC_DATA_DIR: tmp.dataDir,
        REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
      },
      { embedder: new FakeEmbedder(), onServerConstructed: () => serverConstructions++ },
    );
    baseUrl = `http://127.0.0.1:${port}/mcp`;
  }, 30_000);

  afterAll(async () => {
    await server.shutdown();
  });

  function headers(sessionId?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    };
    if (sessionId) h['mcp-session-id'] = sessionId;
    return h;
  }

  async function rpc(
    method: string,
    params: Record<string, unknown>,
    sessionId?: string,
  ): Promise<Response> {
    return fetch(baseUrl, {
      method: 'POST',
      headers: headers(sessionId),
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    });
  }

  /** The transport frames a successful response as SSE; unpack the JSON-RPC payload. */
  async function readRpcBody(res: Response): Promise<Record<string, unknown>> {
    const text = await res.text();
    const frame = text
      .split('\n')
      .find((line) => line.startsWith('data:'))
      ?.slice('data:'.length)
      .trim();
    return JSON.parse(frame ?? text) as Record<string, unknown>;
  }

  it('refuses a tools/call naming an unknown id with 404 / -32001', async () => {
    const before = serverConstructions;
    const res = await rpc('tools/list', {}, 'session-id-never-issued');
    const body = (await res.json()) as { error?: { code?: number } };
    expect(res.status).toBe(404);
    expect(body.error?.code).toBe(-32001);
    expect(serverConstructions).toBe(before);
  });

  it('constructs zero servers across several unknown-id requests', async () => {
    const before = serverConstructions;
    for (let i = 0; i < 5; i++) {
      await rpc('tools/list', {}, `unknown-id-${i}`);
    }
    expect(serverConstructions).toBe(before);
  });

  it('an initialize request still establishes a session, even carrying a stale id', async () => {
    const before = serverConstructions;
    const res = await rpc(
      'initialize',
      {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'stale-id-client', version: '0' },
      },
      'a-session-id-that-was-never-issued',
    );
    expect(res.status).toBe(200);
    expect(serverConstructions).toBe(before + 1);
    const newSessionId = res.headers.get('mcp-session-id');
    expect(newSessionId).toBeTruthy();

    const follow = await rpc('tools/list', {}, newSessionId ?? undefined);
    expect(follow.status).toBe(200);
  });

  it('a known session is served exactly as before this change', async () => {
    const init = await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'known-id-client', version: '0' },
    });
    const sessionId = init.headers.get('mcp-session-id');
    expect(sessionId).toBeTruthy();

    const res = await rpc('tools/list', {}, sessionId ?? undefined);
    expect(res.status).toBe(200);
    const body = (await readRpcBody(res)) as { result?: { tools?: unknown[] } };
    expect(Array.isArray(body.result?.tools)).toBe(true);
  });
});
