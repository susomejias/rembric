import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { createServer as createSocketServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createRepositories } from '../../server/src/db/repositories/index.js';
import type { Project } from '../../server/src/db/schema/projects.js';
import { buildInstructions } from '../../server/src/mcp/instructions.js';
import { type BootstrappedServer, createServer } from '../../server/src/server/index.js';
import { AgentSessionsService } from '../../server/src/services/agent-sessions.js';
import { ProjectsService } from '../../server/src/services/projects.js';
import { TokensService } from '../../server/src/services/tokens.js';
import { createTestDb } from '../../server/src/test/db.js';
import { FakeEmbedder } from '../../server/src/test/embedder.js';
import { findFreePort } from '../../server/src/test/net.js';
import {
  FIRST_PROMPT_NUDGE,
  POST_TIMEOUT_MS,
  SESSION_ID_NUDGE_TEMPLATE,
  SUMMARY_NUDGE,
  underscoreToolNames,
} from '../bin/rembric-plugin-core.mjs';

import rembric from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const SERVER_TOOL_COUNT = (
  readFileSync(join(repoRoot, 'apps/server/src/mcp/server.ts'), 'utf8').match(
    /^\s*registerTool\(/gm,
  ) ?? []
).length;

const ADMIN_TOKEN = 'pi-plugin-admin-token-with-enough-entropy-zz';
const PROJECT_SLUG = 'pi-plugin-test';

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: unknown,
    signal?: AbortSignal,
  ) => Promise<{ content: Array<{ type: string; text?: string }>; isError?: true }>;
};

type Handler = (event: unknown, ctx: unknown) => unknown;

type Notification = { message: string; type?: string };

type Harness = {
  tools: RegisteredTool[];
  handlers: Map<string, Handler>;
  ctx: {
    cwd: string;
    sessionManager: { getSessionId: () => string; getSessionFile: () => string | undefined };
  };
  notifications: Notification[];
  fire: (event: string, payload?: unknown) => Promise<unknown>;
};

let server: BootstrappedServer;
let sessions: AgentSessionsService;
let repos: ReturnType<typeof createRepositories>;
let tokens: TokensService;
let project: Project;
let baseUrl: string;
let cwd: string;

