import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Imports from the shared dotenv lib (single source of truth, used by the
// MCP bridge AND the opencode plugin). The distributed plugin.ts exports
// ONLY `RembricPlugin`; opencode invokes every named export as a Plugin
// function, so the helpers MUST stay outside plugin.ts's export surface.
import { parseDotenv, readRembricSlug } from '../bin/rembric-dotenv.mjs';
import { RembricPlugin } from './plugin.js';

const nudgeFixtures = JSON.parse(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'nudge-fixtures.json'),
    'utf8',
  ),
) as { save: string; summary: string };

describe('parseDotenv', () => {
  it('returns {} for empty input', () => {
    expect(parseDotenv('')).toEqual({});
  });

  it('ignores comment lines and blank lines', () => {
    const out = parseDotenv('# comment\n\nFOO=bar\n\n# trailing');
    expect(out).toEqual({ FOO: 'bar' });
  });

  it('strips matched double quotes', () => {
    expect(parseDotenv('FOO="bar baz"')).toEqual({ FOO: 'bar baz' });
  });

  it('strips matched single quotes', () => {
    expect(parseDotenv("FOO='bar baz'")).toEqual({ FOO: 'bar baz' });
  });

  it('keeps mismatched quotes verbatim', () => {
    expect(parseDotenv('FOO="bar')).toEqual({ FOO: '"bar' });
  });

  it('trims surrounding whitespace on key and value', () => {
    expect(parseDotenv('  FOO  =  bar  ')).toEqual({ FOO: 'bar' });
  });

  it('skips lines without an =', () => {
    expect(parseDotenv('not-a-pair\nFOO=bar')).toEqual({ FOO: 'bar' });
  });

  it('handles CRLF line endings', () => {
    expect(parseDotenv('A=1\r\nB=2\r\n')).toEqual({ A: '1', B: '2' });
  });
});

describe('readRembricSlug', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rembric-plugin-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns null when .rembric is missing', () => {
    expect(readRembricSlug(dir)).toBeNull();
  });

  it('returns the slug for a valid PROJECT_SLUG', () => {
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=valid-slug\n');
    expect(readRembricSlug(dir)).toBe('valid-slug');
  });

  it('returns null when PROJECT_SLUG is missing from .rembric', () => {
    writeFileSync(join(dir, '.rembric'), 'OTHER=value\n');
    expect(readRembricSlug(dir)).toBeNull();
  });

  it('rejects leading hyphen', () => {
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=-bad\n');
    expect(readRembricSlug(dir)).toBeNull();
  });

  it('rejects trailing hyphen', () => {
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=bad-\n');
    expect(readRembricSlug(dir)).toBeNull();
  });

  it('rejects uppercase letters', () => {
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=BadSlug\n');
    expect(readRembricSlug(dir)).toBeNull();
  });

  it('rejects slug longer than 64 chars', () => {
    const long = 'a'.repeat(65);
    writeFileSync(join(dir, '.rembric'), `PROJECT_SLUG=${long}\n`);
    expect(readRembricSlug(dir)).toBeNull();
  });

  it('accepts slug exactly 64 chars', () => {
    const ok = 'a'.repeat(64);
    writeFileSync(join(dir, '.rembric'), `PROJECT_SLUG=${ok}\n`);
    expect(readRembricSlug(dir)).toBe(ok);
  });

  it('accepts single-character slug', () => {
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=a\n');
    expect(readRembricSlug(dir)).toBe('a');
  });
});

describe('readRembricSlug byte-for-byte equivalence with bridge parser', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rembric-plugin-test-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('matches a representative fixture verbatim', () => {
    const fixture = [
      '# Rembric project slug for this repo',
      '',
      'PROJECT_SLUG=my-repo',
      'OTHER_KEY="ignored"',
      '   ',
      'TRAILING_WHITESPACE   =   xyz   ',
    ].join('\n');
    writeFileSync(join(dir, '.rembric'), fixture);

    const parsed = parseDotenv(fixture);
    expect(parsed.PROJECT_SLUG).toBe('my-repo');
    expect(parsed.OTHER_KEY).toBe('ignored');
    expect(parsed.TRAILING_WHITESPACE).toBe('xyz');
    expect(readRembricSlug(dir)).toBe('my-repo');
  });
});

