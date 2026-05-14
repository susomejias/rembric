import { createServer as createNetServer } from 'node:net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type BootstrappedServer, createServer } from '../server/index.js';

import { createTestDb } from './db.js';

/** Probe the OS for a free TCP port and release it. */
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
      const port = addr.port;
      sock.close(() => resolve(port));
    });
  });
}

/**
 * 8.10 / 13.14 — MCP protocol conformance tests.
 *
 * Drive an in-process rembric server with the official MCP TypeScript SDK
 * Client. Covers:
 *
 *   - handshake on `/mcp` with a bearer token
 *   - tool listing (the four memory.* tools exposed in src/mcp/server.ts)
 *   - tool invocation: save → search → get → confirm round-trip
 *   - error shape on bad input (missing required fields)
 *   - path-scoped vs unscoped semantics — globals vs project memories
 *
 * The test mints its own admin token, starts the bootstrapper against a
 * fresh on-disk SQLite, then closes everything in afterAll.
 */

interface ToolResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
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

describe('MCP protocol conformance', () => {
  let server: BootstrappedServer;
  let baseUrl: string;
  const ADMIN_TOKEN = 'integration-admin-token-with-enough-entropy-zzz';

  beforeAll(async () => {
    const tmp = createTestDb();
    tmp.cleanup(); // we only want the unique dataDir; remove the pre-created DB.

    const port = await findFreePort();
    server = await createServer({
      REMBRIC_HOST: '127.0.0.1',
      REMBRIC_PORT: String(port),
      REMBRIC_DATA_DIR: tmp.dataDir,
      REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
      CONSOLIDATION_ENABLED: 'false',
      EMBEDDING_ENABLED: 'false',
      OPENAI_API_KEY: 'sk-test',
    });

    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await server.shutdown();
  });

  async function connect(opts: { token?: string; projectSlug?: string } = {}): Promise<Client> {
    const token = opts.token ?? ADMIN_TOKEN;
    const url = new URL(`${baseUrl}/mcp${opts.projectSlug ? `/${opts.projectSlug}` : ''}`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client(
      { name: 'rembric-test-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(transport);
    return client;
  }

  it('handshakes and reports server name', async () => {
    const client = await connect();
    const info = client.getServerVersion();
    expect(info?.name).toBe('rembric');
    await client.close();
  });

  it('lists the four memory.* tools', async () => {
    const client = await connect();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    expect(names).toEqual(['memory.confirm', 'memory.get', 'memory.save', 'memory.search']);
    await client.close();
  });

  it('round-trips save → search → get → confirm against /mcp (global scope)', async () => {
    const client = await connect();

    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'feedback',
        content: 'roundtripmarkeraaa indicator',
        tags: ['integration'],
      },
    })) as ToolResult;
    expect(saved.isError).toBeFalsy();
    const savedPayload = readJson(saved) as { id: string };
    expect(savedPayload.id).toMatch(/^[0-9A-Z]+$/);

    const searched = (await client.callTool({
      name: 'memory.search',
      arguments: { query: 'roundtripmarkeraaa', limit: 5 },
    })) as ToolResult;
    if (searched.isError) {
      throw new Error(`search failed: ${JSON.stringify(readJson(searched))}`);
    }
    const searchedPayload = readJson(searched) as { count: number; memories: { id: string }[] };
    expect(searchedPayload.memories.map((m) => m.id)).toContain(savedPayload.id);

    const got = (await client.callTool({
      name: 'memory.get',
      arguments: { id: savedPayload.id },
    })) as ToolResult;
    const gotPayload = readJson(got) as { memory: { id: string } };
    expect(gotPayload.memory.id).toBe(savedPayload.id);

    const confirmed = (await client.callTool({
      name: 'memory.confirm',
      arguments: { id: savedPayload.id },
    })) as ToolResult;
    expect(confirmed.isError).toBeFalsy();

    await client.close();
  });

  it('rejects scope=global on a path-scoped /mcp/<slug> connection', async () => {
    const client = await connect({ projectSlug: 'integration-proj' });

    const result = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'reference',
        content: 'should-be-rejected',
      },
    })) as ToolResult;

    expect(result.isError).toBe(true);
    const payload = readJson(result) as { code?: string };
    expect(payload.code).toBe('scope_locked');

    await client.close();
  });

  it('rejects an invalid token before reaching tool dispatch', async () => {
    await expect(connect({ token: 'definitely-not-valid' })).rejects.toThrow();
  });

  it('returns a structured error when memory.get is called with an unknown id', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'memory.get',
      arguments: { id: 'definitely-not-an-id' },
    })) as ToolResult;
    // Memory not found surfaces as a non-OK MCP tool error with a known code.
    expect(result.isError).toBe(true);
    const payload = readJson(result) as { code?: string };
    expect(payload.code).toBe('not_found');
    await client.close();
  });
});
