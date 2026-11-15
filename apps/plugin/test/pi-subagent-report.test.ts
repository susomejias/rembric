import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import rembric from './index.js';

const SLUG = 'pi-subagent-report';
const BODY = 'Checked the parser.\n\n## Key Learnings\n1. The tokenizer folds diacritics.';
const CHILD_MARKERS = [
  'REMBRIC_SUBAGENT',
  'GENTLE_PI_AGENTS_CHILD',
  'PI_SUBAGENT_CHILD',
  'REMBRIC_TRACK_SESSION',
] as const;

type Call = { path: string; body: unknown };
type Handler = (event: unknown, ctx: unknown) => unknown;

let cwd: string;
let calls: Call[];
let hangLearnings: boolean;
const realFetch = globalThis.fetch;

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), 'rembric-pi-subagent-'));
  writeFileSync(join(cwd, '.rembric'), `PROJECT_SLUG=${SLUG}\n`);
  for (const key of CHILD_MARKERS) vi.stubEnv(key, '');
  vi.stubEnv('REMBRIC_SERVER_URL', 'http://127.0.0.1:9');
  vi.stubEnv('REMBRIC_API_TOKEN', 'stubbed');
  calls = [];
  hangLearnings = false;
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    calls.push({ path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (hangLearnings && path.endsWith('/learnings')) return await new Promise<Response>(() => {});
    return new Response('', { status: 200 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(cwd, { recursive: true, force: true });
});

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function parentSession(sessionId: string, systemPrompt = 'Base prompt.') {
  const handlers = new Map<string, Handler>();
  const ctx = {
    cwd,
    mode: 'tui',
    sessionManager: { getSessionId: () => sessionId, getSessionFile: () => undefined },
  };
  rembric({
    registerTool: () => {},
    on: (event: string, handler: Handler) => handlers.set(event, handler),
  } as unknown as Parameters<typeof rembric>[0]);
  const fire = async (event: string, payload: unknown = {}) => {
    const handler = handlers.get(event);
    if (!handler) throw new Error(`no handler registered for ${event}`);
    return await handler(payload, ctx);
  };
  await fire('session_start');
  await fire('before_agent_start', { prompt: 'delegate a scan', systemPrompt });
  return fire;
}

function toolEnd(toolName: string, text: string, isError = false) {
  return {
    toolCallId: 'call_1',
    toolName,
    args: { agent: 'scout', task: 'scan' },
    result: { content: [{ type: 'text', text }], details: { results: [] } },
    isError,
    durationMs: 12,
  };
}

function learnings(): Call[] {
  return calls.filter((c) => c.path.endsWith('/learnings'));
}

describe('the Pi extension forwards subagent reports observed in the parent session', () => {
  it('A foreground subagent result is forwarded', async () => {
    const fire = await parentSession('P');

    await fire('tool_execution_end', toolEnd('subagent', BODY));
    await settle();

    expect(learnings()).toEqual([
      { path: `/api/${SLUG}/sessions/P/learnings`, body: { report: BODY } },
    ]);
  });

  it.each(['subagent_run', 'subagent_continue', 'subagent_result'])(
    'forwards the result of the recognised tool %s',
    async (toolName) => {
      const fire = await parentSession('P');

      await fire('tool_execution_end', toolEnd(toolName, BODY));
      await settle();

      expect(learnings().map((c) => c.body)).toEqual([{ report: BODY }]);
    },
  );

  it('concatenates every text part of the result and skips other parts', async () => {
    const fire = await parentSession('P');
    const event = toolEnd('subagent', '');
    event.result.content = [
      { type: 'text', text: 'Part one.' },
      { type: 'image', text: undefined as unknown as string },
      { type: 'text', text: '## Key Learnings\n1. Two parts.' },
    ];

    await fire('tool_execution_end', event);
    await settle();

    expect(learnings().map((c) => c.body)).toEqual([
      { report: 'Part one.\n## Key Learnings\n1. Two parts.' },
    ]);
  });

  it('A background completion message is forwarded', async () => {
    const fire = await parentSession('P');

    await fire('message_end', {
      message: {
        role: 'custom',
        customType: 'gentle-agents.message',
        content: BODY,
        display: true,
        timestamp: 1,
      },
    });
    await fire('message_end', {
      message: {
        role: 'custom',
        customType: 'subagent-notify',
        content: [{ type: 'text', text: BODY }],
        display: true,
        timestamp: 2,
      },
    });
    await settle();

    expect(learnings()).toEqual([
      { path: `/api/${SLUG}/sessions/P/learnings`, body: { report: BODY } },
      { path: `/api/${SLUG}/sessions/P/learnings`, body: { report: BODY } },
    ]);
  });

  it('Errors and other tools are ignored', async () => {
    const fire = await parentSession('P');

    await fire('tool_execution_end', toolEnd('subagent_run', BODY, true));
    await fire('tool_execution_end', toolEnd('bash', BODY));
    await fire('message_end', {
      message: { role: 'custom', customType: 'other-notify', content: BODY, display: true },
    });
    await settle();

    expect(learnings()).toEqual([]);
  });

  it('leaves the observed tool result unchanged and returns nothing to the host', async () => {
    const fire = await parentSession('P');
    const event = toolEnd('subagent', `a <private>k</private> b\n${BODY}`);
    const snapshot = structuredClone(event);

    const returned = await fire('tool_execution_end', event);
    await settle();

    expect(returned).toBeUndefined();
    expect(event).toEqual(snapshot);
    expect(learnings().map((c) => c.body)).toEqual([{ report: `a [REDACTED] b\n${BODY}` }]);
  });

  it('returns to the host before the report request completes', async () => {
    const fire = await parentSession('P');
    hangLearnings = true;

    const outcome = await Promise.race([
      fire('tool_execution_end', toolEnd('subagent', BODY)).then(() => 'returned'),
      new Promise((resolve) => setTimeout(() => resolve('blocked'), 200)),
    ]);

    expect(outcome).toBe('returned');
    expect(learnings()).toHaveLength(1);
  });

  it.each([
    ['the pi-subagents runner marker', { PI_SUBAGENT_CHILD: '1' }, 'Base prompt.'],
    ['the gentle-pi marker', { GENTLE_PI_AGENTS_CHILD: '1' }, 'Base prompt.'],
    ['the active_agent tag', {}, 'Base.\n<active_agent name="scout"/>\nYou are a scout.'],
  ])('A subagent child does not forward (%s)', async (_label, env, systemPrompt) => {
    for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
    const fire = await parentSession('CHILD', systemPrompt);

    await fire('tool_execution_end', toolEnd('subagent', BODY));
    await fire('message_end', {
      message: { role: 'custom', customType: 'subagent-notify', content: BODY, display: true },
    });
    await settle();

    expect(learnings()).toEqual([]);
    expect(calls.filter((c) => c.path === `/api/${SLUG}/sessions`)).toEqual([]);
  });

  it('the control: the same process without a child signal registers the session', async () => {
    await parentSession('TOP');

    expect(calls.filter((c) => c.path === `/api/${SLUG}/sessions`)).toEqual([
      { path: `/api/${SLUG}/sessions`, body: { id: 'TOP', agent: 'pi', cwd } },
    ]);
  });
});
