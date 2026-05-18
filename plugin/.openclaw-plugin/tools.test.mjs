import { describe, it, expect } from 'vitest';
import { registerTools, TOOL_DEFINITIONS } from './tools.mjs';

function recordingApi() {
  const tools = new Map();
  return {
    registerTool: (tool) => {
      tools.set(tool.name, tool);
    },
    logger: { warn: () => {}, debug: () => {}, info: () => {} },
    _tools: tools,
  };
}

describe('registerTools', () => {
  it('registers every tool in TOOL_DEFINITIONS', () => {
    const api = recordingApi();
    const client = { callTool: async () => ({ ok: true, data: {} }) };
    registerTools(api, client);
    expect(api._tools.size).toBe(TOOL_DEFINITIONS.length);
    for (const def of TOOL_DEFINITIONS) {
      expect(api._tools.has(def.name)).toBe(true);
    }
  });

  it('matches the manifest contracts.tools list (order + count)', async () => {
    const manifest = JSON.parse(
      (await import('node:fs')).readFileSync(
        new URL('./openclaw.plugin.json', import.meta.url),
        'utf8',
      ),
    );
    const declared = manifest.contracts.tools;
    const registered = TOOL_DEFINITIONS.map((d) => d.name);
    expect(registered).toEqual(declared);
  });

  it('memory_save execute forwards to mcp memory.save', async () => {
    const calls = [];
    const client = {
      callTool: async (name, args) => {
        calls.push([name, args]);
        return { ok: true, data: { id: 'mem-1', candidates: [] } };
      },
    };
    const api = recordingApi();
    registerTools(api, client);
    const tool = api._tools.get('memory_save');
    const result = await tool.execute('tool-call-1', { type: 'project', content: 'hello' });
    expect(calls).toEqual([['memory.save', { type: 'project', content: 'hello' }]]);
    expect(result).toEqual({ id: 'mem-1', candidates: [] });
  });

  it('memory_search execute forwards query + limit', async () => {
    const calls = [];
    const client = {
      callTool: async (name, args) => {
        calls.push([name, args]);
        return { ok: true, data: { count: 0, memories: [] } };
      },
    };
    const api = recordingApi();
    registerTools(api, client);
    const tool = api._tools.get('memory_search');
    await tool.execute('tool-call-1', { query: 'foo', limit: 5 });
    expect(calls).toEqual([['memory.search', { query: 'foo', limit: 5 }]]);
  });

  it('throws when mcp client returns { ok: false }', async () => {
    const client = {
      callTool: async () => ({ ok: false, code: 'mcp_error', message: 'boom' }),
    };
    const api = recordingApi();
    registerTools(api, client);
    const tool = api._tools.get('memory_save');
    await expect(tool.execute('tool-call-1', { type: 'project', content: 'x' })).rejects.toThrow(
      /mcp_error/,
    );
  });

  it('every tool has a non-empty parameters object', () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(def.parameters?.type).toBe('object');
    }
  });

  it('registerTools returns the count of successfully registered tools', () => {
    const api = recordingApi();
    const client = { callTool: async () => ({ ok: true, data: {} }) };
    const count = registerTools(api, client);
    expect(count).toBe(TOOL_DEFINITIONS.length);
  });

  it('registerTools surfaces SDK shape mismatches via api.logger and continues', () => {
    const logs = [];
    const api = {
      registerTool: () => {
        throw new TypeError("Cannot read properties of undefined (reading 'trim')");
      },
      logger: { warn: (m) => logs.push(m) },
    };
    const client = { callTool: async () => ({ ok: true, data: {} }) };
    const count = registerTools(api, client);
    expect(count).toBe(0);
    expect(logs.length).toBe(TOOL_DEFINITIONS.length);
    expect(logs[0]).toMatch(/api\.registerTool failed/);
  });

  it('every tool maps to a dot-form MCP name', () => {
    for (const def of TOOL_DEFINITIONS) {
      expect(def.mcp).toMatch(/^(memory|project)\.[a-z_]+$/);
    }
  });
});