// An independently written wire client, so a defect in the extension's own
// decoder cannot corrupt the reference it is compared against. The MCP SDK
// client cannot be used here: outside the server workspace Vite inlines it and
// its transitive imports do not resolve.
async function rawRpc(method: string, params: Record<string, unknown>): Promise<unknown> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${ADMIN_TOKEN}`,
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };
  const endpoint = `${baseUrl}/mcp/${PROJECT_SLUG}`;
  const init = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'pi-plugin-test-raw', version: '0' },
      },
    }),
  });
  await init.text();
  const mcpSessionId = init.headers.get('mcp-session-id');
  if (mcpSessionId) headers['mcp-session-id'] = mcpSessionId;
  await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });

  const res = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }),
  });
  const body = await res.text();
  await fetch(endpoint, { method: 'DELETE', headers });
  const frame = body
    .split('\n')
    .find((line) => line.startsWith('data:'))
    ?.slice('data:'.length)
    .trim();
  return JSON.parse(frame ?? body) as unknown;
}

function makeHarness(sessionId: string, dir = cwd, withUi = true, sessionFile?: string): Harness {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, Handler>();
  const notifications: Notification[] = [];
  const ui = { notify: (message: string, type?: string) => notifications.push({ message, type }) };
  const ctx = {
    cwd: dir,
    // `string | undefined`, as the harness declares it: a session file is absent
    // until the manager has one, and the self-resume guard must survive that.
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => sessionFile },
    ...(withUi ? { ui } : {}),
  };
  const api = {
    registerTool: (definition: RegisteredTool) => tools.push(definition),
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  };
  rembric(api as unknown as Parameters<typeof rembric>[0]);
  return {
    tools,
    handlers,
    ctx,
    notifications,
    fire: async (event, payload = {}) => {
      const handler = handlers.get(event);
      if (!handler) throw new Error(`no handler registered for ${event}`);
      return await handler(payload, ctx);
    },
  };
}

async function startedHarness(sessionId: string, sessionFile?: string): Promise<Harness> {
  const harness = makeHarness(sessionId, cwd, true, sessionFile);
  await harness.fire('session_start');
  return harness;
}

type WireTool = { name: string; description?: string; inputSchema: unknown };

async function rawListTools(): Promise<WireTool[]> {
  const message = (await rawRpc('tools/list', {})) as { result?: { tools?: WireTool[] } };
  return message.result?.tools ?? [];
}

function toolNamed(harness: Harness, canonical: string): RegisteredTool {
  const tool = harness.tools.find((t) => t.label === canonical);
  if (!tool) throw new Error(`${canonical} was not registered`);
  return tool;
}

/** Rejection and an `isError` result are both refusals; callers assert which. */
async function callThroughExtension(
  tool: RegisteredTool,
  args: unknown,
): Promise<{ refused: boolean; text: string }> {
  try {
    const result = await tool.execute('call-1', args);
    const text = result.content.map((part) => part.text ?? '').join('\n');
    return { refused: result.isError === true, text };
  } catch (err) {
    return { refused: true, text: err instanceof Error ? err.message : String(err) };
  }
}

// Written out rather than imported, so the assertions do not depend on the same
// pattern the code under test rewrites with.
const DOTTED_TOOL_NAME = /\b(?:memory|project)\.[a-z]/;

function withoutDescriptions(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withoutDescriptions);
  if (typeof node !== 'object' || node === null) return node;
  return Object.fromEntries(
    Object.entries(node)
      .filter(([key]) => key !== 'description')
      .map(([key, value]) => [key, withoutDescriptions(value)]),
  );
}

function collectDescriptions(node: unknown, into: string[]): void {
  if (Array.isArray(node)) {
    for (const item of node) collectDescriptions(item, into);
    return;
  }
  if (typeof node !== 'object' || node === null) return;
  for (const [key, value] of Object.entries(node)) {
    if (key === 'description' && typeof value === 'string') into.push(value);
    else collectDescriptions(value, into);
  }
}

function savedId(text: string): string {
  const payload = JSON.parse(text) as { id?: string };
  if (!payload.id) throw new Error(`no id in save result: ${text.slice(0, 200)}`);
  return payload.id;
}

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
    },
    { embedder: new FakeEmbedder() },
  );
  baseUrl = `http://127.0.0.1:${port}`;

  repos = createRepositories(server.dbHandle.db);
  const projects = new ProjectsService(repos);
  project = projects.findBySlug(PROJECT_SLUG) ?? projects.create({ slug: PROJECT_SLUG });
  sessions = new AgentSessionsService(repos, server.dbHandle.db);
  tokens = new TokensService(repos, server.dbHandle.db);

  cwd = mkdtempSync(join(tmpdir(), 'rembric-pi-cwd-'));
  writeFileSync(join(cwd, '.rembric'), `PROJECT_SLUG=${PROJECT_SLUG}\n`);

  process.env.REMBRIC_SERVER_URL = baseUrl;
  process.env.REMBRIC_API_TOKEN = ADMIN_TOKEN;
}, 30_000);

afterAll(async () => {
  delete process.env.REMBRIC_SERVER_URL;
  delete process.env.REMBRIC_API_TOKEN;
  rmSync(cwd, { recursive: true, force: true });
  await server.shutdown();
});

describe('tool discovery over the extension’s own MCP transport', () => {
  let harness: Harness;
  let discovered: WireTool[];

  beforeAll(async () => {
    harness = await startedHarness('pi-discovery');
    discovered = await rawListTools();
  });

  it('the derived server tool count is non-zero', () => {
    expect(SERVER_TOOL_COUNT).toBeGreaterThan(0);
  });

  it('registers exactly one tool per registerTool call site in the server', () => {
    expect(discovered).toHaveLength(SERVER_TOOL_COUNT);
    expect(harness.tools).toHaveLength(SERVER_TOOL_COUNT);
  });

  it('covers every discovered tool, dropping none and inventing none', () => {
    expect(harness.tools.map((t) => t.label).sort()).toEqual(discovered.map((t) => t.name).sort());
  });

  it('carries the server’s own description and inputSchema, changing only the tool names', () => {
    let renamed = 0;
    for (const tool of discovered) {
      const registered = toolNamed(harness, tool.name);
      expect(registered.description).toBe(underscoreToolNames(tool.description ?? tool.name));
      // Every `description` removed from both sides, so this asserts the rest of
      // the schema is untouched without re-implementing the rewrite under test.
      expect(withoutDescriptions(registered.parameters)).toEqual(
        withoutDescriptions(tool.inputSchema),
      );
      if (registered.description !== (tool.description ?? tool.name)) renamed += 1;
    }
    // Control: without this the assertions above hold for an inert rewrite.
    expect(renamed, 'no description was rewritten, so the rename never ran').toBeGreaterThan(0);
  });

  it('leaves no dotted tool name in any description it publishes to the model', () => {
    const texts: string[] = [];
    for (const tool of harness.tools) {
      texts.push(tool.description);
      collectDescriptions(tool.parameters, texts);
    }
    expect(texts.length).toBeGreaterThan(discovered.length);
    for (const text of texts) {
      expect(text, `${text.slice(0, 120)} names a dotted tool`).not.toMatch(DOTTED_TOOL_NAME);
    }
  });

  it('every dotted tool the server publishes is covered by the shared rename', () => {
    // Registration replaces every dot; the rename that rewrites guidance knows
    // the namespaces by name, so a namespace it misses fails here.
    for (const tool of harness.tools) {
      expect(
        underscoreToolNames(tool.label),
        `${tool.label} is outside the renamed namespaces`,
      ).toBe(tool.name);
    }
    expect(harness.tools.some((t) => t.label.includes('.'))).toBe(true);
  });

  it('strips nothing from the forwarded schema', () => {
    const save = toolNamed(harness, 'memory.save');
    expect(save.parameters.$schema).toBeTruthy();
    expect(save.parameters.additionalProperties).toBe(false);
    expect(save.parameters.required).toContain('title');
  });

  it('contains no tool name as a literal in the extension source', () => {
    const src = readFileSync(join(here, 'index.ts'), 'utf8');
    for (const tool of discovered) {
      expect(src, `${tool.name} appears as a literal`).not.toContain(tool.name);
    }
  });
});

