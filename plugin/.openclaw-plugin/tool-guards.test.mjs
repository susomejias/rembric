import { describe, it, expect } from 'vitest';

import { isOpenClawMemoryPath, registerToolGuards } from './tool-guards.mjs';

function recordingApi() {
  const hooks = new Map();
  const logs = [];
  return {
    on: (name, handler) => {
      hooks.set(name, handler);
    },
    logger: {
      warn: (m) => logs.push(['warn', m]),
      debug: (m) => logs.push(['debug', m]),
    },
    _hooks: hooks,
    _logs: logs,
  };
}

describe('isOpenClawMemoryPath', () => {
  it('matches OpenClaw file-backed memory paths', () => {
    expect(isOpenClawMemoryPath('/workspace/MEMORY.md')).toBe(true);
    expect(isOpenClawMemoryPath('/workspace/memory/2026-05-18.md')).toBe(true);
  });

  it('does not match unrelated markdown paths', () => {
    expect(isOpenClawMemoryPath('/workspace/docs/memory.md')).toBe(false);
    expect(isOpenClawMemoryPath('/workspace/memory/nested/file.md')).toBe(false);
  });
});

describe('registerToolGuards', () => {
  it('registers before_tool_call and blocks OpenClaw MEMORY.md writes', () => {
    const api = recordingApi();
    expect(registerToolGuards(api)).toBe(1);

    const handler = api._hooks.get('before_tool_call');
    const result = handler({
      toolName: 'apply_patch',
      params: {},
      derivedPaths: ['/workspace/MEMORY.md'],
    });

    expect(result).toMatchObject({
      block: true,
    });
    expect(result.blockReason).toContain('memory_save');
  });

  it('does not block Rembric memory tools even if content mentions MEMORY.md', () => {
    const api = recordingApi();
    registerToolGuards(api);

    const handler = api._hooks.get('before_tool_call');
    const result = handler({
      toolName: 'memory_save',
      params: { content: 'Do not edit MEMORY.md' },
    });

    expect(result).toBeUndefined();
  });

  it('allows unrelated tool calls', () => {
    const api = recordingApi();
    registerToolGuards(api);

    const handler = api._hooks.get('before_tool_call');
    const result = handler({
      toolName: 'apply_patch',
      params: { patch: '*** Update File: README.md' },
      derivedPaths: ['/workspace/README.md'],
    });

    expect(result).toBeUndefined();
  });
});
