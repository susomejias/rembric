import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import RembricPluginV2 from './plugin.js';

const BODY = 'Scanned the router.\n\n## Key Learnings\n1. Routes resolve scope before auth.';
const LEARNINGS_PATH = (sessionId: string) => `/api/demo/sessions/${sessionId}/learnings`;

type Call = { path: string; body: unknown };

let dir: string;
let calls: Call[];
const realFetch = globalThis.fetch;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'rembric-opencode-subagent-'));
  writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=demo\n');
  process.env.REMBRIC_SERVER_URL = 'http://localhost:9999';
  process.env.REMBRIC_API_TOKEN = 'test-token';
  calls = [];
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return new Response('{"ok":true}', { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
  delete process.env.REMBRIC_SERVER_URL;
  delete process.env.REMBRIC_API_TOKEN;
  vi.restoreAllMocks();
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function learnings(): Call[] {
  return calls.filter((c) => c.path.endsWith('/learnings'));
}

describe('opencode 2.x forwards subagent reports from the session inbox', () => {
  function fakeContext() {
    const queue: unknown[] = [];
    let release: ((result: IteratorResult<unknown>) => void) | null = null;
    let ended = false;
    const stream = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next(): Promise<IteratorResult<unknown>> {
        if (queue.length > 0) return Promise.resolve({ value: queue.shift(), done: false });
        if (ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => {
          release = resolve;
        });
      },
      push(value: unknown) {
        if (release) {
          const resolve = release;
          release = null;
          resolve({ value, done: false });
          return;
        }
        queue.push(value);
      },
      end() {
        ended = true;
        if (release) {
          const resolve = release;
          release = null;
          resolve({ value: undefined, done: true });
        }
      },
    };
    const context = {
      app: { version: '2.3.0' },
      location: { directory: dir },
      session: {
        hook: async () => ({}),
        get: async () => ({ location: { directory: dir } }),
      },
      tool: { hook: async () => ({}) },
      event: { subscribe: () => stream },
    };
    return { context, stream };
  }

  function inboxEvent(sessionID: string, item: Record<string, unknown>) {
    return {
      id: 'evt_1',
      created: 1,
      type: 'session.inbox.enqueued',
      durable: { aggregateID: sessionID, seq: 7, version: 1 },
      data: { sessionID, inboxID: 'msg_inbox_1', item },
    };
  }

  function subagentItem(text: string, metadata: Record<string, unknown> = {}) {
    return {
      type: 'synthetic',
      delivery: 'queue',
      payload: {
        text,
        description: 'scan',
        metadata: {
          source: 'subagent',
          childID: 'c1',
          agent: 'explore',
          state: 'completed',
          ...metadata,
        },
      },
    };
  }

  const wrapped = (body: string, state = 'completed') =>
    `<subagent sessionID="c1" state="${state}" description="scan">\n${body}\n</subagent>`;

  async function started() {
    const fake = fakeContext();
    const cleanup = await RembricPluginV2.setup(fake.context as never);
    fake.stream.push({ type: 'session.created', data: { sessionID: 'P' } });
    await settle();
    return { ...fake, cleanup };
  }

  it('A 2.x subagent report is forwarded to the parent', async () => {
    const { stream, cleanup } = await started();

    stream.push(inboxEvent('P', subagentItem(wrapped(BODY))));
    await settle();

    expect(learnings()).toEqual([
      { path: LEARNINGS_PATH('P'), body: { report: BODY, agentType: 'explore' } },
    ]);
    stream.end();
    await cleanup?.();
  });

  it('drops the trailing list of background work still running', async () => {
    const { stream, cleanup } = await started();
    const withRunning = `${BODY}\n\nBackground work still running:\n- shell (sh_1): pnpm test\n- subagent (explore, sessionID: c2): scan docs`;

    stream.push(inboxEvent('P', subagentItem(wrapped(withRunning, 'running'))));
    await settle();

    expect(learnings().map((c) => c.body)).toEqual([{ report: BODY, agentType: 'explore' }]);
    stream.end();
    await cleanup?.();
  });

  it('Other inbox items are ignored', async () => {
    const { stream, cleanup } = await started();

    stream.push(
      inboxEvent('P', {
        type: 'user',
        delivery: 'queue',
        payload: { text: wrapped(BODY), metadata: { source: 'subagent', agent: 'explore' } },
      }),
    );
    stream.push(inboxEvent('P', subagentItem(wrapped(BODY), { source: 'goal' })));
    stream.push(
      inboxEvent('P', { type: 'synthetic', delivery: 'queue', payload: { text: wrapped(BODY) } }),
    );
    await settle();

    expect(learnings()).toEqual([]);
    stream.end();
    await cleanup?.();
  });

  it('does not forward a report delivered to a session marked as a subagent', async () => {
    const { stream, cleanup } = await started();
    stream.push({ type: 'session.created', data: { sessionID: 'C1', parentID: 'P' } });
    await settle();

    stream.push(inboxEvent('C1', subagentItem(wrapped(BODY))));
    await settle();

    expect(learnings()).toEqual([]);
    stream.end();
    await cleanup?.();
  });

  it('leaves the observed event and inbox item unchanged', async () => {
    const { stream, cleanup } = await started();
    const event = inboxEvent('P', subagentItem(wrapped(`a <private>k</private> b\n${BODY}`)));
    const snapshot = structuredClone(event);

    stream.push(event);
    await settle();

    expect(event).toEqual(snapshot);
    expect(learnings().map((c) => c.body)).toEqual([
      { report: `a [REDACTED] b\n${BODY}`, agentType: 'explore' },
    ]);
    stream.end();
    await cleanup?.();
  });

  it('still never registers a subagent session as a session', async () => {
    const { stream, cleanup } = await started();

    stream.push({ type: 'session.created', data: { sessionID: 'C2', parentID: 'P' } });
    await settle();

    const registered = calls.filter((c) => c.path === '/api/demo/sessions');
    expect(registered.map((c) => (c.body as { id: string }).id)).toEqual(['P']);
    stream.end();
    await cleanup?.();
  });
});