describe('provider-safe registration names', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startedHarness('pi-names');
  });

  it('every registered name matches the provider name pattern', () => {
    for (const tool of harness.tools) {
      expect(tool.name, `${tool.name} is not provider-safe`).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it('no registered name contains a dot', () => {
    expect(harness.tools.filter((t) => t.name.includes('.'))).toEqual([]);
  });

  it('the safe name is the canonical name with dots replaced, and the canonical one is kept', () => {
    for (const tool of harness.tools) {
      expect(tool.name).toBe(tool.label.replace(/\./g, '_'));
    }
    expect(harness.tools.some((t) => t.label.includes('.'))).toBe(true);
  });

  it('the server refuses the safe form, so a proxy that forwarded it would be inert', async () => {
    const message = (await rawRpc('tools/call', { name: 'memory_save', arguments: {} })) as {
      error?: { message?: string };
      result?: { isError?: boolean };
    };
    expect(message.error ?? message.result?.isError).toBeTruthy();
  });
});

describe('proxied calls reach the database', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startedHarness('pi-proxy');
  });

  it('a proxied save returns a non-error result and an independent get reads the row back', async () => {
    const save = await callThroughExtension(toolNamed(harness, 'memory.save'), {
      type: 'project',
      title: 'pi proxy round trip',
      content: 'saved through the extension’s own tools/call',
    });
    expect(save.refused).toBe(false);
    const id = savedId(save.text);

    const get = await callThroughExtension(toolNamed(harness, 'memory.get'), { id });
    expect(get.refused).toBe(false);
    expect(get.text).toContain('pi proxy round trip');
  });

  it('the control — a fabricated id returns not_found', async () => {
    const get = await callThroughExtension(toolNamed(harness, 'memory.get'), {
      id: 'mem_this_id_was_never_saved',
    });
    expect(get.text).toContain('not_found');
  });
});

describe('argument validation against the server’s own schema', () => {
  let harness: Harness;
  const valid = {
    type: 'project',
    title: 'validation control',
    content: 'this payload must pass',
  };

  beforeAll(async () => {
    harness = await startedHarness('pi-validation');
  });

  it('the control — a valid payload passes', async () => {
    const result = await callThroughExtension(toolNamed(harness, 'memory.save'), valid);
    expect(result.refused).toBe(false);
  });

  it('an unknown property is refused', async () => {
    const result = await callThroughExtension(toolNamed(harness, 'memory.save'), {
      ...valid,
      bogus: 1,
    });
    expect(result.refused).toBe(true);
  });

  it('an invalid enum member is refused', async () => {
    const result = await callThroughExtension(toolNamed(harness, 'memory.save'), {
      ...valid,
      type: 'not-a-memory-type',
    });
    expect(result.refused).toBe(true);
  });

  it('a missing required property is refused', async () => {
    const result = await callThroughExtension(toolNamed(harness, 'memory.save'), {
      type: 'project',
      content: 'no title',
    });
    expect(result.refused).toBe(true);
  });
});

