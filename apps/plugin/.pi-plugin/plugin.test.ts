import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createHttpServer, type ServerResponse } from 'node:http';
import { createServer as createSocketServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { keyHint } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { createRepositories } from '../../server/src/db/repositories/index.js';
import type { Project } from '../../server/src/db/schema/projects.js';
import { buildInstructions } from '../../server/src/mcp/instructions.js';
import { AgentSessionsService } from '../../server/src/services/agent-sessions.js';
import { ProjectsService } from '../../server/src/services/projects.js';
import { TokensService } from '../../server/src/services/tokens.js';
import { bootWebServer, type BootedWebServer } from '../../web/src/test-support/boot-server.js';
import { openTestDb, type OpenedTestDb } from '../../web/src/test-support/db.js';
import {
  FIRST_PROMPT_NUDGE,
  POST_TIMEOUT_MS,
  SESSION_ID_NUDGE_TEMPLATE,
  SESSION_OPENING_NUDGE,
  underscoreToolNames,
} from '../bin/rembric-plugin-core.mjs';

import rembric, { renderToolResultLines } from './index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const SERVER_TOOL_COUNT = (
  readFileSync(join(repoRoot, 'packages/mcp/src/server.ts'), 'utf8').match(
    /^\s*registerTool\(/gm,
  ) ?? []
).length;

let ADMIN_TOKEN: string;
const PROJECT_SLUG = 'pi-plugin-test';

type ToolResult = { content: Array<{ type: string; text?: string }>; details: unknown };

type FakeTheme = { fg: (color: string, text: string) => string; bold: (text: string) => string };

type RenderContext = { isError: boolean; expanded: boolean; isPartial: boolean };

type RenderComponent = { render: (width: number) => string[] };

type RegisteredTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (toolCallId: string, params: unknown, signal?: AbortSignal) => Promise<ToolResult>;
  renderCall?: (args: unknown, theme: FakeTheme, context: RenderContext) => RenderComponent;
  renderResult?: (
    result: ToolResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: FakeTheme,
    context: RenderContext,
  ) => RenderComponent;
};

const THEME: FakeTheme = {
  fg: (color, text) => `<${color}>${text}</${color}>`,
  bold: (text) => `«${text}»`,
};

const HINT = '<expand-hint>';

function plain(line: string): string {
  return line.replace(/<\/?[a-z]+>/g, '').replace(/[«»]/g, '');
}

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

let boot: BootedWebServer;
let db: OpenedTestDb;
let sessions: AgentSessionsService;
let repos: ReturnType<typeof createRepositories>;
let tokens: TokensService;
let project: Project;
let baseUrl: string;
let cwd: string;

const LEAKED_CHILD_MARKERS = [
  'REMBRIC_SUBAGENT',
  'GENTLE_PI_AGENTS_CHILD',
  'REMBRIC_TRACK_SESSION',
] as const;
const savedChildMarkers: Record<string, string | undefined> = {};

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

