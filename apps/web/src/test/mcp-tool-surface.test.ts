import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DESCRIPTION_MAX_LENGTH } from '@rembric/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST } from '../app/mcp/[[...path]]/route';
import { getServices } from '../lib/services';

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { raw: { close: () => void }; close: () => void };
  __rembricMcpSurface?: { close?: () => Promise<void> };
};

const globalForApp = globalThis as MutableGlobal;

function resetAppGlobals(): void {
  globalForApp.__rembricDb?.close();
  delete globalForApp.__rembricServices;
  delete globalForApp.__rembricDb;
  delete globalForApp.__rembricMcpSurface;
}

const ORIGIN = 'http://127.0.0.1:8787';
const MEASUREMENTS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../openspec/changes/archive/2026-11-16-collapse-mcp-onto-stateless-sdk-v2/measurements',
);
const BASE_TOOLS_LIST = join(MEASUREMENTS, 'tools-list-base.json');
const BASE_TOOL_CALL_ERRORS = join(MEASUREMENTS, 'tool-call-errors-base.json');

const TOOL_CALL_ERROR_PARAMS: Record<string, { name: string; arguments?: unknown }> = {
  unknown: { name: 'no.such_tool', arguments: {} },
  noArgs: { name: 'memory.about' },
  noArgsRequired: { name: 'memory.save' },
  invalid: { name: 'memory.save', arguments: { type: 'user', title: 't', content: 'c' } },
  extraKey: { name: 'memory.about', arguments: { bogus: 1 } },
};

interface Tool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  outputSchema?: unknown;
  annotations?: Record<string, unknown>;
}

const CHANGED_DESCRIPTIONS: Record<string, string> = {
  'memory.session_start': "project? (slug; must name this connection's project, else scope_locked)",
  'memory.session_resume': 'Resuming binds nothing to this connection',
  'project.current': 'Report the project active in this session (slug, projectId, source).',
  'memory.capture_passive': 'counted in `skipped`',
  'memory.context':
    'A host hook asking you to call it with `focus` on the first turn is not speculative',
};

function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v,
  );
}

async function readJsonRpc(res: Response): Promise<{ result?: unknown; error?: unknown }> {
  const text = await res.text();
  if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data: '))
      .map((line) => line.slice('data: '.length));
    return JSON.parse(data.join('')) as { result?: unknown; error?: unknown };
  }
  return JSON.parse(text) as { result?: unknown; error?: unknown };
}

