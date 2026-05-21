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

  it('session lifecycle: start → save (stamps session_id) → summary → end → context returns it', async () => {
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

    // 3. Summarise the session (writes summary but does NOT end the session
    //    under the new contract — session stays `active`).
    const summarised = (await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: wire test. Accomplished: done.', title: 'Wire test' },
    })) as ToolResult;
    expect(summarised.isError).toBeFalsy();

    // 4. Explicitly end the session — sole transition path.
    const ended = (await client.callTool({
      name: 'memory.session_end',
      arguments: {},
    })) as ToolResult;
    expect(ended.isError).toBeFalsy();

    // 5. memory.context should include the session as recent and `ended`.
    //    The session was anchored to a saved memory AND received a summary,
    //    so it satisfies the `sessionHasContent` predicate and survives the
    //    content filter applied by recentForContext.
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

  it('memory.context excludes a session ended without memories or summary', async () => {
    const client = await connect();

    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'empty session' },
    })) as ToolResult;
    const startedPayload = readJson(started) as { sessionId: string };

    const ended = (await client.callTool({
      name: 'memory.session_end',
      arguments: {},
    })) as ToolResult;
    expect(ended.isError).toBeFalsy();

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string }[];
    };
    expect(ctxPayload.recentSessions.some((s) => s.id === startedPayload.sessionId)).toBe(false);

    await client.close();
  });

  it('memory.context backfills past empty sessions to return useful older ones', async () => {
    const client = await connect();

    // First: a session WITH content (will be the oldest).
    const usefulStart = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'useful session' },
    })) as ToolResult;
    const usefulPayload = readJson(usefulStart) as { sessionId: string };
    await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'feedback',
        content: 'backfill-useful-row',
      },
    });
    await client.callTool({ name: 'memory.session_end', arguments: {} });

    // Then: three empty sessions in newer-than-useful order.
    for (let i = 0; i < 3; i++) {
      await client.callTool({
        name: 'memory.session_start',
        arguments: { agent: 'rembric-test', description: `empty ${i}` },
      });
      await client.callTool({ name: 'memory.session_end', arguments: {} });
    }

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 1 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as { recentSessions: { id: string }[] };
    expect(ctxPayload.recentSessions).toHaveLength(1);
    expect(ctxPayload.recentSessions[0]?.id).toBe(usefulPayload.sessionId);

    await client.close();
  });

  it('memory.save with topic_key auto-supersedes the prior active row', async () => {
    const client = await connect();
    const first = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'project',
        content: 'auth model: JWT',
        topic_key: 'decision/auth-model',
      },
    })) as ToolResult;
    expect(first.isError).toBeFalsy();
    const firstPayload = readJson(first) as { id: string };

    const second = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'project',
        content: 'auth model: opaque tokens',
        topic_key: 'decision/auth-model',
      },
    })) as ToolResult;
    expect(second.isError).toBeFalsy();
    const secondPayload = readJson(second) as { id: string };
    expect(secondPayload.id).not.toBe(firstPayload.id);

    // The prior row should now be superseded; memory.get on it reflects that.
    const got = (await client.callTool({
      name: 'memory.get',
      arguments: { id: firstPayload.id },
    })) as ToolResult;
    const gotPayload = readJson(got) as { memory: { status: string } };
    expect(gotPayload.memory.status).toBe('superseded');

    await client.close();
  });

  it('memory.save surfaces candidates[] when similar content already exists', async () => {
    const client = await connect();
    // Plant two rows with overlapping content so the third save has
    // strong FTS5 BM25 scores.
    for (let i = 0; i < 3; i++) {
      await client.callTool({
        name: 'memory.save',
        arguments: {
          scope: 'global',
          type: 'feedback',
          content: 'fruitcake bicycle aluminum windowpane horizon',
        },
      });
    }
    // Save a near-duplicate.
    const second = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'feedback',
        content: 'fruitcake bicycle aluminum windowpane horizon',
      },
    })) as ToolResult;
    expect(second.isError).toBeFalsy();
    const payload = readJson(second) as {
      id: string;
      candidates: { judgmentId: string; targetId: string; source: 'fts' | 'vec' }[];
      judgmentRequired: boolean;
    };
    expect(payload.candidates.length).toBeGreaterThanOrEqual(1);
    expect(payload.judgmentRequired).toBe(true);
    expect(payload.candidates[0]!.source).toBe('fts');

    // Close the pending judgment via memory.judge.
    const judgmentId = payload.candidates[0]!.judgmentId;
    const judgement = (await client.callTool({
      name: 'memory.judge',
      arguments: {
        judgmentId,
        relation: 'related',
        confidence: 0.9,
        reason: 'overlapping content',
      },
    })) as ToolResult;
    expect(judgement.isError).toBeFalsy();
    const judgedPayload = readJson(judgement) as { status: string; relation: string };
    expect(judgedPayload.status).toBe('judged');
    expect(judgedPayload.relation).toBe('related');

    await client.close();
  });

  it('memory.compare records a verdict between two arbitrary memories', async () => {
    const client = await connect();
    const a = (await client.callTool({
      name: 'memory.save',
      arguments: { scope: 'global', type: 'feedback', content: 'compare-test-aaa' },
    })) as ToolResult;
    const b = (await client.callTool({
      name: 'memory.save',
      arguments: { scope: 'global', type: 'feedback', content: 'compare-test-bbb' },
    })) as ToolResult;
    const aId = (readJson(a) as { id: string }).id;
    const bId = (readJson(b) as { id: string }).id;

    const compared = (await client.callTool({
      name: 'memory.compare',
      arguments: {
        memoryIdA: aId,
        memoryIdB: bId,
        relation: 'related',
        confidence: 0.8,
        reason: 'both about compare-test',
      },
    })) as ToolResult;
    expect(compared.isError).toBeFalsy();
    const payload = readJson(compared) as { status: string; relation: string };
    expect(payload.status).toBe('judged');
    expect(payload.relation).toBe('related');

    await client.close();
  });

  it('memory.suggest_topic_key returns a deterministic family/slug', async () => {
    const client = await connect();
    const res = (await client.callTool({
      name: 'memory.suggest_topic_key',
      arguments: { type: 'project', title: 'JWT auth middleware' },
    })) as ToolResult;
    expect(res.isError).toBeFalsy();
    const payload = readJson(res) as { topic_key: string };
    expect(payload.topic_key).toMatch(/^decision\//);
    expect(payload.topic_key.length).toBeGreaterThan('decision/'.length);
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
