import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { POST } from '../app/mcp/[[...path]]/route';
import { getServices } from '../lib/services';

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { raw: { close: () => void }; close: () => void };
  __rembricMcpSurface?: { close?: () => Promise<void> };
  __rembricSessionRouter?: unknown;
};

const globalForApp = globalThis as MutableGlobal;

function resetAppGlobals(): void {
  globalForApp.__rembricDb?.close();
  delete globalForApp.__rembricServices;
  delete globalForApp.__rembricDb;
  delete globalForApp.__rembricMcpSurface;
  delete globalForApp.__rembricSessionRouter;
}

const ORIGIN = 'http://127.0.0.1:8787';
const MEASUREMENTS = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../openspec/changes/collapse-mcp-onto-stateless-sdk-v2/measurements',
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

  function post(body: unknown, sessionId?: string): Promise<Response> {
    return POST(
      new Request(`${ORIGIN}/mcp`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          ...(sessionId === undefined ? {} : { 'mcp-session-id': sessionId }),
        },
        body: JSON.stringify(body),
      }),
      { params: Promise.resolve({}) },
    );
  }

  async function openSession(): Promise<string | undefined> {
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
    const sessionId = init.headers.get('mcp-session-id') ?? undefined;
    await init.text();

    const initialized = await post(
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId,
    );
    expect(initialized.status).toBe(202);
    return sessionId;
  }

  it('returns the 25 tools of the base byte-for-byte after key-order normalization', async () => {
    const sessionId = await openSession();
    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list' }, sessionId);
    expect(list.status).toBe(200);
    const { result } = await readJsonRpc(list);

    const base: unknown = JSON.parse(readFileSync(BASE_TOOLS_LIST, 'utf8'));
    expect((result as { tools: unknown[] }).tools).toHaveLength(25);
    expect(result).toEqual(base);
    expect(canonicalJson(result)).toBe(canonicalJson(base));
  });

  it.each(Object.keys(TOOL_CALL_ERROR_PARAMS))(
    'answers the %s tools/call refusal exactly as the base',
    async (shape) => {
      const base = (
        JSON.parse(readFileSync(BASE_TOOL_CALL_ERRORS, 'utf8')) as Record<string, unknown>
      )[shape];
      const sessionId = await openSession();
      const res = await post(
        { jsonrpc: '2.0', id: 9, method: 'tools/call', params: TOOL_CALL_ERROR_PARAMS[shape] },
        sessionId,
      );
      expect(res.status).toBe(200);
      expect(await readJsonRpc(res)).toEqual(base);
    },
  );
});