describe('session registration and nudges', () => {
  it('registers the session under agent pi with the harness cwd', async () => {
    const sessionId = 'pi-session-agent';
    const harness = await startedHarness(sessionId);

    // `cwd` is asserted on the request body because the server keeps it only
    // long enough to derive a placeholder title; `agent` on the row, where a
    // wrong value would be permanent.
    const posted: Array<Record<string, unknown>> = [];
    const realFetch = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (typeof init?.body === 'string' && String(input).endsWith('/sessions')) {
          posted.push(JSON.parse(init.body) as Record<string, unknown>);
        }
        return realFetch(input, init);
      });
    try {
      await harness.fire('before_agent_start', { prompt: 'first turn' });
    } finally {
      spy.mockRestore();
    }

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ id: sessionId, agent: 'pi', cwd });
    expect(sessions.getById(sessionId)?.agent).toBe('pi');
  });

  it('injects the first-prompt, sessionId and summary nudges on turn 1, under the registered names', async () => {
    const sessionId = 'pi-session-nudges';
    const harness = await startedHarness(sessionId);
    const result = (await harness.fire('before_agent_start', { prompt: 'first turn' })) as {
      message: { content: string; display: boolean };
    };

    expect(result.message.content).toContain(underscoreToolNames(FIRST_PROMPT_NUDGE));
    expect(result.message.content).toContain(underscoreToolNames(SUMMARY_NUDGE));
    expect(result.message.content).toContain(
      underscoreToolNames(SESSION_ID_NUDGE_TEMPLATE.replace('{{SESSION_ID}}', sessionId)),
    );
    expect(result.message.display).toBe(false);
  });

  it('emits no nudge message on a turn where no cadence fires', async () => {
    const harness = await startedHarness('pi-session-quiet');
    await harness.fire('before_agent_start', { prompt: 'turn one' });
    // The system prompt still carries the server's instructions, so the
    // assertion is on the nudge message specifically.
    const second = (await harness.fire('before_agent_start', { prompt: 'turn two' })) as {
      message?: unknown;
    };
    expect(second.message).toBeUndefined();
  });

  it('names only registered tools in every string it injects for the model', async () => {
    const sessionId = 'pi-session-guidance';
    const harness = await startedHarness(sessionId);
    const registered = new Set(harness.tools.map((t) => t.name));
    expect(registered.size).toBeGreaterThan(0);

    const result = (await harness.fire('before_agent_start', {
      prompt: 'remember what we did with the auth fix',
      systemPrompt: 'BASE PROMPT',
    })) as { message: { content: string }; systemPrompt: string };

    for (const text of [result.message.content, result.systemPrompt]) {
      expect(text).not.toMatch(DOTTED_TOOL_NAME);
      const named = [...text.matchAll(/\b(?:memory|project)_[a-z0-9_]+/g)].map((m) => m[0]);
      expect(named.length, `${text.slice(0, 80)} names no tool at all`).toBeGreaterThan(0);
      for (const name of named) {
        expect(registered, `${name} is not a registered tool`).toContain(name);
      }
    }
  });
});

describe('the server’s own usage instructions reach the model', () => {
  const expected = () => underscoreToolNames(buildInstructions({ requestedSlug: PROJECT_SLUG }));

  it('the instructions being asserted are non-empty and mention the bound project', () => {
    expect(expected().length).toBeGreaterThan(100);
    expect(expected()).toContain(PROJECT_SLUG);
  });

  it('appends them verbatim to the turn’s system prompt', async () => {
    const harness = await startedHarness('pi-instructions');
    const result = (await harness.fire('before_agent_start', {
      prompt: 'first turn',
      systemPrompt: 'BASE PROMPT',
    })) as { systemPrompt: string };

    expect(result.systemPrompt).toBe(`BASE PROMPT\n\n${expected()}`);
  });

  it('lands once per turn, and once even if the prompt already carries them', async () => {
    const harness = await startedHarness('pi-instructions-once');
    const occurrences = (text: string) => text.split(expected()).length - 1;

    const first = (await harness.fire('before_agent_start', {
      prompt: 'turn one',
      systemPrompt: 'BASE PROMPT',
    })) as { systemPrompt: string };
    expect(occurrences(first.systemPrompt)).toBe(1);

    // Stands in for a host that hands back the modified prompt instead of the
    // base one Pi hands each turn.
    const second = (await harness.fire('before_agent_start', {
      prompt: 'turn two',
      systemPrompt: first.systemPrompt,
    })) as { systemPrompt?: string } | undefined;
    expect(second?.systemPrompt).toBeUndefined();

    const third = (await harness.fire('before_agent_start', {
      prompt: 'turn three',
      systemPrompt: 'BASE PROMPT',
    })) as { systemPrompt: string };
    expect(occurrences(third.systemPrompt)).toBe(1);
  });

  it('is dropped when discovery never completed, rather than injected empty', async () => {
    const url = process.env.REMBRIC_SERVER_URL;
    process.env.REMBRIC_SERVER_URL = 'http://127.0.0.1:1';
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const harness = makeHarness('pi-instructions-failed');
      await harness.fire('session_start');
      const result = (await harness.fire('before_agent_start', {
        prompt: 'first turn',
        systemPrompt: 'BASE PROMPT',
      })) as { systemPrompt?: string; message?: unknown };
      expect(result.systemPrompt).toBeUndefined();
      // Control: the handler ran and still nudged.
      expect(result.message).toBeDefined();
    } finally {
      stderr.mockRestore();
      process.env.REMBRIC_SERVER_URL = url;
    }
  });
});

