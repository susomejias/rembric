import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { registerHooks } from './hooks.mjs';

function recordingApi() {
  const hooks = new Map();
  const logs = [];
  return {
    on: (name, handler) => {
      if (!hooks.has(name)) hooks.set(name, []);
      hooks.get(name).push(handler);
    },
    logger: {
      warn: (m) => logs.push(['warn', m]),
      debug: (m) => logs.push(['debug', m]),
      info: (m) => logs.push(['info', m]),
    },
    _hooks: hooks,
    _logs: logs,
    async fire(name, event) {
      const handlers = hooks.get(name) || [];
      for (const h of handlers) await h(event);
    },
  };
}

function recordingClient() {
  return {
    calls: [],
    readProjectSlug: (cwd) => (cwd && cwd.includes('with-slug') ? 'foo' : null),
    async createSession(args) {
      this.calls.push(['createSession', args]);
      return { ok: true, data: { ok: true } };
    },
    async summarizeSession(args) {
      this.calls.push(['summarizeSession', args]);
      return { ok: true, data: { ok: true } };
    },
    async endSession(args) {
      this.calls.push(['endSession', args]);
      return { ok: true, data: { ok: true } };
    },
  };
}

describe('registerHooks', () => {
  it('wires session_start to createSession when slug resolves', async () => {
    const api = recordingApi();
    const client = recordingClient();
    registerHooks(api, client);
    await api.fire('session_start', { sessionId: 'sess-12345678', cwd: '/work/with-slug' });
    expect(client.calls).toHaveLength(1);
    const [name, args] = client.calls[0];
    expect(name).toBe('createSession');
    expect(args).toMatchObject({
      slug: 'foo',
      id: 'sess-12345678',
      cwd: '/work/with-slug',
      agent: 'openclaw',
    });
  });

  it('skips session_start POST when slug is null', async () => {
    const api = recordingApi();
    const client = recordingClient();
    registerHooks(api, client);
    await api.fire('session_start', { sessionId: 'sess-12345678', cwd: '/work/no-slug-here' });
    expect(client.calls).toHaveLength(0);
  });

  it('session_end posts summary + title with final=false', async () => {
    const api = recordingApi();
    const client = recordingClient();
    registerHooks(api, client);
    await api.fire('session_end', {
      sessionId: 'sess-12345678',
      cwd: '/work/with-slug',
      transcript: 'some transcript text',
      title: 'My session',
    });
    expect(client.calls).toHaveLength(1);
    const [name, args] = client.calls[0];
    expect(name).toBe('endSession');
    expect(args).toMatchObject({
      slug: 'foo',
      sessionId: 'sess-12345678',
      summary: 'some transcript text',
      title: 'My session',
      final: false,
    });
  });

  it('compaction handlers POST summary with final=false', async () => {
    const api = recordingApi();
    const client = recordingClient();
    registerHooks(api, client);
    await api.fire('before_compaction', {
      sessionId: 'sess-12345678',
      cwd: '/work/with-slug',
      summary: 'pre-compact summary',
    });
    await api.fire('after_compaction', {
      sessionId: 'sess-12345678',
      cwd: '/work/with-slug',
      summary: 'post-compact summary',
    });
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0][0]).toBe('summarizeSession');
    expect(client.calls[0][1]).toMatchObject({ summary: 'pre-compact summary', final: false });
    expect(client.calls[1][1]).toMatchObject({ summary: 'post-compact summary', final: false });
  });

  it('handlers never throw out of hook even when client throws', async () => {
    const api = recordingApi();
    const client = {
      readProjectSlug: () => 'foo',
      createSession: async () => {
        throw new Error('boom');
      },
      summarizeSession: async () => {
        throw new Error('boom');
      },
      endSession: async () => {
        throw new Error('boom');
      },
    };
    registerHooks(api, client);
    await expect(
      api.fire('session_start', { sessionId: 'sess-12345678', cwd: '/x' }),
    ).resolves.not.toThrow();
    expect(api._logs.some(([level]) => level === 'warn')).toBe(true);
  });

  it('extracts transcript from messages array fallback', async () => {
    const api = recordingApi();
    const client = recordingClient();
    registerHooks(api, client);
    await api.fire('session_end', {
      sessionId: 'sess-12345678',
      cwd: '/work/with-slug',
      messages: [
        { role: 'user', content: 'hello' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi back' }],
        },
      ],
    });
    const args = client.calls[0]?.[1];
    expect(args?.summary).toContain('[user] hello');
    expect(args?.summary).toContain('[assistant] hi back');
  });
});