describe('the tool surface against the base recorded before the SDK v2 port', () => {
  let dataDir: string;
  let adminToken: string;

  beforeAll(() => {
    resetAppGlobals();
    dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-tool-surface-'));
    process.env['REMBRIC_DATA_DIR'] = dataDir;
    delete process.env['REMBRIC_PUBLIC_URL'];
    adminToken = getServices().tokens.create({ name: 'tool-surface-admin', scope: '*' }).plaintext;
  });

  afterAll(async () => {
    await globalForApp.__rembricMcpSurface?.close?.();
    await new Promise((resolve) => setImmediate(resolve));
    resetAppGlobals();
    delete process.env['REMBRIC_DATA_DIR'];
    rmSync(dataDir, { recursive: true, force: true });
  });

  function post(body: unknown): Promise<Response> {
    return POST(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({}) },
    );
  }

  async function initialize(): Promise<void> {
    const init = await post({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'tool-surface', version: '0' },
      },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get('mcp-session-id')).toBeNull();
    await init.text();

    const initialized = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    expect(initialized.status).toBe(202);
  }

  async function liveTools(): Promise<Tool[]> {
    await initialize();
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(list.status).toBe(200);
    const { result } = await readJsonRpc(list);
    return (result as { tools: Tool[] }).tools;
  }

  it('returns the base tools minus project.use plus project.bind_repository and project.create, changed only where those reach', async () => {
    const all = await liveTools();
    const added = ['project.bind_repository', 'project.create'];
    const live = all.filter((t) => !added.includes(t.name));
    const byName = new Map(live.map((t) => [t.name, t]));

    const base = (JSON.parse(readFileSync(BASE_TOOLS_LIST, 'utf8')) as { tools: Tool[] }).tools;
    expect(base).toHaveLength(25);
    expect(all).toHaveLength(26);
    expect(live).toHaveLength(24);
    expect(byName.has('project.use')).toBe(false);

    const expected = base
      .filter((t) => t.name !== 'project.use')
      .map((t) => {
        const changed = CHANGED_DESCRIPTIONS[t.name];
        if (changed === undefined) return t;
        expect(t.description).not.toBe(byName.get(t.name)?.description);
        return { ...t, description: byName.get(t.name)?.description };
      })
      .map((t) => {
        if (t.name !== 'project.current') return t;
        const schema = t.outputSchema as {
          properties: Record<string, unknown>;
          required: string[];
        };
        const { suggestedSlugs: _dropped, ...properties } = schema.properties;
        void _dropped;
        const liveSchema = byName.get(t.name)?.outputSchema as {
          properties: Record<string, unknown>;
          required: string[];
        };
        expect(liveSchema.required).not.toContain('repository');
        return {
          ...t,
          outputSchema: {
            ...schema,
            properties: { ...properties, repository: liveSchema.properties['repository'] },
            required: schema.required.filter((r) => r !== 'suggestedSlugs'),
          },
        };
      })
      .map((t) => {
        if (t.name !== 'memory.capture_passive') return t;
        type ObjectSchema = { properties: Record<string, unknown>; required: string[] };
        const schema = t.outputSchema as ObjectSchema;
        const liveSchema = byName.get(t.name)?.outputSchema as ObjectSchema;
        expect(liveSchema.properties['skipped']).toEqual({ type: 'number' });
        expect([...liveSchema.required].sort()).toEqual([...schema.required, 'skipped'].sort());
        return {
          ...t,
          outputSchema: {
            ...schema,
            properties: { ...schema.properties, skipped: liveSchema.properties['skipped'] },
            required: liveSchema.required,
          },
        };
      });
    expect({ tools: live }).toEqual({ tools: expected });
    expect(canonicalJson({ tools: live })).toBe(canonicalJson({ tools: expected }));

    for (const [name, mustContain] of Object.entries(CHANGED_DESCRIPTIONS)) {
      const description = byName.get(name)?.description ?? '';
      expect(description).toContain(mustContain);
      expect(description).not.toMatch(/roots|project\.use|suggestedSlugs/);
    }
  });

  it('memory.context separates a hook-requested focused call from a speculative load', async () => {
    const tool = (await liveTools()).find((t) => t.name === 'memory.context');
    const description = tool?.description ?? '';
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);
    expect(description).toContain('do not load it speculatively on every session start');
    expect(description).toContain('make that call before responding');
    expect(description).toContain(
      'Speculative means a call with no `focus` that no hook requested',
    );
  });

  it('adds project.bind_repository with a strict slug-only input and write annotations', async () => {
    const tool = (await liveTools()).find((t) => t.name === 'project.bind_repository');
    expect(tool).toBeDefined();
    const description = tool?.description ?? '';
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);
    expect(description).toContain('Admin token');
    expect(description).toContain('no binding yet');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: { slug: { type: 'string' } },
      required: ['slug'],
      additionalProperties: false,
    });
    expect(Object.keys((tool?.inputSchema as { properties: object }).properties)).toEqual(['slug']);
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it('adds project.create with a strict input, an opt-in bind and write annotations', async () => {
    const tool = (await liveTools()).find((t) => t.name === 'project.create');
    expect(tool).toBeDefined();
    const description = tool?.description ?? '';
    expect(description.length).toBeLessThanOrEqual(DESCRIPTION_MAX_LENGTH);
    expect(description).toContain('Admin token');
    expect(description).toContain('opt-in');
    expect(tool?.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        slug: { type: 'string' },
        displayName: { type: 'string' },
        bindRepository: { type: 'boolean' },
      },
      required: ['slug'],
      additionalProperties: false,
    });
    expect(Object.keys((tool?.inputSchema as { properties: object }).properties).sort()).toEqual([
      'bindRepository',
      'displayName',
      'slug',
    ]);
    expect(tool?.annotations).toMatchObject({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
    });
  });

  it.each(Object.keys(TOOL_CALL_ERROR_PARAMS))(
    'answers the %s tools/call refusal exactly as the base',
    async (shape) => {
      const base = (
        JSON.parse(readFileSync(BASE_TOOL_CALL_ERRORS, 'utf8')) as Record<string, unknown>
      )[shape];
      await initialize();
      const res = await post({
        jsonrpc: '2.0',
        id: 9,
        method: 'tools/call',
        params: TOOL_CALL_ERROR_PARAMS[shape],
      });
      expect(res.status).toBe(200);
      expect(await readJsonRpc(res)).toEqual(base);
    },
  );
});
