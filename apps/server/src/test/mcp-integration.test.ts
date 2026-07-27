import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListRootsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createRepositories } from '../db/repositories/index.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { DESCRIPTION_MAX_LENGTH } from '../mcp/server.js';
import { type BootstrappedServer, createServer } from '../server/index.js';
import { SUMMARY_MAX_CHARS } from '../services/agent-sessions.js';
import { ProjectsService } from '../services/projects.js';
import { TokensService } from '../services/tokens.js';

import { createTestDb } from './db.js';
import { FakeEmbedder } from './embedder.js';

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
    server = await createServer(
      {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: String(port),
        REMBRIC_DATA_DIR: tmp.dataDir,
        REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
      },
      { embedder: new FakeEmbedder() },
    );

    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await server.shutdown();
  });

  async function connect(
    opts: { token?: string; projectSlug?: string; rootUri?: string } = {},
  ): Promise<Client> {
    const token = opts.token ?? ADMIN_TOKEN;
    const url = new URL(`${baseUrl}/mcp${opts.projectSlug ? `/${opts.projectSlug}` : ''}`);
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    });
    const client = new Client(
      { name: 'rembric-test-client', version: '0.0.0' },
      { capabilities: opts.rootUri ? { roots: {} } : {} },
    );
    if (opts.rootUri) {
      const rootUri = opts.rootUri;
      client.setRequestHandler(ListRootsRequestSchema, () => ({
        roots: [{ uri: rootUri, name: rootUri }],
      }));
    }
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
    expect((globalInstructions ?? '').length).toBeLessThanOrEqual(1000);
    await globalClient.close();

    // Path-scoped /mcp/<slug> connection — instructions name the slug.
    const projClient = await connect({ projectSlug: 'integration-proj' });
    const projInstructions = projClient.getInstructions();
    expect(projInstructions).toContain("'integration-proj'");
    expect((projInstructions ?? '').length).toBeLessThanOrEqual(1000);
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

  it('memory.search description teaches recall, hybrid ranking, and the widen affordance', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const search = tools.find((t) => t.name === 'memory.search');
    const desc = search?.description ?? '';

    // Recall trigger (existing protocol-teaching contract).
    expect(desc).toMatch(/recall|remember|recuerda/i);
    // Hybrid semantic + keyword ranking is advertised (not the stale "FTS5 keyword search").
    expect(desc).toMatch(/hybrid/i);
    expect(desc).toMatch(/semantic/i);
    // Widen affordance: small default page, raise limit or page with offset.
    expect(desc).toMatch(/limit/i);
    expect(desc).toMatch(/offset/i);

    await client.close();
  });

  it('memory.archive description steers against autonomous retirement', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const archive = tools.find((t) => t.name === 'memory.archive');
    const desc = archive?.description ?? '';

    // Gated on explicit user request to retire/remove/forget.
    expect(desc).toMatch(/explicit/i);
    expect(desc).toMatch(/retire|remove|forget/i);
    // Prefer supersede when a replacement exists (no-successor path).
    expect(desc).toMatch(/supersede/i);
    expect(desc).toMatch(/topic_key/i);
    // No autonomous cleanup during recall/save.
    expect(desc).toMatch(/autonomous|cleanup|housekeeping/i);
    // Reversible from the dashboard.
    expect(desc).toMatch(/revers|undo/i);
    expect(desc).toMatch(/dashboard/i);

    await client.close();
  });

  it('memory.session_summary description matches the schema hard limit', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    const sessionSummary = tools.find((t) => t.name === 'memory.session_summary');
    const desc = sessionSummary?.description ?? '';
    const schema = sessionSummary?.inputSchema as
      | { properties?: { summary?: { maxLength?: number } } }
      | undefined;

    expect(schema?.properties?.summary?.maxLength).toBe(SUMMARY_MAX_CHARS);
    expect(desc).toContain(String(SUMMARY_MAX_CHARS));
    expect(desc).not.toContain('2000');

    await client.close();
  });

  it('keeps every tool description under the client truncation ceiling', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    await client.close();

    // Derived from the whole response, so a newly registered tool inherits the
    // guard; the floor stops an empty listing passing vacuously.
    const measured = tools.map((t) => ({ name: t.name, length: (t.description ?? '').length }));
    expect(measured.length, 'tools/list returned fewer tools than expected').toBeGreaterThanOrEqual(
      23,
    );

    const over = measured.filter((m) => m.length > DESCRIPTION_MAX_LENGTH);
    expect(
      over,
      `description(s) over DESCRIPTION_MAX_LENGTH=${DESCRIPTION_MAX_LENGTH}: ` +
        `${over.map((m) => `${m.name} is ${m.length} chars`).join(', ')}. ` +
        'Claude Code tail-cuts at 2048 chars, dropping the END of the description first. ' +
        'Reword to fit, or raise the cap deliberately keeping a margin below the ' +
        're-verified client ceiling (mcp-api: "Tool descriptions MUST stay below the ' +
        'client truncation ceiling").',
    ).toEqual([]);

    // Pins the GUARD's unit, not the string's: `memory.save`'s description holds
    // `∈`, `·` and `≤`, so measuring bytes would report a different number, and
    // an earlier exploration did exactly that while labelling it characters.
    const save = tools.find((t) => t.name === 'memory.save')?.description ?? '';
    const savesMeasured = measured.find((m) => m.name === 'memory.save')?.length;
    expect(savesMeasured).toBe(save.length);
    expect(savesMeasured).not.toBe(Buffer.byteLength(save, 'utf8'));
  });

  it('advertises behavioral annotations consistent with the append-only/closed-store invariants', async () => {
    // Read tools never mutate. Every Rembric tool is non-destructive (rows are
    // never deleted; supersede is a reversible status flip) and closed-world
    // (single local store) — so destructiveHint/openWorldHint are false for ALL
    // tools. The name sets below are exhaustive against the registered tools;
    // a newly-registered tool with no entry fails the partition assertion.
    const READ_TOOLS = new Set([
      'memory.search',
      'memory.get',
      'memory.context',
      'memory.session_get',
      'memory.timeline',
      'memory.search_prompts',
      'memory.doctor',
      'memory.about',
      'memory.stats',
      'memory.suggest_topic_key',
      'project.list',
      'project.current',
    ]);
    const WRITE_TOOLS = new Set([
      'memory.save',
      'memory.confirm',
      'memory.archive',
      'memory.capture_passive',
      'memory.save_prompt',
      'memory.session_start',
      'memory.session_summary',
      'memory.session_end',
      'memory.judge',
      'memory.compare',
      'project.use',
    ]);

    const client = await connect();
    const { tools } = await client.listTools();

    // Every registered tool is partitioned into exactly one of the two sets —
    // catches an un-annotated new tool.
    const registered = tools.map((t) => t.name).sort();
    expect(registered).toEqual([...READ_TOOLS, ...WRITE_TOOLS].sort());

    for (const tool of tools) {
      const ann = tool.annotations;
      expect(ann, `${tool.name} must declare annotations`).toBeDefined();
      expect(ann?.destructiveHint, `${tool.name} destructiveHint`).toBe(false);
      expect(ann?.openWorldHint, `${tool.name} openWorldHint`).toBe(false);
      expect(typeof ann?.title, `${tool.name} title`).toBe('string');
      expect(ann?.readOnlyHint, `${tool.name} readOnlyHint`).toBe(READ_TOOLS.has(tool.name));
    }

    await client.close();
  });

  it('every tool advertises an outputSchema', async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.outputSchema, `${tool.name} must declare an outputSchema`).toBeDefined();
    }
    await client.close();
  });

  it('returns conforming structuredContent for the tools not exercised elsewhere', async () => {
    // The SDK validates structuredContent against the registered outputSchema
    // on every call, so a non-throwing call with structuredContent present IS
    // the schema conformance test. The save→search→get→confirm/context/session/
    // timeline/judge/compare/doctor/suggest_topic_key paths are covered by other
    // tests in this file; this fills the gap for the rest.
    const client = await connect();

    const about = await client.callTool({ name: 'memory.about', arguments: {} });
    expect(about.structuredContent).toBeDefined();

    const stats = await client.callTool({ name: 'memory.stats', arguments: {} });
    expect(stats.structuredContent).toBeDefined();

    const savePrompt = await client.callTool({
      name: 'memory.save_prompt',
      arguments: { content: 'a goal worth remembering', title: 'goal' },
    });
    expect(savePrompt.structuredContent).toBeDefined();

    const searchPrompts = await client.callTool({
      name: 'memory.search_prompts',
      arguments: { query: 'goal' },
    });
    expect(searchPrompts.structuredContent).toBeDefined();

    const capture = await client.callTool({
      name: 'memory.capture_passive',
      arguments: { text: '## Key Learnings:\n- first learning\n- second learning\n' },
    });
    expect(capture.structuredContent).toBeDefined();

    const use = await client.callTool({
      name: 'project.use',
      arguments: { slug: 'outputschema-proj', autocreate: true },
    });
    expect(use.structuredContent).toBeDefined();

    const list = await client.callTool({ name: 'project.list', arguments: {} });
    expect(list.structuredContent).toBeDefined();

    const current = await client.callTool({ name: 'project.current', arguments: {} });
    expect(current.structuredContent).toBeDefined();

    await client.close();
  });

  it('round-trips save → search → get → confirm against /mcp (global scope)', async () => {
    const client = await connect();

    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'feedback',
        title: 'roundtrip marker indicator',
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
        title: 'should be rejected',
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
        title: 'lifecycle saved row',
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

  it('memory.context caps recentMemories at the default of 10 when no size arg is given', async () => {
    const client = await connect();
    for (let i = 0; i < 12; i++) {
      await client.callTool({
        name: 'memory.save',
        arguments: {
          scope: 'global',
          type: 'project',
          title: `ctx default cap marker ${i}`,
          content: `ctx-default-cap-marker-${i}`,
        },
      });
    }
    const ctx = (await client.callTool({ name: 'memory.context', arguments: {} })) as ToolResult;
    const payload = readJson(ctx) as { recentMemories: unknown[]; clamped: boolean };
    expect(payload.recentMemories.length).toBeLessThanOrEqual(10);
    expect(payload.clamped).toBe(false);
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
        title: 'backfill useful row',
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

  // Snippet tests run in global scope and END their session before closing.
  // session_start resumes the transport's active session, and a lingering
  // active session would pollute the global auto-stamp used by later tests —
  // so each test cleans up. end() does not auto-curate a summary, so the
  // null-summary case stays null after ending.
  it('memory.context truncates a long session summary to ≤350 chars while storage stays full', async () => {
    const client = await connect();

    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'long summary session' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    const fullSummary = `Goal: ${'x'.repeat(600)}`; // 606 chars, under the write cap, over the 350 display bound
    const summarised = (await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: fullSummary, title: 'Long' },
    })) as ToolResult;
    expect(summarised.isError).toBeFalsy();

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; summary: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen?.summary).not.toBeNull();
    expect(seen?.summary?.length).toBeLessThanOrEqual(350);
    expect(seen?.summary?.endsWith('…')).toBe(true);

    // Storage is unaffected: the row still holds the full, untruncated summary.
    const stored = createRepositories(server.dbHandle.db).agentSessions.getById(sessionId);
    expect(stored?.summary).toBe(fullSummary);

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.context returns a short session summary verbatim (no ellipsis)', async () => {
    const client = await connect();

    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'short summary session' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    const shortSummary = 'Goal: short session. Accomplished: nothing notable.';
    await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: shortSummary },
    });

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; summary: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen?.summary).toBe(shortSummary);
    expect(seen?.summary?.endsWith('…')).toBe(false);

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.context emits null for a content-bearing session with no summary', async () => {
    const client = await connect();

    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'no-summary session' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    // Anchor a memory so the session is content-bearing without a summary.
    // memory.save auto-stamps the active session_id, so no summary is written.
    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'feedback',
        title: 'anchor row, no session summary',
        content: 'anchor row, no session summary',
      },
    })) as ToolResult;
    expect(saved.isError).toBeFalsy();

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; summary: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen).toBeDefined();
    expect(seen?.summary).toBeNull();

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.context surfaces a session title verbatim and untruncated', async () => {
    const client = await connect();
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'titled session' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    const title = 'T'.repeat(100); // max title length — proves it is emitted whole, never snippet-truncated
    await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: titled session test.', title },
    });

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; title: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen?.title).toBe(title);

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.context suppresses an uncurated (placeholder) session title as null', async () => {
    const client = await connect();
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'untitled session' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    // Content-bearing via an anchored memory; never summarized with a title → titleFinal stays
    // false, so the placeholder title must not leak into agent-facing context.
    await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'feedback',
        title: 'anchor row, placeholder title',
        content: 'anchor row, placeholder title',
      },
    });

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; title: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen).toBeDefined();
    expect(seen?.title).toBeNull();

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.context suppresses a raw (uncurated) session summary even when the session is content-bearing via another clause', async () => {
    const client = await connect();
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'raw-summary session' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    // Content-bearing via an anchored memory, not via a curated summary.
    await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'feedback',
        title: 'anchor row, raw summary',
        content: 'anchor row, raw summary',
      },
    });

    // A per-turn raw sync (summary_final=0), never curated.
    server.dbHandle.db
      .update(agentSessions)
      .set({ summary: 'raw transcript dump, never curated', summaryFinal: false })
      .where(eq(agentSessions.id, sessionId))
      .run();

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; summary: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen).toBeDefined();
    expect(seen?.summary).toBeNull();

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.session_get returns the FULL summary while memory.context returns a snippet', async () => {
    const client = await connect();

    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'session_get full summary' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };

    const fullSummary = `Goal: ${'y'.repeat(700)}`; // over the 350 snippet bound, under the 10000 cap
    await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: fullSummary },
    });

    // memory.context truncates to the snippet bound...
    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: { sessions: 25 },
    })) as ToolResult;
    const ctxPayload = readJson(ctx) as {
      recentSessions: { id: string; summary: string | null }[];
    };
    const seen = ctxPayload.recentSessions.find((s) => s.id === sessionId);
    expect(seen?.summary?.length).toBeLessThanOrEqual(350);

    // ...while memory.session_get returns the full, untruncated summary.
    const got = (await client.callTool({
      name: 'memory.session_get',
      arguments: { sessionId },
    })) as ToolResult;
    expect(got.isError).toBeFalsy();
    const gotPayload = readJson(got) as { id: string; summary: string | null };
    expect(gotPayload.id).toBe(sessionId);
    expect(gotPayload.summary).toBe(fullSummary);

    await client.callTool({ name: 'memory.session_end', arguments: {} });
    await client.close();
  });

  it('memory.session_get returns not_found for a cross-scope session', async () => {
    // Create the project directly on the shared DB (single better-sqlite3
    // connection) so the path-scoped connection resolves ctx.project to it.
    const projects = new ProjectsService(createRepositories(server.dbHandle.db));
    projects.create({ slug: 'getsession-proj' });

    // Start a session INSIDE the project (path-scoped → project scope).
    const pinned = await connect({ projectSlug: 'getsession-proj' });
    const started = (await pinned.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'project-scoped session' },
    })) as ToolResult;
    const startedPayload = readJson(started) as { sessionId: string; scope: string };
    const { sessionId } = startedPayload;
    // Guard: confirm the session really is project-scoped (not global).
    expect(startedPayload.scope).toBe('project');
    await pinned.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: lives in a project.' },
    });
    // In-scope session_get finds it.
    const inScope = (await pinned.callTool({
      name: 'memory.session_get',
      arguments: { sessionId },
    })) as ToolResult;
    expect(inScope.isError).toBeFalsy();
    await pinned.callTool({ name: 'memory.session_end', arguments: {} });
    await pinned.close();

    // Fetch from global scope → the project session is out of scope.
    const globalClient = await connect();
    const got = (await globalClient.callTool({
      name: 'memory.session_get',
      arguments: { sessionId },
    })) as ToolResult;
    expect(got.isError).toBe(true);
    expect((readJson(got) as { code?: string }).code).toBe('not_found');
    await globalClient.close();
  });

  it('memory.session_get returns not_found for a soft-deleted session', async () => {
    const client = await connect();
    const started = (await client.callTool({
      name: 'memory.session_start',
      arguments: { agent: 'rembric-test', description: 'soon-deleted session' },
    })) as ToolResult;
    const { sessionId } = readJson(started) as { sessionId: string };
    await client.callTool({
      name: 'memory.session_summary',
      arguments: { summary: 'Goal: about to be soft-deleted.' },
    });

    // Soft-delete the row directly (operator action; no agent-facing tool).
    server.dbHandle.db
      .update(agentSessions)
      .set({ deletedAt: new Date() })
      .where(eq(agentSessions.id, sessionId))
      .run();

    const got = (await client.callTool({
      name: 'memory.session_get',
      arguments: { sessionId },
    })) as ToolResult;
    expect(got.isError).toBe(true);
    expect((readJson(got) as { code?: string }).code).toBe('not_found');
    await client.close();
  });

  it('memory.save with topic_key auto-supersedes the prior active row', async () => {
    const client = await connect();
    const first = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'project',
        title: 'auth model: JWT',
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
        title: 'auth model: opaque tokens',
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

    // include_relations co-surfaces the successor as an `expanded` entry.
    const searched = (await client.callTool({
      name: 'memory.search',
      arguments: {
        query: 'auth model JWT',
        status: 'superseded',
        include_relations: true,
      },
    })) as ToolResult;
    expect(searched.isError).toBeFalsy();
    const searchedPayload = readJson(searched) as {
      memories: { id: string }[];
      expanded?: { id: string; expandedFrom: string; relationKind: string }[];
    };
    expect(searchedPayload.memories.map((m) => m.id)).toContain(firstPayload.id);
    const head = searchedPayload.expanded?.find((e) => e.expandedFrom === firstPayload.id);
    expect(head?.id).toBe(secondPayload.id);
    expect(head?.relationKind).toBe('superseded_by');

    // Without include_relations, the response carries no `expanded` field.
    const searchedNoExpand = (await client.callTool({
      name: 'memory.search',
      arguments: { query: 'auth model JWT', status: 'superseded' },
    })) as ToolResult;
    const noExpandPayload = readJson(searchedNoExpand) as { expanded?: unknown };
    expect(noExpandPayload.expanded).toBeUndefined();

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
          title: 'fruitcake bicycle aluminum',
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
        title: 'fruitcake bicycle aluminum',
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
    // The harness embedder is always warm, so the identical-content match
    // arrives through the vec pass (embedNow gives the new row its vector
    // before detection; vec wins ties over fts).
    expect(payload.candidates[0]!.source).toBe('vec');

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
      arguments: {
        scope: 'global',
        type: 'feedback',
        title: 'compare test aaa',
        content: 'compare-test-aaa',
      },
    })) as ToolResult;
    const b = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'feedback',
        title: 'compare test bbb',
        content: 'compare-test-bbb',
      },
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
      embeddings: { model: string; backlog: number };
      consolidation: { lastRunAt: string | null; lastRunOps: Record<string, number> };
      sessions: { active: number };
      review: { needsReview: number; pendingJudgments: number };
      warnings: string[];
    };
    expect(payload.db.open).toBe(true);
    expect(payload.db.journalMode).toMatch(/wal/i);
    expect(payload.db.integrity).toMatch(/ok/i);
    expect(typeof payload.db.sizeBytes).toBe('number');
    // The llm block was removed by `remove-llm-consolidation`.
    expect('llm' in payload).toBe(false);
    expect(payload.embeddings.model).toContain('gte-multilingual-base');
    expect('enabled' in payload.embeddings).toBe(false);
    expect(typeof payload.review.needsReview).toBe('number');
    expect(typeof payload.review.pendingJudgments).toBe('number');
    expect(Array.isArray(payload.warnings)).toBe(true);
    await client.close();
  });

  // memory.archive journals a `maintenance` run whose summary carries a `kind`
  // string next to the counters, so a doctor output contract that admits only
  // numbers makes the tool fail from the first archive onwards.
  it('memory.doctor passes output validation after an archive has been journaled', async () => {
    const client = await connect();
    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'feedback',
        title: 'doctor after archive',
        content: 'doctor-after-archive-marker',
      },
    })) as ToolResult;
    expect(saved.isError).toBeFalsy();

    const archived = (await client.callTool({
      name: 'memory.archive',
      arguments: { id: (readJson(saved) as { id: string }).id },
    })) as ToolResult;
    expect(archived.isError).toBeFalsy();

    const result = (await client.callTool({
      name: 'memory.doctor',
      arguments: {},
    })) as ToolResult;
    if (result.isError) {
      throw new Error(`memory.doctor failed after an archive: ${JSON.stringify(readJson(result))}`);
    }
    const payload = readJson(result) as {
      consolidation: { lastRunAt: string | null; lastRunOps: Record<string, unknown> };
    };
    expect(payload.consolidation.lastRunOps).toEqual({
      kind: 'agent_memory_archive',
      archived: 1,
    });
    expect(payload.consolidation.lastRunAt).toBeTruthy();
    await client.close();
  });

  it('memory.save without session_start succeeds and the row has session_id = null', async () => {
    const client = await connect();
    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'feedback',
        title: 'no session row marker',
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
  // NOTE: runs after the candidates[] test — the FTS similarity proxy
  // (1/(1+|bm25|)) is corpus-size sensitive, so saves made here would
  // shift BM25 IDF for earlier saves. Recalibrated in change B.
  it('memory.context exposes aged pending judgments and memory.judge clears them', async () => {
    const client = await connect();

    const saveOne = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'feedback',
        title: 'pending source marker',
        content: 'pending-source-marker',
      },
    })) as ToolResult;
    const saveTwo = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'feedback',
        title: 'pending target marker',
        content: 'pending-target-marker',
      },
    })) as ToolResult;
    const sourceId = (readJson(saveOne) as { id: string }).id;
    const targetId = (readJson(saveTwo) as { id: string }).id;

    // Aged pending (2 days > JUDGMENT_ORPHAN_AFTER_MS default 24h) and a
    // fresh one; only the aged row may surface.
    const insert = server.dbHandle.raw.prepare(
      `INSERT INTO memory_relations (id, judgment_id, source_id, target_id, status, created_at)
       VALUES (?, ?, ?, ?, 'pending', ?)`,
    );
    insert.run(
      '01TESTRELAGED000000000000A',
      'jdg-aged-itest',
      sourceId,
      targetId,
      Date.now() - 2 * 86_400_000,
    );
    insert.run('01TESTRELFRESH00000000000B', 'jdg-fresh-itest', targetId, sourceId, Date.now());

    const ctx = (await client.callTool({
      name: 'memory.context',
      arguments: {},
    })) as ToolResult;
    const payload = readJson(ctx) as {
      pendingJudgments: {
        judgmentId: string;
        sourceSnippet: string;
        targetSnippet: string;
        ageMs: number;
      }[];
    };
    expect(payload.pendingJudgments).toHaveLength(1);
    expect(payload.pendingJudgments[0]?.judgmentId).toBe('jdg-aged-itest');
    expect(payload.pendingJudgments[0]?.sourceSnippet).toContain('pending-source-marker');
    expect(payload.pendingJudgments[0]?.targetSnippet).toContain('pending-target-marker');
    expect(payload.pendingJudgments[0]?.ageMs).toBeGreaterThan(86_400_000);

    const judged = (await client.callTool({
      name: 'memory.judge',
      arguments: {
        judgmentId: 'jdg-aged-itest',
        relation: 'not_conflict',
        reason: 'integration cleanup',
      },
    })) as ToolResult;
    expect(judged.isError).toBeFalsy();

    const ctxAfter = (await client.callTool({
      name: 'memory.context',
      arguments: {},
    })) as ToolResult;
    const after = readJson(ctxAfter) as { pendingJudgments: unknown[] };
    expect(after.pendingJudgments).toHaveLength(0);

    await client.close();
  });

  it('memory.context surfaces needsReview, search/get expose reviewState, confirm clears it', async () => {
    const client = await connect();

    const saved = (await client.callTool({
      name: 'memory.save',
      arguments: {
        scope: 'global',
        type: 'project',
        title: 'needs review marker goal',
        content: 'needsreviewmarkeraaa goal',
      },
    })) as ToolResult;
    const id = (readJson(saved) as { id: string }).id;

    // Age it past the `project` shelf life (3 months) via created_at.
    server.dbHandle.raw
      .prepare(`UPDATE memory SET created_at = ? WHERE id = ?`)
      .run(Date.now() - 100 * 86_400_000, id);

    const ctx = (await client.callTool({ name: 'memory.context', arguments: {} })) as ToolResult;
    const payload = readJson(ctx) as {
      needsReview: {
        id: string;
        type: string;
        snippet: string;
        reviewAfter: string;
        ageMs: number;
      }[];
      pendingJudgments: { judgmentId: string }[];
      needsReviewTotal: number;
    };
    expect(payload.needsReview).toHaveLength(1);
    expect(payload.needsReview[0]?.id).toBe(id);
    expect(payload.needsReview[0]?.snippet).toContain('needsreviewmarkeraaa');
    expect(payload.needsReview[0]?.ageMs).toBeGreaterThan(0);
    expect(typeof payload.needsReview[0]?.reviewAfter).toBe('string');
    // Unary needsReview is disjoint from pairwise pendingJudgments.
    expect(payload.pendingJudgments).toHaveLength(0);
    expect(payload.needsReviewTotal).toBe(1);

    const searched = (await client.callTool({
      name: 'memory.search',
      arguments: { query: 'needsreviewmarkeraaa' },
    })) as ToolResult;
    const sPayload = readJson(searched) as { memories: { id: string; reviewState?: string }[] };
    expect(sPayload.memories.find((m) => m.id === id)?.reviewState).toBe('needs_review');

    const got = (await client.callTool({ name: 'memory.get', arguments: { id } })) as ToolResult;
    expect((readJson(got) as { reviewState?: string }).reviewState).toBe('needs_review');

    const confirmed = (await client.callTool({
      name: 'memory.confirm',
      arguments: { id },
    })) as ToolResult;
    expect(confirmed.isError).toBeFalsy();

    const ctxAfter = (await client.callTool({
      name: 'memory.context',
      arguments: {},
    })) as ToolResult;
    expect(
      (readJson(ctxAfter) as { needsReview: unknown[]; needsReviewTotal: number }).needsReviewTotal,
    ).toBe(0);
    expect((readJson(ctxAfter) as { needsReview: unknown[] }).needsReview).toHaveLength(0);

    await client.close();
  });

  it('memory.stats totals (needsReviewTotal, pendingJudgmentsTotal) are scope-isolated (task 5.3)', async () => {
    // Two fresh, never-before-used project slugs: the shared global scope
    // accumulates state across every `it()` in this file, so isolation can
    // only be asserted against scopes nothing else has touched.
    const projA = await connect({ projectSlug: 'stats-totals-proj-a' });
    const projB = await connect({ projectSlug: 'stats-totals-proj-b' });
    await projA.callTool({
      name: 'project.use',
      arguments: { slug: 'stats-totals-proj-a', autocreate: true },
    });
    await projB.callTool({
      name: 'project.use',
      arguments: { slug: 'stats-totals-proj-b', autocreate: true },
    });

    const saveOne = (await projA.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'stats totals source marker',
        content: 'stats-totals-source-marker',
      },
    })) as ToolResult;
    const saveTwo = (await projA.callTool({
      name: 'memory.save',
      arguments: {
        type: 'feedback',
        title: 'stats totals target marker',
        content: 'stats-totals-target-marker',
      },
    })) as ToolResult;
    const sourceId = (readJson(saveOne) as { id: string }).id;
    const targetId = (readJson(saveTwo) as { id: string }).id;

    server.dbHandle.raw
      .prepare(
        `INSERT INTO memory_relations (id, judgment_id, source_id, target_id, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .run('01TESTRELSTATS0000000000A', 'jdg-stats-itest', sourceId, targetId, Date.now());

    const statsA = (await projA.callTool({ name: 'memory.stats', arguments: {} })) as ToolResult;
    const statsAPayload = readJson(statsA) as {
      needsReviewTotal: number;
      pendingJudgmentsTotal: number;
    };
    expect(statsAPayload.pendingJudgmentsTotal).toBe(1);
    expect(statsAPayload.needsReviewTotal).toBe(0);

    // A different, untouched project scope sees neither the pending relation
    // nor any review debt.
    const statsB = (await projB.callTool({ name: 'memory.stats', arguments: {} })) as ToolResult;
    const statsBPayload = readJson(statsB) as {
      needsReviewTotal: number;
      pendingJudgmentsTotal: number;
    };
    expect(statsBPayload.pendingJudgmentsTotal).toBe(0);
    expect(statsBPayload.needsReviewTotal).toBe(0);

    await projA.close();
    await projB.close();
  });

  // Regression coverage for enforce-mcp-authorization: every scope-sensitive
  // tool (not just save/search/get/confirm) now shares the async,
  // roots-discovery-aware resolver, so the FIRST call on a fresh transport
  // sees the same project scope a later call would.
  //
  // retry: discovery is an async `listRoots()` SSE round trip on a bounded
  // budget; on a slow, coverage-instrumented CI runner it can occasionally
  // exceed the budget and fall back to global. Correct behavior on a settled
  // transport — each retry reconnects (fresh discovery) after startup
  // contention (e.g. the boot-time embedding drain) has cleared.
  it(
    'memory.context as the FIRST call on an unscoped connection with a discoverable root returns project scope',
    { retry: 3 },
    async () => {
      // Fixtures created once: `retry` re-runs this body, so a re-`create`
      // would hit UNIQUE(slug)/PK and mask the real (timing) retry.
      const repos = createRepositories(server.dbHandle.db);
      const projectsSvc = new ProjectsService(repos);
      let project = projectsSvc.findBySlug('integration-roots-ctx-proj');
      if (!project) {
        project = projectsSvc.create({ slug: 'integration-roots-ctx-proj' });
        repos.memory.insert({
          id: '01TESTROOTSCTXMARKER00000A',
          scope: 'project',
          projectId: project.id,
          type: 'project',
          title: 'roots-discovered context marker',
          content: 'roots-discovered context marker',
          tags: [],
          status: 'active',
          replaces: [],
          createdAt: new Date(),
          lastSeenAt: new Date(),
        });
      }

      const client = await connect({ rootUri: `file:///tmp/${project.slug}` });
      const ctx = (await client.callTool({ name: 'memory.context', arguments: {} })) as ToolResult;
      expect(ctx.isError).toBeFalsy();
      const payload = readJson(ctx) as { scope: string; recentMemories: { snippet: string }[] };
      expect(payload.scope).toBe(`project:${project.id}`);
      expect(
        payload.recentMemories.some((m) => m.snippet.includes('roots-discovered context marker')),
      ).toBe(true);

      await client.close();
    },
  );

  // retry: same async roots-discovery round-trip dependency as the test above.
  it(
    'memory.capture_passive rejects with project_suggestion_pending when roots surface an unminted slug',
    { retry: 3 },
    async () => {
      const client = await connect({ rootUri: 'file:///tmp/integration-unminted-slug' });
      const result = (await client.callTool({
        name: 'memory.capture_passive',
        arguments: { text: '## Key Learnings:\n- must not be saved silently to global\n' },
      })) as ToolResult;
      expect(result.isError).toBe(true);
      const payload = readJson(result) as { code?: string; suggestedSlugs?: string[] };
      expect(payload.code).toBe('project_suggestion_pending');
      expect(payload.suggestedSlugs).toEqual(['integration-unminted-slug']);

      await client.close();
    },
  );
});