describe('summary flushes', () => {
  function summaryOf(sessionId: string): string | null {
    return sessions.getById(sessionId)?.summary ?? null;
  }

  it('the shutdown flush has landed by the time the handler resolves', async () => {
    const sessionId = 'pi-session-shutdown';
    const harness = await startedHarness(sessionId);
    await harness.fire('before_agent_start', { prompt: 'work happened here' });
    await harness.fire('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'and here is the reply' }] },
    });
    expect(summaryOf(sessionId)).toBeNull();

    await harness.fire('session_shutdown');

    // No polling, deliberately: a fire-and-forget flush would still be in flight
    // here, which is the difference being asserted.
    const summary = summaryOf(sessionId);
    expect(summary).toContain('work happened here');
    expect(summary).toContain('and here is the reply');
  });

  it('the shutdown flush deregisters the session, so a later debounce cannot re-POST it', async () => {
    const sessionId = 'pi-session-shutdown-forget';
    const harness = await startedHarness(sessionId);
    await harness.fire('before_agent_start', { prompt: 'one turn of work' });

    const posts: string[] = [];
    const realFetch = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith(`/sessions/${sessionId}/summary`)) posts.push(String(input));
        return realFetch(input, init);
      });
    process.env.REMBRIC_IDLE_DEBOUNCE_MS = '10';
    try {
      await harness.fire('session_shutdown');
      expect(posts).toHaveLength(1);

      // Stands in for the timer a settle just before shutdown leaves behind: the
      // flush that fires must find the session gone.
      await harness.fire('agent_settled');
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(posts).toHaveLength(1);
    } finally {
      delete process.env.REMBRIC_IDLE_DEBOUNCE_MS;
      spy.mockRestore();
    }
  });

  it('agent_settled schedules the debounced per-turn flush', async () => {
    const sessionId = 'pi-session-settled';
    const harness = await startedHarness(sessionId);
    await harness.fire('before_agent_start', { prompt: 'a turn that should be flushed' });
    process.env.REMBRIC_IDLE_DEBOUNCE_MS = '10';
    try {
      await harness.fire('agent_settled');
    } finally {
      delete process.env.REMBRIC_IDLE_DEBOUNCE_MS;
    }

    await vi.waitFor(() => expect(summaryOf(sessionId)).toContain('should be flushed'), {
      timeout: 5000,
    });
  });
});

