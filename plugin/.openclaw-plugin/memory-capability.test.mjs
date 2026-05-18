import { describe, it, expect } from 'vitest';
import { registerMemorySurface } from './memory-capability.mjs';

function buildApi(overrides = {}) {
  const registrations = {};
  const logs = [];
  return {
    config: { plugins: { slots: { memory: 'rembric' } } },
    registerMemoryCapability: (cap) => {
      registrations.capability = cap;
    },
    registerMemoryPromptSection: (builder) => {
      registrations.promptSection = builder;
    },
    on: (event, handler) => {
      registrations.hooks ??= {};
      registrations.hooks[event] = handler;
    },
    registerInteractiveHandler: (entry) => {
      registrations.interactive = entry;
    },
    logger: {
      warn: (m) => logs.push(['warn', m]),
      debug: (m) => logs.push(['debug', m]),
    },
    _registrations: registrations,
    _logs: logs,
    ...overrides,
  };
}

const DEFAULT_CONFIG = { autoRecall: true, autoCapture: false, tokenBudget: 1800 };

describe('registerMemorySurface', () => {
  it('claims the memory capability with a promptBuilder', () => {
    const api = buildApi();
    const client = { callTool: async () => ({ ok: true, data: { content: [] } }) };
    registerMemorySurface(api, client, DEFAULT_CONFIG);
    expect(api._registrations.capability).toBeDefined();
    expect(typeof api._registrations.capability.promptBuilder).toBe('function');
    const lines = api._registrations.capability.promptBuilder({});
    expect(Array.isArray(lines)).toBe(true);
    const text = lines.join(' ');
    expect(text).toMatch(/Rembric/);
    expect(text).toContain('memory_save');
    expect(text).toContain('do not edit OpenClaw MEMORY.md');
  });

  it('registers a before_prompt_build hook when autoRecall is true', () => {
    const api = buildApi();
    const client = { callTool: async () => ({ ok: true, data: { content: [] } }) };
    registerMemorySurface(api, client, DEFAULT_CONFIG);
    expect(api._registrations.hooks?.before_prompt_build).toBeDefined();
    expect(api._registrations.promptSection).toBeUndefined();
  });

  it('SKIPS the before_prompt_build hook when autoRecall is false', () => {
    const api = buildApi();
    const client = { callTool: async () => ({ ok: true, data: { content: [] } }) };
    registerMemorySurface(api, client, { ...DEFAULT_CONFIG, autoRecall: false });
    expect(api._registrations.hooks?.before_prompt_build).toBeUndefined();
  });

  it('before_prompt_build hook returns prependContext with memory.search results', async () => {
    const api = buildApi();
    const client = {
      callTool: async (name, args) => {
        expect(name).toBe('memory.search');
        expect(args.query).toBe('what should I do next');
        return {
          ok: true,
          data: { content: [{ type: 'text', text: 'memory A\nmemory B' }] },
        };
      },
    };
    registerMemorySurface(api, client, DEFAULT_CONFIG);
    const hook = api._registrations.hooks.before_prompt_build;
    const out = await hook({ prompt: 'what should I do next' });
    expect(out?.prependContext).toMatch(/Relevant Rembric memories/);
    expect(out?.prependContext).toMatch(/memory A/);
  });

  it('before_prompt_build hook returns null when search fails', async () => {
    const api = buildApi();
    const client = {
      callTool: async () => ({ ok: false, code: 'network_error', message: 'down' }),
    };
    registerMemorySurface(api, client, DEFAULT_CONFIG);
    const hook = api._registrations.hooks.before_prompt_build;
    const out = await hook({ prompt: 'x' });
    expect(out).toBe(null);
    expect(api._logs.some(([l, m]) => l === 'warn' && m.includes('autoRecall'))).toBe(true);
  });

  it('keeps the memory capability promptBuilder synchronous when autoRecall is enabled', () => {
    const api = buildApi({
      registerMemoryPromptSection: () => {
        throw new Error('registerMemoryPromptSection should not be used for async recall');
      },
    });
    const client = { callTool: async () => ({ ok: true, data: { content: [] } }) };
    registerMemorySurface(api, client, DEFAULT_CONFIG);
    const lines = api._registrations.capability.promptBuilder({});
    expect(Array.isArray(lines)).toBe(true);
    expect(lines.join(' ')).toContain('memory_save');
  });

  it('does NOT register an interactive handler (the SDK shape is incompatible with regex matching)', () => {
    const api = buildApi();
    const client = { callTool: async () => ({ ok: true, data: { content: [] } }) };
    registerMemorySurface(api, client, DEFAULT_CONFIG);
    expect(api._registrations.interactive).toBeUndefined();
  });
});