// Real-server coverage for the auth-surface hardening (change
// `harden-auth-surface`): 413 body bound, opt-in DNS-rebinding Origin
// rejection, Secure cookie on HTTPS, and the uniform login response.
//
// Kept in THIS file (not a standalone one) on purpose: it bootstraps a second
// real server, and two heavy server files running in parallel starve the MCP
// roots-discovery SSE round-trip above. Separate describes in one file run
// sequentially, so this server never coexists with the one above.
describe('HTTP hardening (real server)', () => {
  let server: BootstrappedServer;
  let baseUrl: string;
  const ADMIN_TOKEN = 'hardening-admin-token-with-enough-entropy-yy';

  beforeAll(async () => {
    const tmp = createTestDb();
    tmp.cleanup();
    const port = await findFreePort();
    server = await createServer(
      {
        REMBRIC_HOST: '127.0.0.1',
        REMBRIC_PORT: String(port),
        REMBRIC_DATA_DIR: tmp.dataDir,
        REMBRIC_ADMIN_TOKEN: ADMIN_TOKEN,
        // HTTPS issuer → Secure cookies + OAuth enabled.
        REMBRIC_PUBLIC_URL: 'https://rembric.example.com',
        // Smallest allowed body cap (64 KiB) so an oversized POST is cheap.
        MAX_BODY_BYTES: String(64 * 1024),
        // Opt-in DNS-rebinding: allow the loopback host + one origin.
        REMBRIC_MCP_ALLOWED_HOSTS: `127.0.0.1:${port}`,
        REMBRIC_MCP_ALLOWED_ORIGINS: 'https://good.example',
      },
      { embedder: new FakeEmbedder() },
    );
    baseUrl = `http://127.0.0.1:${port}`;
  }, 30_000);

  afterAll(async () => {
    await server?.shutdown();
  });

  function rawPost(path: string, headers: Record<string, string>): Promise<number> {
    const u = new URL(baseUrl + path);
    const body = '{"jsonrpc":"2.0","id":1,"method":"ping"}';
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: u.hostname,
          port: Number(u.port),
          path: u.pathname,
          method: 'POST',
          headers: { ...headers, 'content-length': Buffer.byteLength(body) },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(body);
    });
  }

  it('rejects an oversized /mcp body with 413 (after auth, before buffering it all)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' },
      body: 'x'.repeat(70_000),
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.code).toBe('payload_too_large');
  });

  it('rejects a disallowed Origin on /mcp (DNS-rebinding protection)', async () => {
    // `fetch` forbids setting Origin/Host, so use a raw HTTP request.
    const status = await rawPost('/mcp', {
      authorization: `Bearer ${ADMIN_TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      origin: 'https://evil.example',
    });
    expect(status).toBe(403);
  });

  it('sets Secure on the session cookie for an HTTPS deployment', async () => {
    const res = await fetch(`${baseUrl}/dashboard/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `token=${encodeURIComponent(ADMIN_TOKEN)}`,
      redirect: 'manual',
    });
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('rembric_session=');
    expect(setCookie).toMatch(/;\s*Secure/i);
    expect(setCookie).toMatch(/HttpOnly/i);
  });

  it('returns an identical 401 for a valid-non-admin vs an invalid login token', async () => {
    // Mint a real, valid, non-admin token on the server's own connection.
    const tokensSvc = new TokensService(createRepositories(server.dbHandle.db));
    const nonAdmin = tokensSvc.create({ name: 'ro-login', scope: 'read:*' });

    async function login(token: string): Promise<{ status: number; text: string }> {
      const res = await fetch(`${baseUrl}/dashboard/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: `token=${encodeURIComponent(token)}`,
        redirect: 'manual',
      });
      return { status: res.status, text: await res.text() };
    }

    const validNonAdmin = await login(nonAdmin.plaintext);
    const invalid = await login('definitely-not-a-real-token-value');
    expect(validNonAdmin.status).toBe(401);
    expect(invalid.status).toBe(401);
    // No validity oracle: the two responses are byte-identical.
    expect(validNonAdmin.text).toBe(invalid.text);
  });
});

/**
 * The cap lives twice — as the assertion above and as the mcp-api requirement
 * that publishes it — and nothing couples them. Either location counts, so this
 * holds before and after the delta is merged at archive time.
 */
describe('the enforced description cap is published in mcp-api', () => {
  it(`states ${DESCRIPTION_MAX_LENGTH} in the live spec or a pending delta`, () => {
    const openspecDir = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      '..',
      '..',
      'openspec',
    );
    const changesDir = join(openspecDir, 'changes');
    const candidates = [join(openspecDir, 'specs', 'mcp-api', 'spec.md')];
    for (const entry of readdirSync(changesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== 'archive') {
        candidates.push(join(changesDir, entry.name, 'specs', 'mcp-api', 'spec.md'));
      }
    }

    // The constant NAME and the value on one line. A bare digit search was
    // satisfied by 22 numbers already in these files — including 2048 and 1000,
    // so bumping the cap to the ceiling passed green — and by a stray `1900` in
    // unrelated prose after the requirement was deleted. The separator is
    // optional because the sibling documents write `1,900`.
    const digits = String(DESCRIPTION_MAX_LENGTH);
    const withSeparator =
      digits.length > 3 ? `${digits.slice(0, -3)},?${digits.slice(-3)}` : digits;
    const pattern = new RegExp(`DESCRIPTION_MAX_LENGTH[^\\n]*?\\b${withSeparator}\\b`);
    const published = candidates
      .filter((p) => existsSync(p))
      .some((p) => pattern.test(readFileSync(p, 'utf8')));

    expect(
      published,
      `no mcp-api requirement names DESCRIPTION_MAX_LENGTH with the value ${DESCRIPTION_MAX_LENGTH}`,
    ).toBe(true);
  });
});