describe('the shutdown reason decides whether the session is ended', () => {
  async function shutdownAfterOneTurn(
    sessionId: string,
    payload: { reason?: string; targetSessionFile?: string },
    sessionFile?: string,
  ): Promise<void> {
    const harness = await startedHarness(sessionId, sessionFile);
    await harness.fire('before_agent_start', { prompt: `work under ${sessionId}` });
    await harness.fire('message_end', {
      message: { role: 'assistant', content: [{ type: 'text', text: 'and the reply' }] },
    });
    await harness.fire('session_shutdown', payload);
  }

  for (const reason of ['quit', 'new', 'resume', 'fork']) {
    it(`ends the session on reason ${reason}`, async () => {
      const sessionId = `pi-shutdown-${reason}`;
      await shutdownAfterOneTurn(sessionId, { reason });

      const row = sessions.getById(sessionId);
      expect(row?.status).toBe('ended');
      expect(row?.endedAt).toBeTruthy();
      expect(row?.summary).toContain(`work under ${sessionId}`);
    });
  }

  it('does not end the session on reason reload, and the transcript still lands', async () => {
    const sessionId = 'pi-shutdown-reload';
    await shutdownAfterOneTurn(sessionId, { reason: 'reload' });

    const row = sessions.getById(sessionId);
    expect(row?.status).toBe('active');
    expect(row?.endedAt ?? null).toBeNull();
    // Without this a handler that did nothing at all would pass the arm.
    expect(row?.summary).toContain(`work under ${sessionId}`);
  });

  it('does not end the session when the resume names the session file already open', async () => {
    const sessionId = 'pi-shutdown-self-resume';
    const file = '/tmp/pi-sessions/self-resume.jsonl';
    await shutdownAfterOneTurn(sessionId, { reason: 'resume', targetSessionFile: file }, file);

    const row = sessions.getById(sessionId);
    expect(row?.status).toBe('active');
    expect(row?.summary).toContain(`work under ${sessionId}`);
  });

  it('the control — a resume naming a different session file still ends it', async () => {
    const sessionId = 'pi-shutdown-other-resume';
    await shutdownAfterOneTurn(
      sessionId,
      { reason: 'resume', targetSessionFile: '/tmp/pi-sessions/another.jsonl' },
      '/tmp/pi-sessions/mine.jsonl',
    );

    expect(sessions.getById(sessionId)?.status).toBe('ended');
  });

  it('does not end the session on an unrecognised reason', async () => {
    const sessionId = 'pi-shutdown-teleport';
    await shutdownAfterOneTurn(sessionId, { reason: 'teleport' });

    const row = sessions.getById(sessionId);
    expect(row?.status).toBe('active');
    expect(row?.summary).toContain(`work under ${sessionId}`);
  });

  it('does not end the session when the event carries no reason', async () => {
    const sessionId = 'pi-shutdown-no-reason';
    await shutdownAfterOneTurn(sessionId, {});

    const row = sessions.getById(sessionId);
    expect(row?.status).toBe('active');
    expect(row?.summary).toContain(`work under ${sessionId}`);
  });

  it('ends a session with no turns, posting an empty body and leaving the summary null', async () => {
    const sessionId = 'pi-shutdown-empty';
    const harness = await startedHarness(sessionId);
    // Registers the session while leaving the transcript accumulator empty.
    await harness.fire('before_agent_start', { prompt: '' });

    const bodies: string[] = [];
    const realFetch = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith(`/sessions/${sessionId}/end`)) {
          bodies.push(String(init?.body ?? ''));
        }
        return realFetch(input, init);
      });
    try {
      await harness.fire('session_shutdown', { reason: 'quit' });
    } finally {
      spy.mockRestore();
    }

    expect(bodies).toEqual(['{}']);
    const row = sessions.getById(sessionId);
    expect(row?.status).toBe('ended');
    expect(row?.summary).toBeNull();
  });

  it('issues exactly one session write on a quit, and it is the end path', async () => {
    const sessionId = 'pi-shutdown-one-request';
    const harness = await startedHarness(sessionId);
    await harness.fire('before_agent_start', { prompt: 'one turn before the quit' });

    const paths: string[] = [];
    const realFetch = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes(`/sessions/${sessionId}`)) paths.push(new URL(url).pathname);
        return realFetch(input, init);
      });
    try {
      await harness.fire('session_shutdown', { reason: 'quit' });
    } finally {
      spy.mockRestore();
    }

    expect(paths).toEqual([`/api/${PROJECT_SLUG}/sessions/${sessionId}/end`]);
  });
});

describe('the successor session attributes its memories', () => {
  // A token of its own per arm: every other session in this file is active on
  // the admin token, and `findActiveForTransport` resolves nothing while more
  // than one active row matches the pair — which would make both arms below
  // pass for a reason that has nothing to do with the reason gate.
  async function saveThroughSuccessor(
    reason: string,
  ): Promise<{ savedSessionId: string | null; attributedToSuccessor: number }> {
    const minted = tokens.create({
      name: `pi-ambiguity-${reason}`,
      project,
      access: 'write',
    });
    const previous = process.env.REMBRIC_API_TOKEN;
    process.env.REMBRIC_API_TOKEN = minted.plaintext;
    try {
      const first = `pi-ambiguity-a-${reason}`;
      const successor = `pi-ambiguity-b-${reason}`;

      const a = await startedHarness(first);
      await a.fire('before_agent_start', { prompt: 'the replaced session did some work' });
      await a.fire('session_shutdown', { reason });

      const b = await startedHarness(successor);
      await b.fire('before_agent_start', { prompt: 'the successor session' });

      const save = await callThroughExtension(toolNamed(b, 'memory.save'), {
        type: 'project',
        title: `attribution after ${reason}`,
        content: 'saved without naming a sessionId',
      });
      expect(save.refused).toBe(false);

      return {
        savedSessionId: repos.memory.unsafeGetById(savedId(save.text))?.sessionId ?? null,
        attributedToSuccessor: repos.memory.adminListBySession(successor).length,
      };
    } finally {
      process.env.REMBRIC_API_TOKEN = previous;
    }
  }

  it('a save with no sessionId lands on the successor once the replaced session ended', async () => {
    const { savedSessionId, attributedToSuccessor } = await saveThroughSuccessor('new');

    expect(savedSessionId).toBe('pi-ambiguity-b-new');
    expect(attributedToSuccessor).toBeGreaterThan(0);
  });

  it('the control — without the end, both rows stay active and the save attributes nothing', async () => {
    const { savedSessionId, attributedToSuccessor } = await saveThroughSuccessor('reload');

    expect(savedSessionId).toBeNull();
    expect(attributedToSuccessor).toBe(0);
  });
});