function makeHarness(
  sessionId: string,
  dir = cwd,
  withUi = true,
  sessionFile?: string,
  mode: string = 'tui',
): Harness {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, Handler>();
  const notifications: Notification[] = [];
  const ui = { notify: (message: string, type?: string) => notifications.push({ message, type }) };
  const ctx = {
    cwd: dir,
    mode,
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

async function startedHarness(
  sessionId: string,
  sessionFile?: string,
  mode?: string,
): Promise<Harness> {
  const harness = makeHarness(sessionId, cwd, true, sessionFile, mode);
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

async function callThroughExtension(
  tool: RegisteredTool,
  args: unknown,
): Promise<{ refused: boolean; text: string }> {
  try {
    const result = await tool.execute('call-1', args);
    return { refused: false, text: result.content.map((part) => part.text ?? '').join('\n') };
  } catch (err) {
    return { refused: true, text: err instanceof Error ? err.message : String(err) };
  }
}

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
  boot = await bootWebServer();
  ADMIN_TOKEN = boot.adminToken;
  baseUrl = boot.baseUrl;

  for (const key of LEAKED_CHILD_MARKERS) {
    savedChildMarkers[key] = process.env[key];
    delete process.env[key];
  }

  db = openTestDb(boot.dataDir);
  repos = createRepositories(db.handle.db);
  const projects = new ProjectsService(repos);
  project = projects.findBySlug(PROJECT_SLUG) ?? projects.create({ slug: PROJECT_SLUG });
  sessions = new AgentSessionsService(repos, db.handle.db);
  tokens = new TokensService(repos, db.handle.db);

  cwd = mkdtempSync(join(tmpdir(), 'rembric-pi-cwd-'));
  writeFileSync(join(cwd, '.rembric'), `PROJECT_SLUG=${PROJECT_SLUG}\n`);

  process.env.REMBRIC_SERVER_URL = baseUrl;
  process.env.REMBRIC_API_TOKEN = ADMIN_TOKEN;
}, 120_000);

afterAll(async () => {
  delete process.env.REMBRIC_SERVER_URL;
  delete process.env.REMBRIC_API_TOKEN;
  for (const key of LEAKED_CHILD_MARKERS) {
    if (savedChildMarkers[key] === undefined) delete process.env[key];
    else process.env[key] = savedChildMarkers[key];
  }
  rmSync(cwd, { recursive: true, force: true });
  db.cleanup();
  await boot.close();
});

describe('collapsed and expanded tool-result rendering', () => {
  const MULTILINE = [
    '{',
    '  "ok": true,',
    '  "memories": [',
    '    { "id": "mem_alpha", "title": "the first remembered thing" },',
    '    { "id": "mem_beta", "title": "the second remembered thing" }',
    '  ]',
    '}',
  ].join('\n');

  const substantialLines = MULTILINE.split('\n').filter((line) => line.trim().length >= 4);

  const ERROR_PAYLOAD = JSON.stringify(
    { ok: false, code: 'not_found', message: 'no memory with that id' },
    null,
    2,
  );

  it('the payload these arms assert over is non-empty and spans several lines', () => {
    expect(MULTILINE.length).toBeGreaterThan(0);
    expect(MULTILINE.split('\n').length).toBeGreaterThan(1);
    expect(substantialLines.length).toBeGreaterThan(1);
    expect(ERROR_PAYLOAD.split('\n').length).toBeGreaterThan(1);
  });

  it('collapses a successful multi-line result to one line naming the tool, its size and the key', () => {
    const out = renderToolResultLines(MULTILINE, false, false, 'memory.context', HINT, THEME);

    expect(out).toHaveLength(1);
    expect(out[0]).toContain('memory.context');
    expect(out[0]).toContain(String(MULTILINE.split('\n').length));
    expect(out[0]).toContain(HINT);
    for (const line of substantialLines) {
      expect(out[0], `${line.trim()} leaked into the collapsed line`).not.toContain(line.trim());
    }
  });

  it('restores the complete original text, byte for byte, when expanded', () => {
    const out = renderToolResultLines(MULTILINE, true, false, 'memory.context', HINT, THEME);

    expect(out.join('\n')).toBe(MULTILINE);
  });

  it('marks a failed result differently from a successful one, in the error colour', () => {
    const ok = renderToolResultLines(MULTILINE, false, false, 'memory.context', HINT, THEME);
    const failed = renderToolResultLines(MULTILINE, false, true, 'memory.context', HINT, THEME);

    expect(failed).toHaveLength(1);
    expect(failed[0]).not.toBe(ok[0]);
    // The outcome marker itself differs, not merely the styling around it.
    expect(plain(failed[0])[0]).not.toBe(plain(ok[0])[0]);
    expect(failed[0]).toContain('<error>');
    expect(ok[0]).not.toContain('<error>');
  });

  it('expands a failure to its full diagnostic text, error code included', () => {
    const out = renderToolResultLines(ERROR_PAYLOAD, true, true, 'memory.get', HINT, THEME);

    expect(out.join('\n')).toBe(ERROR_PAYLOAD);
    expect(out.join('\n')).toContain('"code": "not_found"');
  });

  it('collapses regardless of size — one line and several hundred alike', () => {
    const oneLine = 'a single line of result text';
    const many = Array.from({ length: 400 }, (_, i) => `result line number ${i}`).join('\n');

    for (const [text, count] of [
      [oneLine, 1],
      [many, 400],
    ] as const) {
      const out = renderToolResultLines(text, false, false, 'memory.search', HINT, THEME);
      expect(out).toHaveLength(1);
      expect(out[0]).toContain(String(count));
      expect(out[0]).not.toContain(text.split('\n')[0]);
    }
  });

  it('counts newline-delimited lines, not rendered rows', () => {
    const out = renderToolResultLines('x'.repeat(500), false, false, 'memory.get', HINT, THEME);

    expect(plain(out[0])).toContain(' 1 line ');
    expect(out[0]).not.toContain('500');
  });

  it('renders identically for two different tools apart from the name', () => {
    const a = renderToolResultLines(MULTILINE, false, false, 'memory.context', HINT, THEME);
    const b = renderToolResultLines(MULTILINE, false, false, 'project.list', HINT, THEME);

    expect(a[0]).not.toBe(b[0]);
    expect(a[0].replace('memory.context', '<tool>')).toBe(b[0].replace('project.list', '<tool>'));
  });
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

  it('the render path names no tool, reads no response field and hard-codes no key', () => {
    const src = readFileSync(join(here, 'index.ts'), 'utf8');
    const from = src.indexOf('export function renderToolResultLines');
    const to = src.indexOf("pi.on('before_agent_start'");
    expect(from, 'the pure render function was not found').toBeGreaterThan(-1);
    expect(to, 'the end of the registration block was not found').toBeGreaterThan(from);
    const renderPath = src.slice(from, to);
    // Without these the slice could miss the renderers and assert over nothing.
    expect(renderPath).toContain('renderCall:');
    expect(renderPath).toContain('renderResult:');

    for (const tool of discovered) {
      expect(renderPath, `${tool.name} appears on the render path`).not.toContain(tool.name);
    }
    expect(renderPath).not.toContain('JSON.parse');
    expect(renderPath.toLowerCase()).not.toContain('ctrl+');
    const members = new Set([...renderPath.matchAll(/\bresult\.([A-Za-z_]\w*)/g)].map((m) => m[1]));
    expect([...members]).toEqual(['content']);
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

describe('an MCP error result is signalled by throwing', () => {
  let harness: Harness;
  const FABRICATED = 'mem_this_id_was_never_saved';

  beforeAll(async () => {
    harness = await startedHarness('pi-error-signal');
  });

  async function wireResult(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ isError: boolean; text: string }> {
    const message = (await rawRpc('tools/call', { name, arguments: args })) as {
      result?: { isError?: boolean; content?: Array<{ type: string; text?: string }> };
    };
    const text = (message.result?.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n');
    return { isError: message.result?.isError === true, text };
  }

  it('rejects with the MCP result text verbatim when the result carries isError', async () => {
    const reference = await wireResult('memory.get', { id: FABRICATED });
    expect(reference.isError).toBe(true);
    expect(reference.text).toContain('not_found');

    const thrown = await toolNamed(harness, 'memory.get')
      .execute('call-error', { id: FABRICATED })
      .then(
        () => null,
        (err: unknown) => err,
      );

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe(reference.text);
  });

  it('the control — a successful call resolves, with its text unchanged', async () => {
    const reference = await wireResult('project.current', {});
    expect(reference.isError).toBe(false);
    expect(reference.text.length).toBeGreaterThan(0);

    const result = await toolNamed(harness, 'project.current').execute('call-ok', {});

    expect(result.content).toHaveLength(1);
    expect(result.content[0].text).toBe(reference.text);
  });
});

describe('the registered renderers', () => {
  let harness: Harness;
  let discovered: WireTool[];
  const CONTEXT = { isError: false, expanded: false, isPartial: false };
  const OPTIONS = { expanded: false, isPartial: false };
  const RESULT: ToolResult = {
    content: [{ type: 'text', text: 'line one\nline two\nline three' }],
    details: undefined,
  };

  beforeAll(async () => {
    harness = await startedHarness('pi-renderers');
    discovered = await rawListTools();
  });

  it('every discovered tool is registered with both renderers', () => {
    expect(discovered.length).toBeGreaterThan(0);
    expect(harness.tools).toHaveLength(discovered.length);
    for (const tool of harness.tools) {
      expect(typeof tool.renderCall, `${tool.label} has no renderCall`).toBe('function');
      expect(typeof tool.renderResult, `${tool.label} has no renderResult`).toBe('function');
    }
  });

  it('the call slot renders the canonical dotted name and no argument', () => {
    for (const tool of harness.tools) {
      const rendered = tool
        .renderCall?.({ id: 'ARGUMENT_SENTINEL' }, THEME, CONTEXT)
        .render(80)
        .join('\n');

      expect(rendered).toContain(tool.label);
      expect(rendered).not.toContain('ARGUMENT_SENTINEL');
    }
    // Without this the loop above passes on an empty registration.
    expect(harness.tools.some((t) => t.label.includes('.'))).toBe(true);
  });

  it('reads the error flag off the render context, where a result-reader would see nothing', () => {
    const tool = toolNamed(harness, 'memory.get');

    const rendered = tool
      .renderResult?.(RESULT, OPTIONS, THEME, { ...CONTEXT, isError: true })
      .render(80);

    expect(rendered).toHaveLength(1);
    expect(rendered?.[0]).toContain('<error>');

    const offResult = renderToolResultLines(
      'line one\nline two\nline three',
      false,
      (RESULT as { isError?: boolean }).isError ?? false,
      tool.label,
      HINT,
      THEME,
    );
    expect(offResult[0]).toContain('<success>');
    expect(offResult[0]).not.toContain('<error>');
  });

  it('takes the expand hint from the harness binding rather than a key literal', () => {
    const rendered = toolNamed(harness, 'memory.context')
      .renderResult?.(RESULT, OPTIONS, THEME, CONTEXT)
      .render(80);

    const hint = keyHint('app.tools.expand', 'to expand');
    expect(hint.length).toBeGreaterThan(0);
    expect(rendered?.[0]).toContain(hint);
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

  it('injects the first-prompt, sessionId and session-opening nudges on turn 1, under the registered names', async () => {
    const sessionId = 'pi-session-nudges';
    const harness = await startedHarness(sessionId);
    const result = (await harness.fire('before_agent_start', { prompt: 'first turn' })) as {
      message: { content: string; display: boolean };
    };

    expect(result.message.content).toContain(underscoreToolNames(FIRST_PROMPT_NUDGE));
    expect(result.message.content).toContain(underscoreToolNames(SESSION_OPENING_NUDGE));
    expect(result.message.content).toContain('## Goal');
    expect(result.message.content).toContain(
      underscoreToolNames(SESSION_ID_NUDGE_TEMPLATE.replace('{{SESSION_ID}}', sessionId)),
    );
    expect(result.message.display).toBe(false);
  });

  it('emits no nudge message on a turn where no cadence fires', async () => {
    const harness = await startedHarness('pi-session-quiet');
    await harness.fire('before_agent_start', { prompt: 'turn one' });
    const second = (await harness.fire('before_agent_start', { prompt: 'turn two' })) as {
      message?: unknown;
    };
    expect(second.message).toBeUndefined();
  });

  it('merges a non-empty server recall result into the start-of-turn message', async () => {
    const sessionId = 'pi-session-recall-merge';
    const harness = await startedHarness(sessionId);
    await harness.fire('before_agent_start', { prompt: 'seed this session' });
    const saved = await callThroughExtension(toolNamed(harness, 'memory.save'), {
      type: 'project',
      title: 'Pi recall handoff',
      content: 'The implementation lives in src/pi-recall-merge.ts.',
    });
    expect(saved.refused).toBe(false);

    const result = (await harness.fire('before_agent_start', {
      prompt: 'fix src/pi-recall-merge.ts',
    })) as { message?: { content: string } };

    expect(result.message?.content).toContain('src/pi-recall-merge.ts: Pi recall handoff');
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

describe('tool-observation accumulation across a turn (session-nudges D4a)', () => {
  function spyOnTurnReports(): { calls: Array<{ usedTools: boolean }>; restore: () => void } {
    const calls: Array<{ usedTools: boolean }> = [];
    const realFetch = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.endsWith('/turn') && init?.body) {
          calls.push(JSON.parse(String(init.body)) as { usedTools: boolean });
        }
        return realFetch(input as never, init);
      });
    return { calls, restore: () => spy.mockRestore() };
  }

  const toolCallMessage = {
    role: 'assistant',
    content: [{ type: 'toolCall', name: 'ls', id: 't1' }],
  };
  const toolResultMessage = { role: 'toolResult', content: [{ type: 'text', text: 'a b c' }] };
  const settledTextOnlyMessage = {
    role: 'assistant',
    content: [{ type: 'text', text: 'Done.' }],
    stopReason: 'stop',
  };

  it('reports usedTools:true for a turn that called a tool, from the accumulated flag', async () => {
    const { calls, restore } = spyOnTurnReports();
    try {
      const harness = await startedHarness('pi-tool-accum-1');
      await harness.fire('before_agent_start', { prompt: 'list files' });
      await harness.fire('message_end', { message: toolCallMessage });
      await harness.fire('message_end', { message: toolResultMessage });
      await harness.fire('message_end', { message: settledTextOnlyMessage });
      await harness.fire('agent_settled');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(calls).toHaveLength(1);
      expect(calls[0]!.usedTools).toBe(true);
    } finally {
      restore();
    }
  });

  it('CONTROL: inspecting only the final (settled) message_end yields false', async () => {
    const { calls, restore } = spyOnTurnReports();
    try {
      const harness = await startedHarness('pi-tool-accum-control');
      await harness.fire('before_agent_start', { prompt: 'list files' });
      await harness.fire('message_end', { message: settledTextOnlyMessage });
      await harness.fire('agent_settled');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(calls).toHaveLength(1);
      expect(calls[0]!.usedTools).toBe(false);
    } finally {
      restore();
    }
  });

  it('resets per turn: a tool turn followed by a chat-only turn reports false on the second', async () => {
    const { calls, restore } = spyOnTurnReports();
    try {
      const harness = await startedHarness('pi-tool-accum-reset');
      await harness.fire('before_agent_start', { prompt: 'list files' });
      await harness.fire('message_end', { message: toolCallMessage });
      await harness.fire('message_end', { message: toolResultMessage });
      await harness.fire('agent_settled');
      await new Promise((resolve) => setTimeout(resolve, 50));

      await harness.fire('before_agent_start', { prompt: 'just chatting' });
      await harness.fire('message_end', { message: settledTextOnlyMessage });
      await harness.fire('agent_settled');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(calls).toHaveLength(2);
      expect(calls[0]!.usedTools).toBe(true);
      expect(calls[1]!.usedTools).toBe(false);
    } finally {
      restore();
    }
  });

  it('before_agent_start resets a flag left dangling by a turn that never reached agent_settled', async () => {
    const { calls, restore } = spyOnTurnReports();
    try {
      const harness = await startedHarness('pi-tool-accum-interrupted');
      await harness.fire('before_agent_start', { prompt: 'list files' });
      await harness.fire('message_end', { message: toolCallMessage });

      await harness.fire('before_agent_start', { prompt: 'just chatting' });
      await harness.fire('message_end', { message: settledTextOnlyMessage });
      await harness.fire('agent_settled');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(calls).toHaveLength(1);
      expect(calls[0]!.usedTools).toBe(false);
    } finally {
      restore();
    }
  });

  it('a second agent_settled with no turn in between reports false, not the same tool again', async () => {
    const { calls, restore } = spyOnTurnReports();
    try {
      const harness = await startedHarness('pi-tool-accum-double-settle');
      await harness.fire('before_agent_start', { prompt: 'list files' });
      await harness.fire('message_end', { message: toolCallMessage });
      await harness.fire('agent_settled');
      await new Promise((resolve) => setTimeout(resolve, 50));
      await harness.fire('agent_settled');
      await new Promise((resolve) => setTimeout(resolve, 50));

      // The first is the control: the latch really was armed.
      expect(calls.map((c) => c.usedTools)).toEqual([true, false]);
    } finally {
      restore();
    }
  });

  it('a `toolResult` message alone (no toolCall observed) also sets the flag', async () => {
    const { calls, restore } = spyOnTurnReports();
    try {
      const harness = await startedHarness('pi-tool-accum-result-only');
      await harness.fire('before_agent_start', { prompt: 'anything' });
      await harness.fire('message_end', { message: toolResultMessage });
      await harness.fire('agent_settled');
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(calls[0]!.usedTools).toBe(true);
    } finally {
      restore();
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

describe('child and programmatic pi processes are never persisted as sessions', () => {
  async function runLifecycle(
    sessionId: string,
    opts: { env?: Record<string, string>; mode?: string } = {},
  ): Promise<void> {
    for (const [key, value] of Object.entries(opts.env ?? {})) vi.stubEnv(key, value);
    try {
      const harness = await startedHarness(sessionId, undefined, opts.mode);
      await harness.fire('before_agent_start', { prompt: `delegated task under ${sessionId}` });
      await harness.fire('message_end', {
        message: { role: 'assistant', content: [{ type: 'text', text: 'child reply' }] },
      });
      await harness.fire('agent_settled', {});
      await harness.fire('session_shutdown', { reason: 'quit' });
    } finally {
      vi.unstubAllEnvs();
    }
  }

  async function suppressedLifecycleCalls(
    sessionId: string,
    opts: { env?: Record<string, string>; mode?: string },
  ): Promise<string[]> {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = typeof init?.body === 'string' ? init.body : '';
        if (
          url.endsWith('/sessions') ||
          url.includes(`/sessions/${sessionId}`) ||
          body.includes('memory.session_resume')
        ) {
          calls.push(`${new URL(url).pathname} ${body.slice(0, 80)}`);
        }
        return realFetch(input, init);
      });
    try {
      await runLifecycle(sessionId, opts);
    } finally {
      spy.mockRestore();
    }
    return calls;
  }

  it('the legacy gentle-pi marker suppresses the whole lifecycle', async () => {
    const calls = await suppressedLifecycleCalls('pi-subagent-legacy', {
      env: { GENTLE_PI_AGENTS_CHILD: '1' },
    });
    expect(calls).toEqual([]);
    expect(sessions.getById('pi-subagent-legacy')).toBeUndefined();
  });

  it('the generic REMBRIC_SUBAGENT marker suppresses the whole lifecycle', async () => {
    const calls = await suppressedLifecycleCalls('pi-subagent-declared', {
      env: { REMBRIC_SUBAGENT: '1' },
    });
    expect(calls).toEqual([]);
    expect(sessions.getById('pi-subagent-declared')).toBeUndefined();
  });

  it('an RPC-driven process suppresses the whole lifecycle without any marker', async () => {
    const calls = await suppressedLifecycleCalls('pi-subagent-rpc', { mode: 'rpc' });
    expect(calls).toEqual([]);
    expect(sessions.getById('pi-subagent-rpc')).toBeUndefined();
  });

  it('REMBRIC_TRACK_SESSION=1 forces tracking even for an RPC-driven process', async () => {
    await runLifecycle('pi-rpc-tracked', {
      env: { REMBRIC_TRACK_SESSION: '1' },
      mode: 'rpc',
    });

    const row = sessions.getById('pi-rpc-tracked');
    expect(row?.agent).toBe('pi');
    expect(row?.status).toBe('ended');
    expect(row?.summary).toContain('delegated task under pi-rpc-tracked');
  });

  it('the control — an interactive session with no markers registers and ends the row', async () => {
    await runLifecycle('pi-subagent-control');

    const row = sessions.getById('pi-subagent-control');
    expect(row?.agent).toBe('pi');
    expect(row?.status).toBe('ended');
    expect(row?.summary).toContain('delegated task under pi-subagent-control');
  });
});

describe('the successor session attributes its memories', () => {
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

  it('the control — without the end, the save lands on the successor by pin, and the replaced row is untouched', async () => {
    const { savedSessionId, attributedToSuccessor } = await saveThroughSuccessor('reload');

    expect(savedSessionId).toBe('pi-ambiguity-b-reload');
    expect(attributedToSuccessor).toBeGreaterThan(0);
    expect(repos.memory.adminListBySession('pi-ambiguity-a-reload')).toHaveLength(0);
  });
});

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
      expect(stub.seen).toContain('initialize');
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
    const accepted = new Set<Socket>();
    const blackHole = createSocketServer((socket) => accepted.add(socket));
    await new Promise<void>((resolve) => blackHole.listen(0, '127.0.0.1', resolve));
    const address = blackHole.address();
    const port = typeof address === 'object' && address ? address.port : 0;

    const url = process.env.REMBRIC_SERVER_URL;
    process.env.REMBRIC_SERVER_URL = `http://127.0.0.1:${port}`;
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

describe('session identity declaration on the MCP transport (D4\u2032)', () => {
  async function seedConcurrentRow(): Promise<void> {
    const resolved = await tokens.authenticate(ADMIN_TOKEN);
    sessions.ensure({
      id: 'pi-bind-other',
      tokenId: resolved.token.id,
      projectId: project.id,
      agent: 'pi',
    });
  }

  function spyMcpCalls() {
    const resumeCalls: { transport: string | null; sessionId: unknown }[] = [];
    const toolCalls: string[] = [];
    const realFetch = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/mcp') && typeof init?.body === 'string') {
          const parsed = JSON.parse(init.body) as {
            method?: string;
            params?: { name?: string; arguments?: Record<string, unknown> };
          };
          if (parsed.method === 'tools/call') {
            toolCalls.push(parsed.params?.name ?? '');
            if (parsed.params?.name === 'memory.session_resume') {
              resumeCalls.push({
                transport: new Headers(init.headers).get('mcp-session-id'),
                sessionId: parsed.params.arguments?.sessionId,
              });
            }
          }
        }
        return realFetch(input, init);
      });
    return { resumeCalls, toolCalls, spy, realFetch };
  }

  function resumeErrorResponse(initBody: string): Response {
    const parsed = JSON.parse(initBody) as { id?: number };
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: parsed.id ?? 0,
        result: {
          content: [
            { type: 'text', text: '{"ok":false,"code":"session_not_found","message":"gone"}' },
          ],
          isError: true,
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }

  it('declares its identity after the first ensure, and the pin answers session_start', async () => {
    const sessionId = 'pi-bind-host';
    const harness = await startedHarness(sessionId);
    await seedConcurrentRow();

    const { resumeCalls, toolCalls, spy } = spyMcpCalls();
    try {
      await harness.fire('before_agent_start', { prompt: 'first turn' });
      // The same (transport, host) pair must not re-declare on the next turn.
      await harness.fire('before_agent_start', { prompt: 'second turn' });
    } finally {
      spy.mockRestore();
    }

    expect(resumeCalls).toEqual([{ transport: expect.any(String), sessionId }]);
    expect(toolCalls).not.toContain('memory.session_start');

    const start = await callThroughExtension(toolNamed(harness, 'memory.session_start'), {});
    expect(start.refused).toBe(false);
    const out = JSON.parse(start.text) as { sessionId: string; reused: boolean };
    expect(out.reused).toBe(true);
    expect(out.sessionId).toBe(sessionId);
  });

  it('a failed declaration retries silently on the next turn and then binds', async () => {
    const sessionId = 'pi-bind-retry';
    const harness = await startedHarness(sessionId);
    await seedConcurrentRow();
    const realFetch = globalThis.fetch;
    let failures = 0;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/mcp') && typeof init?.body === 'string') {
          const parsed = JSON.parse(init.body) as { method?: string; params?: { name?: string } };
          if (parsed.method === 'tools/call' && parsed.params?.name === 'memory.session_resume') {
            if (failures === 0) {
              failures += 1;
              return resumeErrorResponse(init.body);
            }
          }
        }
        return realFetch(input, init);
      });
    try {
      await harness.fire('before_agent_start', { prompt: 'turn one' });
      expect(harness.notifications).toHaveLength(0);
      await harness.fire('before_agent_start', { prompt: 'turn two' });
      expect(harness.notifications).toHaveLength(0);
    } finally {
      spy.mockRestore();
    }

    const start = await callThroughExtension(toolNamed(harness, 'memory.session_start'), {});
    const out = JSON.parse(start.text) as { sessionId: string; reused: boolean };
    expect(out.reused).toBe(true);
    expect(out.sessionId).toBe(sessionId);
  });

  it('re-declares on the new transport after it re-initialises', async () => {
    const sessionId = 'pi-bind-reinit';
    const harness = await startedHarness(sessionId);
    const { resumeTransports, spy } = (() => {
      const seen: (string | null)[] = [];
      const realFetch = globalThis.fetch;
      const s = vi
        .spyOn(globalThis, 'fetch')
        .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.includes('/mcp') && typeof init?.body === 'string') {
            const parsed = JSON.parse(init.body) as { method?: string; params?: { name?: string } };
            if (parsed.method === 'tools/call' && parsed.params?.name === 'memory.session_resume') {
              seen.push(new Headers(init.headers).get('mcp-session-id'));
            }
          }
          const res = await realFetch(input, init);
          if (url.includes('/mcp') && typeof init?.body === 'string') {
            const parsed = JSON.parse(init.body) as { method?: string; params?: { name?: string } };
            if (parsed.method === 'tools/call' && parsed.params?.name === 'memory.session_resume') {
              const headers = new Headers(res.headers);
              headers.set('mcp-session-id', 'transport-B');
              return new Response(res.body, { status: res.status, headers });
            }
          }
          return res;
        });
      return { resumeTransports: seen, spy: s };
    })();
    try {
      await harness.fire('before_agent_start', { prompt: 'turn one' }); // declares on A
      await harness.fire('before_agent_start', { prompt: 'turn two' }); // transport is B now
    } finally {
      spy.mockRestore();
    }

    expect(resumeTransports).toHaveLength(2);
    expect(resumeTransports[0]).not.toBe(resumeTransports[1]);
  });

  it('resets the failure budget when the transport re-keys', async () => {
    const sessionId = 'pi-bind-rekey-budget';
    const harness = await startedHarness(sessionId);
    let attempts = 0;
    const realFetch = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/mcp') && typeof init?.body === 'string') {
          const parsed = JSON.parse(init.body) as { method?: string; params?: { name?: string } };
          if (parsed.method === 'tools/call' && parsed.params?.name === 'memory.session_resume') {
            attempts += 1;
            const failed = resumeErrorResponse(init.body);
            // A fresh handshake re-keys the transport once the budget is spent.
            if (attempts === 3) {
              const headers = new Headers(failed.headers);
              headers.set('mcp-session-id', 'transport-after-rekey');
              return new Response(failed.body, { status: failed.status, headers });
            }
            return failed;
          }
        }
        return realFetch(input, init);
      });
    try {
      for (let turn = 1; turn <= 5; turn++) {
        await harness.fire('before_agent_start', { prompt: `turn ${turn}` });
      }
    } finally {
      spy.mockRestore();
    }

    expect(attempts).toBe(5);
  });

  it('two concurrent conversations in one project each save to their own row', async () => {
    const firstId = 'pi-concurrent-a';
    const secondId = 'pi-concurrent-b';

    const a = await startedHarness(firstId);
    const b = await startedHarness(secondId);
    await a.fire('before_agent_start', { prompt: 'conversation A' });
    await b.fire('before_agent_start', { prompt: 'conversation B' });

    const saveA = await callThroughExtension(toolNamed(a, 'memory.save'), {
      type: 'project',
      title: 'saved by conversation A',
      content: 'saved by conversation A',
    });
    const saveB = await callThroughExtension(toolNamed(b, 'memory.save'), {
      type: 'project',
      title: 'saved by conversation B',
      content: 'saved by conversation B',
    });

    expect(saveA.refused).toBe(false);
    expect(saveB.refused).toBe(false);
    const attachedA = repos.memory.unsafeGetById(savedId(saveA.text))?.sessionId ?? null;
    const attachedB = repos.memory.unsafeGetById(savedId(saveB.text))?.sessionId ?? null;

    expect(attachedA).toBe(firstId);
    expect(attachedB).toBe(secondId);
    expect(sessions.getById(firstId)?.status).toBe('active');
    expect(sessions.getById(secondId)?.status).toBe('active');
  });

  it('caps consecutive failures at BIND_FAILURE_LIMIT and degrades silently', async () => {
    const sessionId = 'pi-bind-degrade';
    const harness = await startedHarness(sessionId);
    let attempts = 0;
    const realFetch = globalThis.fetch;
    const spy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        if (url.includes('/mcp') && typeof init?.body === 'string') {
          const parsed = JSON.parse(init.body) as { method?: string; params?: { name?: string } };
          if (parsed.method === 'tools/call' && parsed.params?.name === 'memory.session_resume') {
            attempts += 1;
            return resumeErrorResponse(init.body);
          }
        }
        return realFetch(input, init);
      });
    try {
      const first = (await harness.fire('before_agent_start', { prompt: 'turn 1' })) as {
        message?: { content: string };
      };
      // Nudge injection is unaffected by the silent bind failures.
      expect(first.message?.content).toContain('## Goal');
      for (let turn = 2; turn <= 5; turn++) {
        await harness.fire('before_agent_start', { prompt: `turn ${turn}` });
      }
    } finally {
      spy.mockRestore();
    }

    expect(attempts).toBe(3);
    expect(harness.notifications).toHaveLength(0);
  });
});
