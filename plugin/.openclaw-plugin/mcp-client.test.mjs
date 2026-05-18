import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createMcpClient } from './mcp-client.mjs';

describe('createMcpClient', () => {
  const baseConfig = { serverUrl: 'http://example.test', apiToken: 'rbr_abc', slug: null };
  let originalFetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function buildMockFetch({ initSessionId = 'sess-abc', tools = {} } = {}) {
    const calls = [];
    let initialized = false;
    return {
      calls,
      fetch: vi.fn(async (url, init) => {
        calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
        const body = init?.body ? JSON.parse(init.body) : {};
        if (body.method === 'initialize') {
          initialized = true;
          return {
            ok: true,
            status: 200,
            headers: { get: (h) => (h === 'mcp-session-id' ? initSessionId : null) },
            text: async () =>
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: { protocolVersion: '2024-11-05', capabilities: {} },
              }),
          };
        }
        if (body.method === 'notifications/initialized') {
          return {
            ok: true,
            status: 202,
            headers: { get: () => null },
            text: async () => '',
          };
        }
        if (body.method === 'tools/call') {
          if (!initialized) {
            return {
              ok: false,
              status: 400,
              text: async () => 'not initialized',
              headers: { get: () => null },
            };
          }
          const sid = init?.headers?.['mcp-session-id'];
          if (sid !== initSessionId) {
            return {
              ok: false,
              status: 404,
              text: async () => 'session not found',
              headers: { get: () => null },
            };
          }
          const toolName = body.params?.name;
          const handler = tools[toolName];
          if (!handler) {
            return {
              ok: true,
              status: 200,
              headers: { get: () => null },
              text: async () =>
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: body.id,
                  error: { code: -32601, message: `unknown tool: ${toolName}` },
                }),
            };
          }
          return {
            ok: true,
            status: 200,
            headers: { get: () => null },
            text: async () =>
              JSON.stringify({
                jsonrpc: '2.0',
                id: body.id,
                result: handler(body.params?.arguments),
              }),
          };
        }
        return {
          ok: false,
          status: 400,
          text: async () => 'unknown method',
          headers: { get: () => null },
        };
      }),
    };
  }

  it('initializes lazily on first callTool and reuses session for subsequent calls', async () => {
    const mock = buildMockFetch({
      tools: {
        'memory.search': () => ({ content: [{ type: 'text', text: 'results' }] }),
      },
    });
    globalThis.fetch = mock.fetch;
    const client = createMcpClient(baseConfig);
    expect(client.sessionId).toBe(null);

    const r1 = await client.callTool('memory.search', { query: 'foo' });
    expect(r1.ok).toBe(true);
    expect(r1.data?.content?.[0]?.text).toBe('results');
    expect(client.sessionId).toBe('sess-abc');

    const r2 = await client.callTool('memory.search', { query: 'bar' });
    expect(r2.ok).toBe(true);

    // Should have: initialize + notifications/initialized + 2 tools/call = 4 total.
    const methods = mock.calls.map((c) => c.body?.method);
    expect(methods.filter((m) => m === 'initialize')).toHaveLength(1);
    expect(methods.filter((m) => m === 'tools/call')).toHaveLength(2);
  });

  it('surfaces MCP error responses as { ok: false, code: "mcp_error" }', async () => {
    const mock = buildMockFetch({ tools: {} });
    globalThis.fetch = mock.fetch;
    const client = createMcpClient(baseConfig);
    const res = await client.callTool('memory.search', { query: 'x' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('mcp_error');
  });

  it('surfaces network failures during init as { ok: false, code: "mcp_init_failed" }', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new TypeError('network error');
    });
    const client = createMcpClient(baseConfig);
    const res = await client.callTool('memory.search', { query: 'x' });
    expect(res.ok).toBe(false);
    expect(res.code).toBe('mcp_init_failed');
  });

  it('throws when serverUrl is missing', () => {
    expect(() => createMcpClient({ apiToken: 'x' })).toThrow();
  });

  it('throws when apiToken is missing', () => {
    expect(() => createMcpClient({ serverUrl: 'http://example.test' })).toThrow();
  });

  it('builds URL with slug when provided', async () => {
    const mock = buildMockFetch({
      tools: { 'memory.stats': () => ({ content: [] }) },
    });
    globalThis.fetch = mock.fetch;
    const client = createMcpClient({ ...baseConfig, slug: 'proj-x' });
    await client.callTool('memory.stats', {});
    expect(mock.calls[0].url).toBe('http://example.test/mcp/proj-x');
  });
});