// Answers the handshake and then swallows the DELETE, so only the client's own
// budget ends the teardown request — which is what the timing below reads.
async function startHalfDeadServer(): Promise<{
  url: string;
  seen: string[];
  paths: string[];
  close: () => Promise<void>;
}> {
  const seen: string[] = [];
  const paths: string[] = [];
  const held = new Set<ServerResponse>();
  const server = createHttpServer((req, res) => {
    paths.push(req.url ?? '');
    if (req.method === 'DELETE') {
      seen.push('DELETE');
      held.add(res);
      return;
    }
    // The awaited session write is swallowed too, so the teardown below measures
    // the client's own budget on both requests it makes on the way out.
    if (req.url?.endsWith('/end') || req.url?.endsWith('/summary')) {
      held.add(res);
      return;
    }
    let body = '';
    req.on('data', (chunk) => {
      body += String(chunk);
    });
    req.on('end', () => {
      const message = JSON.parse(body || '{}') as { id?: number; method?: string };
      seen.push(message.method ?? 'unknown');
      if (message.method === 'initialize') {
        res.writeHead(200, {
          'Content-Type': 'application/json',
          'mcp-session-id': 'stub-mcp-session',
        });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: message.id,
            result: {
              protocolVersion: '2025-06-18',
              capabilities: {},
              serverInfo: { name: 'half-dead-stub', version: '0' },
            },
          }),
        );
        return;
      }
      if (message.method === 'tools/list') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { tools: [] } }));
        return;
      }
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    paths,
    close: async () => {
      for (const res of held) res.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

describe('shutdown teardown budget', () => {
  it('bounds the quit teardown by the flush budget, not the discovery one', async () => {
    const stub = await startHalfDeadServer();
    const sessionId = 'pi-close-budget';
    const url = process.env.REMBRIC_SERVER_URL;
    process.env.REMBRIC_SERVER_URL = stub.url;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const harness = makeHarness(sessionId);
      await harness.fire('session_start');
      // Control: without it, a close() that returned early before issuing the
      // DELETE would read as a fast teardown.
      expect(stub.seen).toContain('initialize');
      // One turn, so the quit branch has a session to end and its POST is really
      // issued rather than skipped as unknown.
      await harness.fire('before_agent_start', { prompt: 'one turn before the quit' });

      const started = Date.now();
      await harness.fire('session_shutdown', { reason: 'quit' });
      const elapsed = Date.now() - started;

      expect(stub.seen).toContain('DELETE');
      expect(stub.paths).toContain(`/api/${PROJECT_SLUG}/sessions/${sessionId}/end`);
      expect(stub.paths.filter((p) => p.endsWith('/summary'))).toEqual([]);
      expect(elapsed, 'the DELETE was not awaited at all').toBeGreaterThan(POST_TIMEOUT_MS / 2);
      expect(
        elapsed,
        `the quit waited ${elapsed}ms on a dead server; the flush budget is ${POST_TIMEOUT_MS}ms`,
      ).toBeLessThan(POST_TIMEOUT_MS * 2);
    } finally {
      stderr.mockRestore();
      process.env.REMBRIC_SERVER_URL = url;
      await stub.close();
    }
  }, 30_000);
});

