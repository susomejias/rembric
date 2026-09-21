import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AuthInfo } from '@modelcontextprotocol/server';
import { DomainError } from '@rembric/core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { domainErr } from '../lib/api';
import { getMcpSurface, type McpHttpSurface } from '../lib/mcp-server';

/**
 * The "unexpected failure" contract shared by the two HTTP surfaces: the real
 * message and stack belong in the server log, and the caller gets a generic
 * message plus a correlatable `errorId` — never the raw text.
 *
 * On the `/api` side that is `lib/api.ts`'s private `internalError`, the port of
 * `apps/server/src/server/error-response.ts::httpInternalError`; the exported
 * `domainErr` is the real code path that reaches it, so the shape is asserted
 * through the function the route handlers actually call. The domain-error
 * branch is the control: a `DomainError` keeps its own code and status, which
 * is what keeps `internal_error` an exception rather than the default.
 *
 * On the MCP side the same contract lives in `lib/mcp-server.ts`'s
 * `logInternalError`, which is module-private and reaches the wire only through
 * a tool failure. It is driven here end to end: a real `initialize` handshake
 * against the real Streamable-HTTP surface, then a real `memory.search` call
 * that fails before it can resolve a request context. That the tool answers
 * `internal_error` with an id the log carries proves the callback is wired into
 * the tool path, which the retired `error-response.test.ts` could only assert
 * against a standalone helper.
 */

type MutableGlobal = typeof globalThis & {
  __rembricServices?: unknown;
  __rembricDb?: { raw: { close: () => void }; close: () => void };
  __rembricMcpSurface?: { close?: () => Promise<void> } | McpHttpSurface;
};

const globalForApp = globalThis as MutableGlobal;

function resetAppGlobals(): void {
  try {
    globalForApp.__rembricDb?.close();
  } catch {
    // ignore double-close of a fixture the process already closed
  }
  delete globalForApp.__rembricServices;
  delete globalForApp.__rembricDb;
  delete globalForApp.__rembricMcpSurface;
}

describe("httpInternalError shape (via the /api surface's domainErr)", () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  async function bodyOf(err: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
    const response = domainErr(err);
    return { status: response.status, json: (await response.json()) as Record<string, unknown> };
  }

  it('never returns the raw error message or stack to the client', async () => {
    const r = await bodyOf(new Error('/data/rembric/secret-path leaked in a stack trace'));
    expect(JSON.stringify(r.json)).not.toContain('secret-path');
    expect(r.status).toBe(500);
    expect(r.json).toMatchObject({
      ok: false,
      code: 'internal_error',
      message: 'An unexpected error occurred.',
    });
    expect(typeof r.json.errorId).toBe('string');
    expect((r.json.errorId as string).length).toBeGreaterThan(0);
  });

  it('logs the real error server-side with the same id returned to the client', async () => {
    const r = await bodyOf(new Error('boom'));
    const id = r.json.errorId as string;
    const calls = errorSpy.mock.calls.map((args) => JSON.stringify(args));
    expect(calls.some((c) => c.includes(id))).toBe(true);
    expect(calls.some((c) => c.includes('boom'))).toBe(true);
    expect(calls.some((c) => c.includes('unhandled API request error'))).toBe(true);
  });

  it('handles a thrown non-Error value without crashing', async () => {
    const r = await bodyOf('a plain string throw');
    expect(r.status).toBe(500);
    expect(r.json).toMatchObject({ ok: false, code: 'internal_error' });
  });

  it('CONTROL: a DomainError keeps its own code and status', async () => {
    const r = await bodyOf(new DomainError('session_not_found', "session 'x' not found"));
    expect(r.status).toBe(404);
    expect(r.json).toMatchObject({ ok: false, code: 'session_not_found' });
    expect(errorSpy).not.toHaveBeenCalled();
  });
});

/**
 * The MCP leg. `getMcpSurface()` builds its server from `getServices()`, and
 * `initialize` succeeds without a request context — the context is installed by
 * the `/mcp` route, and its absence is what the failing tool call exercises.
 */