describe('RembricPlugin handlers', () => {
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rembric-plugin-handlers-'));
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=demo\n');
    process.env.REMBRIC_SERVER_URL = 'http://localhost:9999';
    process.env.REMBRIC_API_TOKEN = 'test-token';
    fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.REMBRIC_SERVER_URL;
    delete process.env.REMBRIC_API_TOKEN;
    vi.restoreAllMocks();
  });

  it('experimental.session.compacting nudge includes memory.context guidance', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const out: { context: string[] } = { context: [] };
    await handlers['experimental.session.compacting']!({ sessionID: 's1' } as never, out as never);
    expect(out.context).toHaveLength(1);
    expect(out.context[0]).toContain('memory.session_summary');
    expect(out.context[0]).toContain('memory.context');
    expect(out.context[0]).toContain("'demo'");
  });

  it('chat.message appends recall nudge when user text matches recall regex', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const cases = [
      'remember what we did yesterday',
      'please recall the auth fix',
      'acuérdate cuando hicimos la migración?',
      'What did we do with the JWT?',
      '¿qué hicimos con el login?',
    ];
    for (const [i, text] of cases.entries()) {
      const output = {
        parts: [{ type: 'text', text }],
        message: {},
      };
      // Each case is a fresh session's turn 1, so the summary nudge ALSO
      // fires alongside the recall nudge — assert on presence, not position.
      await handlers['chat.message']!({ sessionID: `s-recall-${i}` } as never, output as never);
      const recallPart = output.parts.find((p) => p.text?.includes('rembric: User intent: recall'));
      expect(recallPart?.text).toContain('memory.search');
    }
  });

  it('chat.message does NOT append recall nudge when user text does not match', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const cases = [
      'please write a unit test for src/auth.ts',
      'fix the failing build',
      'add a new endpoint at /api/foo',
    ];
    for (const [i, text] of cases.entries()) {
      const output = {
        parts: [{ type: 'text', text }],
        message: {},
      };
      // Fresh session per case (turn 1) so the summary nudge's turn-1 fire
      // doesn't get confused with the recall nudge under test here.
      await handlers['chat.message']!({ sessionID: `s-no-recall-${i}` } as never, output as never);
      expect(output.parts.some((p) => p.text?.includes('rembric: User intent: recall'))).toBe(
        false,
      );
      expect(output.parts[0].text).toBe(text);
    }
  });

  it('chat.message appends the save nudge every 5th user turn, not before', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const pushed: number[] = [];
    for (let turn = 1; turn <= 10; turn++) {
      const output = { parts: [{ type: 'text', text: `edit number ${turn}` }], message: {} };
      await handlers['chat.message']!({ sessionID: 's-save' } as never, output as never);
      if (output.parts.some((p) => p.text?.includes('memory.save'))) pushed.push(turn);
    }
    expect(pushed).toEqual([5, 10]);
  });

  it('chat.message appends the exact fixture summary nudge on turn 1 and every 10th turn, not before', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const pushed: number[] = [];
    for (let turn = 1; turn <= 11; turn++) {
      const output = { parts: [{ type: 'text', text: `edit number ${turn}` }], message: {} };
      await handlers['chat.message']!({ sessionID: 's-summary' } as never, output as never);
      const summaryPart = output.parts.find((p) => p.text === nudgeFixtures.summary);
      if (summaryPart) pushed.push(turn);
    }
    expect(pushed).toEqual([1, 10]);
  });

  it('chat.message pushes BOTH save and summary parts on turn 10, neither replacing the other', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    let output: { parts: Array<{ type: string; text?: string }>; message: object } = {
      parts: [],
      message: {},
    };
    for (let turn = 1; turn <= 10; turn++) {
      output = { parts: [{ type: 'text', text: `edit number ${turn}` }], message: {} };
      await handlers['chat.message']!({ sessionID: 's-coincide' } as never, output as never);
    }
    expect(output.parts.some((p) => p.text === nudgeFixtures.save)).toBe(true);
    expect(output.parts.some((p) => p.text === nudgeFixtures.summary)).toBe(true);
  });

  it('chat.message never nudges (save, summary, or recall) a sub-agent session on turn 1', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    await handlers.event!({
      event: {
        type: 'session.created',
        properties: { info: { id: 'sub-summary', parentID: 'parent', title: 'sub work' } },
      },
    } as never);
    const output = { parts: [{ type: 'text', text: 'first message' }], message: {} };
    await handlers['chat.message']!({ sessionID: 'sub-summary' } as never, output as never);
    expect(output.parts).toHaveLength(1);
  });

  it('chat.message never nudges a sub-agent session', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    await handlers.event!({
      event: {
        type: 'session.created',
        properties: { info: { id: 'sub-save', parentID: 'parent', title: 'sub work' } },
      },
    } as never);
    for (let turn = 1; turn <= 6; turn++) {
      const output = { parts: [{ type: 'text', text: `edit ${turn}` }], message: {} };
      await handlers['chat.message']!({ sessionID: 'sub-save' } as never, output as never);
      expect(output.parts).toHaveLength(1);
    }
  });

  it('recall and save nudges can both fire on the same turn', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    for (let turn = 1; turn <= 5; turn++) {
      const output = {
        parts: [{ type: 'text', text: 'recall the auth fix' }],
        message: {},
      };
      await handlers['chat.message']!({ sessionID: 's-both' } as never, output as never);
      if (turn === 5) {
        expect(output.parts.some((p) => p.text?.includes('memory.search'))).toBe(true);
        expect(output.parts.some((p) => p.text?.includes('memory.save'))).toBe(true);
      }
    }
  });

  it('chat.message triggers a per-turn flushSessionSummary for a known, non-subagent session', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    await handlers.event!({
      event: {
        type: 'session.created',
        properties: { info: { id: 'flush-1', parentID: '', title: 'work' } },
      },
    } as never);

    await handlers['chat.message']!(
      { sessionID: 'flush-1' } as never,
      { parts: [{ type: 'text', text: 'do the thing' }], message: {} } as never,
    );

    const summaryCall = fetchMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/sessions/flush-1/summary'),
    );
    expect(summaryCall).toBeDefined();
  });

  it('chat.message does NOT flush for a sub-agent session', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    await handlers.event!({
      event: {
        type: 'session.created',
        properties: { info: { id: 'flush-sub', parentID: 'parent', title: 'sub work' } },
      },
    } as never);
    const before = fetchMock.mock.calls.length;

    await handlers['chat.message']!(
      { sessionID: 'flush-sub' } as never,
      { parts: [{ type: 'text', text: 'do the thing' }], message: {} } as never,
    );

    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('the per-turn flush never blocks the handler from returning', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    await handlers.event!({
      event: {
        type: 'session.created',
        properties: { info: { id: 'flush-slow', parentID: '', title: 'work' } },
      },
    } as never);

    let released: () => void = () => {};
    const hang = new Promise<Response>((resolve) => {
      released = () => resolve(new Response('', { status: 200 }));
    });
    fetchMock.mockImplementation(() => hang);

    await handlers['chat.message']!(
      { sessionID: 'flush-slow' } as never,
      { parts: [{ type: 'text', text: 'do the thing' }], message: {} } as never,
    );

    released();
  });

  it('event(session.compacted) flushes the accumulator for a known session', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);

    // Register the session and prime the accumulator.
    await handlers.event!({
      event: {
        type: 'session.created',
        properties: { info: { id: 'sc1', parentID: '', title: 'work' } },
      },
    } as never);
    await handlers['chat.message']!(
      { sessionID: 'sc1' } as never,
      { parts: [{ type: 'text', text: 'turn one' }], message: {} } as never,
    );

    const before = fetchMock.mock.calls.length;

    await handlers.event!({
      event: {
        type: 'session.compacted',
        properties: { sessionID: 'sc1' },
      },
    } as never);

    const summaryCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('/sessions/sc1/summary'),
    );
    expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
    expect(summaryCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('event(session.compacted) is a no-op for unknown sessions', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const before = fetchMock.mock.calls.length;

    await handlers.event!({
      event: {
        type: 'session.compacted',
        properties: { sessionID: 'never-registered' },
      },
    } as never);

    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('event(session.compacted) is a no-op for sub-agent sessions', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);

    // Register as sub-agent (has parentID).
    await handlers.event!({
      event: {
        type: 'session.created',
        properties: { info: { id: 'sub-1', parentID: 'parent', title: 'sub work' } },
      },
    } as never);
    const before = fetchMock.mock.calls.length;

    await handlers.event!({
      event: {
        type: 'session.compacted',
        properties: { sessionID: 'sub-1' },
      },
    } as never);

    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('event(message.updated) accumulates the assistant turn, flushed alongside the user turn', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);

    await handlers.event!({
      event: {
        type: 'session.created',
        properties: { info: { id: 'mu1', parentID: '', title: 'work' } },
      },
    } as never);
    await handlers['chat.message']!(
      { sessionID: 'mu1' } as never,
      { parts: [{ type: 'text', text: 'please fix the bug' }], message: {} } as never,
    );
    await handlers.event!({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'm1',
            role: 'assistant',
            sessionID: 'mu1',
            parts: [{ type: 'text', text: 'Fixed it.' }],
          },
        },
      },
    } as never);

    await handlers.event!({
      event: { type: 'session.compacted', properties: { sessionID: 'mu1' } },
    } as never);

    const summaryCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.includes('/sessions/mu1/summary'),
    );
    expect(summaryCalls.length).toBeGreaterThan(0);
    const body = JSON.parse(
      (summaryCalls[summaryCalls.length - 1]![1] as { body: string }).body,
    ) as {
      summary: string;
    };
    expect(body.summary).toContain('please fix the bug');
    expect(body.summary).toContain('Fixed it.');
  });

  it('event(message.updated) replaces text in place under streaming updates (same message id)', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);

    await handlers.event!({
      event: {
        type: 'session.created',
        properties: { info: { id: 'mu2', parentID: '', title: 'work' } },
      },
    } as never);
    for (const partial of ['Hel', 'Hello,', 'Hello, working on it.']) {
      await handlers.event!({
        event: {
          type: 'message.updated',
          properties: {
            info: {
              id: 'm-stream',
              role: 'assistant',
              sessionID: 'mu2',
              parts: [{ type: 'text', text: partial }],
            },
          },
        },
      } as never);
    }

    await handlers.event!({
      event: { type: 'session.compacted', properties: { sessionID: 'mu2' } },
    } as never);

    const summaryCall = fetchMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.includes('/sessions/mu2/summary'),
    );
    const body = JSON.parse((summaryCall![1] as { body: string }).body) as { summary: string };
    expect(body.summary.match(/Hello, working on it\./g)?.length).toBe(1);
    expect(body.summary).not.toContain('Hel\n');
  });

  it('event(message.updated) ignores non-assistant roles and unknown session ids', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const before = fetchMock.mock.calls.length;

    await handlers.event!({
      event: {
        type: 'message.updated',
        properties: {
          info: {
            id: 'm-user',
            role: 'user',
            sessionID: 'never-registered',
            parts: [{ type: 'text', text: 'x' }],
          },
        },
      },
    } as never);

    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('event(session.idle) schedules a debounced flush for a known session', async () => {
    vi.useFakeTimers();
    try {
      const handlers = await RembricPlugin({ directory: dir } as never);
      await handlers.event!({
        event: {
          type: 'session.created',
          properties: { info: { id: 'idle1', parentID: '', title: 'work' } },
        },
      } as never);
      await handlers['chat.message']!(
        { sessionID: 'idle1' } as never,
        { parts: [{ type: 'text', text: 'turn one' }], message: {} } as never,
      );
      const countSummary = () =>
        fetchMock.mock.calls.filter(
          ([url]) => typeof url === 'string' && url.includes('/sessions/idle1/summary'),
        ).length;
      const beforeIdle = countSummary();

      await handlers.event!({
        event: { type: 'session.idle', properties: { sessionID: 'idle1' } },
      } as never);
      expect(countSummary()).toBe(beforeIdle);

      await vi.advanceTimersByTimeAsync(500);
      expect(countSummary()).toBeGreaterThan(beforeIdle);
    } finally {
      vi.useRealTimers();
    }
  });

  it('event(session.idle) is a no-op for an unregistered session', async () => {
    vi.useFakeTimers();
    try {
      const handlers = await RembricPlugin({ directory: dir } as never);
      await handlers.event!({
        event: { type: 'session.idle', properties: { sessionID: 'never-registered' } },
      } as never);
      await vi.advanceTimersByTimeAsync(1000);
      expect(fetchMock.mock.calls.length).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('stripPrivateTags against the shared cross-client fixture set', () => {
  // Lock-step contract with scripts/_transcript.sh (bash) and
  // .hermes-plugin/__init__.py (python); exercised through the real
  // upload path because plugin.ts exports ONLY RembricPlugin.
  type Fixture = { name: string; input: string; expected: string };
  const fixtures = (
    JSON.parse(
      readFileSync(
        join(dirname(fileURLToPath(import.meta.url)), '..', 'test', 'redaction-fixtures.json'),
        'utf8',
      ),
    ) as Fixture[]
  ).filter((f) => f.input !== '');

  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rembric-plugin-redaction-'));
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=demo\n');
    process.env.REMBRIC_SERVER_URL = 'http://localhost:9999';
    process.env.REMBRIC_API_TOKEN = 'test-token';
    fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.REMBRIC_SERVER_URL;
    delete process.env.REMBRIC_API_TOKEN;
    vi.restoreAllMocks();
  });

  for (const fixture of fixtures) {
    it(fixture.name, async () => {
      const handlers = await RembricPlugin({ directory: dir } as never);
      const sessionId = 'redact-1';
      await handlers.event!({
        event: {
          type: 'session.created',
          properties: { info: { id: sessionId, parentID: '', title: 'work' } },
        },
      } as never);
      await handlers['chat.message']!(
        { sessionID: sessionId } as never,
        { parts: [{ type: 'text', text: fixture.input }], message: {} } as never,
      );
      await handlers.event!({
        event: { type: 'session.compacted', properties: { sessionID: sessionId } },
      } as never);

      const summaryCall = fetchMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes(`/sessions/${sessionId}/summary`),
      );
      expect(summaryCall).toBeDefined();
      const body = JSON.parse((summaryCall![1] as { body: string }).body) as { summary: string };
      expect(body.summary).toBe(`user: ${fixture.expected}`);
    });
  }
});
