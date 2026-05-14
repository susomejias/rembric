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

  it('emits scope-aware instructions in the initialize result', async () => {
    // Unscoped /mcp connection — instructions point at project.use.
    const globalClient = await connect();
    const globalInstructions = globalClient.getInstructions();
    expect(globalInstructions).toMatch(/project\.use/);
    expect(globalInstructions).not.toContain('X-Rembric-Project');
    expect((globalInstructions ?? '').length).toBeLessThanOrEqual(800);
    await globalClient.close();

    // Path-scoped /mcp/<slug> connection — instructions name the slug.
    const projClient = await connect({ projectSlug: 'integration-proj' });
    const projInstructions = projClient.getInstructions();
    expect(projInstructions).toContain("'integration-proj'");
    expect((projInstructions ?? '').length).toBeLessThanOrEqual(800);
    await projClient.close();
  });

  it('lists the four memory.* tools', async () => {
    const client = await connect();
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    // The four legacy memory tools must remain present; new tools are
    // verified separately by name.
    expect(names).toEqual(
      expect.arrayContaining(['memory.confirm', 'memory.get', 'memory.save', 'memory.search']),
    );
    expect(names).toEqual(
      expect.arrayContaining([
        'memory.session_start',
        'memory.session_end',
        'memory.session_summary',
        'memory.context',
        'memory.timeline',
        'memory.capture_passive',
        'memory.doctor',
        'memory.stats',
        'project.use',
        'project.list',
        'project.current',
      ]),
    );
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

  it('session lifecycle: start → save (stamps session_id) → summary → context returns it', async () => {
    const client = await connect();

    // 1. Start a session.
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'wiring the lifecycle test' },
    })) as ToolResult;
    expect(started.isError).toBeFalsy();
    const startedPayload = readJson(started) as { sessionId: string };
    expect(startedPayload.sessionId).toMatch(/^[0-9A-Z]+$/);

    // 2. Save a memory; server should auto-stamp session_id.
    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'feedback',
        content: 'lifecycle-saved-row',
      },
    })) as ToolResult;
    expect(saved.isError).toBeFalsy();
    const savedPayload = readJson(saved) as { id: string };

    // 3. Summarise the session.
    const summarised = (await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: wire test. Accomplished: done.' },
    })) as ToolResult;
    expect(summarised.isError).toBeFalsy();

    // 4. memory.context should include the session as recent.
    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 5, memories: 5 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; summary: string | null; status: string }[];
      recentMemories: { id: string }[];
    };
    const seenSession = ctxPayload.recentSessions.find((s) => s.id === startedPayload.sessionId);
    expect(seenSession?.status).toBe('ended');
    expect(seenSession?.summary).toMatch(/wire test/);
    expect(ctxPayload.recentMemories.some((m) => m.id === savedPayload.id)).toBe(true);

    await client.close();
  });

  it('memory.doctor returns the expected JSON shape', async () => {
    const client = await connect();
    const result = (await client.callTool({
      name: 'memory.doctor',
      arguments: {},
    })) as ToolResult;
    expect(result.isError).toBeFalsy();
    const payload = readJson(result) as {
      db: { open: boolean; journalMode: string; integrity: string; sizeBytes: number };
      llm: { reachable: boolean; lastPingAt: string | null };
      embeddings: { enabled: boolean; backlog: number };
      consolidation: { lastRunAt: string | null; lastRunOps: Record<string, number> };
      sessions: { active: number };
      warnings: string[];
    };
    expect(payload.db.open).toBe(true);
    expect(payload.db.journalMode).toMatch(/wal/i);
    expect(payload.db.integrity).toMatch(/ok/i);
    expect(typeof payload.db.sizeBytes).toBe('number');
    expect(typeof payload.llm.reachable).toBe('boolean');
    expect(typeof payload.embeddings.enabled).toBe('boolean');
    expect(Array.isArray(payload.warnings)).toBe(true);
    await client.close();
  });

  it('memory.save without session_start succeeds and the row has session_id = null', async () => {
    const client = await connect();
    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'feedback',
        content: 'no-session-row-marker',
      },
    })) as ToolResult;
    expect(saved.isError).toBeFalsy();
    const savedPayload = readJson(saved) as { id: string };

    const got = (await client.callTool({
      name: 'memory.get',
      arguments: { id: savedPayload.id },
    })) as ToolResult;
    expect(got.isError).toBeFalsy();
    // Server side: the row is present and the timeline tool falls back to
    // the time-window mode since session_id is null.
    const tl = (await client.callTool({
      name: 'memory.timeline',
      arguments: { memoryId: savedPayload.id, before: 1, after: 1 },
    })) as ToolResult;
    if (tl.isError) {
      throw new Error(`timeline failed: ${JSON.stringify(readJson(tl))}`);
    }
    const tlPayload = readJson(tl) as { fallback: string | null };
    expect(tlPayload.fallback).toBe('time_window');

    await client.close();
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