describe('MCP internal_error shape (logInternalError over the real surface)', () => {
  const ORIGIN = 'http://127.0.0.1:8787';
  const AUTH_INFO: AuthInfo = {
    token: 'fixture-bearer',
    clientId: 'fixture-client',
    scopes: ['*'],
    expiresAt: 4_102_444_800,
  };

  let dataDir: string;
  let surface: McpHttpSurface;
  let errorCalls: unknown[][];
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(() => {
    resetAppGlobals();
    dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-mcp-errors-'));
    process.env['REMBRIC_DATA_DIR'] = dataDir;
    delete process.env['REMBRIC_PUBLIC_URL'];
    surface = getMcpSurface();
  });

  afterAll(() => {
    resetAppGlobals();
    delete process.env['REMBRIC_DATA_DIR'];
    rmSync(dataDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    errorCalls = [];
    errorSpy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      errorCalls.push(args);
    });
  });

  afterEach(() => errorSpy.mockRestore());

  function rpc(body: unknown, sessionId?: string): Promise<Response> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (sessionId !== undefined) headers['mcp-session-id'] = sessionId;
    return surface.fetch(
      new Request(`${ORIGIN}/mcp`, { method: 'POST', headers, body: JSON.stringify(body) }),
      { authInfo: AUTH_INFO, requestedSlug: null },
    );
  }

  /** The legacy leg answers a POST with either JSON or a single SSE frame. */
  async function rpcJson(
    body: unknown,
    sessionId?: string,
  ): Promise<{ response: Response; json: Record<string, unknown> }> {
    const response = await rpc(body, sessionId);
    const text = await response.text();
    const payload =
      text.startsWith('event:') || text.startsWith('data:')
        ? (text
            .split('\n')
            .filter((l) => l.startsWith('data:'))
            .map((l) => l.slice('data:'.length).trim())
            .join('') ?? '')
        : text;
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(payload) as Record<string, unknown>;
    } catch {
      json = {};
    }
    return { response, json };
  }

  /** A live 2025-era session, exactly as a client establishes one. */
  async function openSession(): Promise<string> {
    const init = await rpcJson({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mcp-errors-test', version: '0.0.0' },
      },
    });
    expect(init.response.status).toBe(200);
    const sessionId = init.response.headers.get('mcp-session-id');
    if (sessionId === null) throw new Error('fixture: initialize did not establish a session');
    await rpc({ jsonrpc: '2.0', method: 'notifications/initialized' }, sessionId);
    return sessionId;
  }

  it('answers a failing tool with a generic message plus an id, and logs the real error under it', async () => {
    const sessionId = await openSession();

    // No `runWithContext` was installed, so the handler's scope resolution
    // throws a plain Error — the non-DomainError branch, which is the one under
    // test.
    const { json } = await rpcJson(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'memory.search', arguments: { query: 'anything' } },
      },
      sessionId,
    );

    const result = json.result as
      | { isError?: boolean; content?: Array<{ text?: string }> }
      | undefined;
    expect(result?.isError).toBe(true);

    const payload = JSON.parse(result?.content?.[0]?.text ?? '{}') as Record<string, unknown>;
    expect(payload).toMatchObject({
      ok: false,
      code: 'internal_error',
      message: 'An unexpected error occurred.',
    });
    const errorId = payload.errorId;
    expect(typeof errorId).toBe('string');
    expect(JSON.stringify(json)).not.toContain('request context missing');

    // The log carries that same id together with the real message and stack —
    // which the client never sees.
    const logged = errorCalls.find(
      (args) =>
        typeof args[1] === 'object' &&
        args[1] !== null &&
        (args[1] as { errorId?: unknown }).errorId === errorId,
    );
    expect(logged).toBeDefined();
    const detail = logged?.[1] as { message?: unknown; stack?: unknown };
    expect(String(detail.message)).toContain('request context missing');
    expect(String(detail.stack)).toContain('request context missing');
    expect(String(logged?.[0])).toContain('[mcp]');
  });

  it('keeps the session serving after a tool failure', async () => {
    const sessionId = await openSession();

    await rpcJson(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'memory.search', arguments: { query: 'anything' } },
      },
      sessionId,
    );

    // The failure was the tool's, not the transport's: the same session answers
    // the next request, which is what makes the assertion above evidence about
    // `logInternalError` rather than about a broken handshake.
    const { response, json } = await rpcJson(
      { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} },
      sessionId,
    );
    expect(response.status).toBe(200);
    expect(json.result).toBeDefined();
  });
});