describe('missing configuration disables the extension', () => {
  it('emits exactly one diagnostic and issues zero requests without credentials', async () => {
    const url = process.env.REMBRIC_SERVER_URL;
    const token = process.env.REMBRIC_API_TOKEN;
    delete process.env.REMBRIC_API_TOKEN;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const harness = makeHarness('pi-no-credentials');
      await harness.fire('session_start');
      await harness.fire('before_agent_start', { prompt: 'anything' });
      await harness.fire('session_shutdown');

      expect(harness.tools).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      const lines = stderr.mock.calls.map((call) => String(call[0]));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('REMBRIC_API_TOKEN');
      expect(lines[0]).not.toContain(String(token));
    } finally {
      fetchSpy.mockRestore();
      stderr.mockRestore();
      process.env.REMBRIC_SERVER_URL = url;
      process.env.REMBRIC_API_TOKEN = token;
    }
  });

  it('names the missing configuration in the harness UI, where the operator can see it', async () => {
    const token = process.env.REMBRIC_API_TOKEN;
    delete process.env.REMBRIC_API_TOKEN;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const harness = makeHarness('pi-no-credentials-ui');
      await harness.fire('session_start');

      expect(harness.notifications).toHaveLength(1);
      expect(harness.notifications[0].type).toBe('warning');
      expect(harness.notifications[0].message).toContain('REMBRIC_API_TOKEN');
      expect(harness.notifications[0].message).not.toContain(String(token));
    } finally {
      stderr.mockRestore();
      process.env.REMBRIC_API_TOKEN = token;
    }
  });

  it('names the slug, not the credentials, when only the slug is missing', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'rembric-pi-noslug-'));
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const harness = makeHarness('pi-no-slug', bare);
      await harness.fire('session_start');

      expect(harness.notifications).toHaveLength(1);
      expect(harness.notifications[0].message).toContain('PROJECT_SLUG');
      // The credentials ARE set here, so naming them would be the wrong reason.
      expect(harness.notifications[0].message).not.toContain('REMBRIC_API_TOKEN');
    } finally {
      stderr.mockRestore();
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('reports a failed handshake in the harness UI', async () => {
    const url = process.env.REMBRIC_SERVER_URL;
    const token = process.env.REMBRIC_API_TOKEN;
    process.env.REMBRIC_SERVER_URL = 'http://127.0.0.1:1';
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const harness = makeHarness('pi-handshake-failed-ui');
      await harness.fire('session_start');

      // Control: the credentials are present, so this is the discovery path and
      // not the disabled one.
      expect(harness.tools).toEqual([]);
      expect(harness.notifications).toHaveLength(1);
      expect(harness.notifications[0].type).toBe('error');
      expect(harness.notifications[0].message).not.toContain(String(token));
    } finally {
      stderr.mockRestore();
      process.env.REMBRIC_SERVER_URL = url;
    }
  });

  it('still loads on a harness that supplies no notification channel', async () => {
    const token = process.env.REMBRIC_API_TOKEN;
    delete process.env.REMBRIC_API_TOKEN;
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const harness = makeHarness('pi-no-ui-channel', cwd, false);
      await expect(harness.fire('session_start')).resolves.not.toThrow();

      const lines = stderr.mock.calls.map((call) => String(call[0]));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('REMBRIC_API_TOKEN');
    } finally {
      stderr.mockRestore();
      process.env.REMBRIC_API_TOKEN = token;
    }
  });

  it('a server that accepts and never answers fails discovery instead of hanging startup', async () => {
    // Accepts and never replies: a refused connection fails on its own and so
    // cannot tell whether discovery is bounded.
    const accepted = new Set<Socket>();
    const blackHole = createSocketServer((socket) => accepted.add(socket));
    await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
    const address = blackHole.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const url = process.env.REMBRIC_SERVER_URL;
    process.env.REMBRIC_SERVER_URL = `http://127.0.0.1:${port}`;
    // Shortened from the shipped ceiling: what is under test is that the
    // handshake is bounded at all, not the size of the bound.
    process.env.REMBRIC_DISCOVERY_TIMEOUT_MS = '100';
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      const harness = makeHarness('pi-black-hole');
      await harness.fire('session_start');
      expect(harness.tools).toEqual([]);
      const lines = stderr.mock.calls.map((call) => String(call[0]));
      expect(lines.join('')).toContain('tool discovery failed');
    } finally {
      stderr.mockRestore();
      delete process.env.REMBRIC_DISCOVERY_TIMEOUT_MS;
      process.env.REMBRIC_SERVER_URL = url;
      // `close` waits for every connection to end, and the aborted request left
      // an accepted socket behind.
      for (const socket of accepted) socket.destroy();
      await new Promise<void>((resolve) => blackHole.close(() => resolve()));
    }
  }, 20_000);

  it('emits one diagnostic and registers nothing when .rembric names no project', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'rembric-pi-noslug-'));
    mkdirSync(join(bare, 'sub'), { recursive: true });
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const harness = makeHarness('pi-no-slug', bare);
      await harness.fire('session_start');

      expect(harness.tools).toEqual([]);
      expect(fetchSpy).not.toHaveBeenCalled();
      const lines = stderr.mock.calls.map((call) => String(call[0]));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain('PROJECT_SLUG');
    } finally {
      fetchSpy.mockRestore();
      stderr.mockRestore();
      rmSync(bare, { recursive: true, force: true });
    }
  });
});
