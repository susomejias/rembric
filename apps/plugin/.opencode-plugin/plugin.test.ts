import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Imports from the shared dotenv lib (single source of truth, used by the
// MCP bridge AND the opencode plugin). The distributed plugin.ts exports
// ONLY `RembricPlugin`; opencode invokes every named export as a Plugin
// function, so the helpers MUST stay outside plugin.ts's export surface.
import { parseDotenv, readRembricSlug } from '../mcp-bridge/rembric-dotenv.mjs';
import { createSessionProtocol } from '../bin/rembric-plugin-core.mjs';
import { RembricPlugin } from './plugin.js';

const here = dirname(fileURLToPath(import.meta.url));
const pluginVersion = (
  JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version: string }
).version;
const expectedBridgeSpecifier = `@rembric/mcp-bridge@${pluginVersion}`;

const nudgeFixtures = JSON.parse(
  readFileSync(join(here, '..', 'test', 'nudge-fixtures.json'), 'utf8'),
) as { save: string; summary: string; postCompactCore: string };

function spyOnStderr(sink: string[]) {
  return vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    sink.push(String(chunk));
    return true;
  });
}

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

describe('RembricPlugin config hook', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rembric-plugin-config-'));
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=demo\\n');
    process.env.REMBRIC_SERVER_URL = 'http://localhost:9999';
    process.env.REMBRIC_API_TOKEN = 'test-token';
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.REMBRIC_SERVER_URL;
    delete process.env.REMBRIC_API_TOKEN;
  });

  it('replaces a legacy launcher entry in memory and preserves the rest of the config', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const config = {
      mcp: {
        rembric: {
          type: 'local',
          command: ['node', '/home/user/.config/rembric/bin/rembric-bridge.mjs'],
          environment: { REMBRIC_SERVER_URL: '{env:REMBRIC_SERVER_URL}' },
          enabled: true,
        },
        other: { type: 'remote', url: 'https://example.test/mcp' },
      },
      theme: 'dark',
    };

    handlers.config!(config);

    expect(config.mcp.rembric.command).toEqual(['npx', '-y', expectedBridgeSpecifier]);
    expect(config.mcp.rembric.environment).toEqual({
      REMBRIC_SERVER_URL: '{env:REMBRIC_SERVER_URL}',
    });
    expect(config.mcp.other).toEqual({ type: 'remote', url: 'https://example.test/mcp' });
    expect(config.theme).toBe('dark');
  });

  it('does not create an MCP entry when the user has not configured one', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const config = {
      mcp: { other: { command: ['node', 'other-mcp.mjs'], enabled: true } },
      theme: 'dark',
    };

    handlers.config!(config);

    expect(config).toEqual({
      mcp: { other: { command: ['node', 'other-mcp.mjs'], enabled: true } },
      theme: 'dark',
    });
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

  it('experimental.session.compacting directs memory.session_get before memory.session_summary, and states the cap', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const out: { context: string[] } = { context: [] };
    await handlers['experimental.session.compacting']!({ sessionID: 's1' } as never, out as never);
    const text = out.context[0];
    expect(text).toContain('memory.session_get');
    expect(text).toContain('10000');
    expect(text).toContain(
      'Use exactly these six Markdown level-2 headings, in this order, each on its own line (never one flat paragraph):\n## Goal\n## Accomplished\n## Decisions+why\n## Verified+how\n## Unfinished+why\n## Files',
    );
    expect(text.indexOf('memory.session_get')).toBeLessThan(text.indexOf('memory.session_summary'));
  });

  it('experimental.session.compacting carries no window-only framing', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const out: { context: string[] } = { context: [] };
    await handlers['experimental.session.compacting']!({ sessionID: 's1' } as never, out as never);
    const text = out.context[0];
    // Constructed at runtime, not embedded verbatim: `grep`ping the repo for
    // these exact phrases is itself a verification step (fix-audited-defects
    // successor), and a literal copy here — even in a negative assertion —
    // would be a false positive of that grep.
    const bannedWindowFraming = [
      ['content of the compact', 'ed summary'].join(''),
      ['compacted summ', 'ary above'].join(''),
      ['This preserves what was ', 'accomplished'].join(''),
    ];
    for (const phrase of bannedWindowFraming) expect(text).not.toContain(phrase);
  });

  it('experimental.session.compacting pushes the shared fixture text byte-identical, with only the slug sentence added', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const out: { context: string[] } = { context: [] };
    await handlers['experimental.session.compacting']!({ sessionID: 's1' } as never, out as never);
    expect(out.context[0]).toBe(`${nudgeFixtures.postCompactCore}Use project: 'demo'. `);
  });

  it('experimental.session.compacting fires without sessionID: still pushes the string, makes no HTTP request', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const out: { context: string[] } = { context: [] };
    await handlers['experimental.session.compacting']!({} as never, out as never);
    expect(out.context).toHaveLength(1);
    expect(out.context[0]).toContain('memory.session_get');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('plugin.ts declares no copy of the post-compaction protocol text', () => {
    const src = readFileSync(join(here, 'plugin.ts'), 'utf8');
    expect(src).not.toContain('This session resumes from a compaction');
    expect(src).toContain('POST_COMPACT_NUDGE_CORE');
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
      if (output.parts.some((p) => p.text?.includes('memory.save now'))) pushed.push(turn);
    }
    expect(pushed).toEqual([5, 10]);
  });

  it('chat.message appends the first-prompt relevance nudge on turn 1 only', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const pushed: number[] = [];
    for (let turn = 1; turn <= 2; turn++) {
      const output = { parts: [{ type: 'text', text: `edit number ${turn}` }], message: {} };
      await handlers['chat.message']!({ sessionID: 's-relevance' } as never, output as never);
      if (output.parts.some((p) => p.text === nudgeFixtures.firstPromptRelevance))
        pushed.push(turn);
    }
    expect(pushed).toEqual([1]);
  });

  it('chat.message does not append the first-prompt relevance nudge for a sub-agent session', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    await handlers.event!({
      event: {
        type: 'session.created',
        properties: { info: { id: 'sub-relevance', parentID: 'parent', title: 'sub work' } },
      },
    } as never);
    const output = { parts: [{ type: 'text', text: 'first message' }], message: {} };
    await handlers['chat.message']!({ sessionID: 'sub-relevance' } as never, output as never);
    expect(output.parts.some((p) => p.text === nudgeFixtures.firstPromptRelevance)).toBe(false);
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

  it('chat.message arms a debounced flush for a known, non-subagent session', async () => {
    vi.useFakeTimers();
    try {
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
      await vi.advanceTimersByTimeAsync(500);

      const summaryCall = fetchMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/sessions/flush-1/summary'),
      );
      expect(summaryCall).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
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

  it('chat.message registers a session that never got a session.created event', async () => {
    vi.useFakeTimers();
    try {
      const handlers = await RembricPlugin({ directory: dir } as never);

      await handlers['chat.message']!(
        { sessionID: 'resumed-1' } as never,
        { parts: [{ type: 'text', text: 'continue where we left off' }], message: {} } as never,
      );

      const registerCall = fetchMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.endsWith('/api/demo/sessions'),
      );
      expect(registerCall).toBeDefined();

      await vi.advanceTimersByTimeAsync(500);
      const summaryCall = fetchMock.mock.calls.find(
        ([url]) => typeof url === 'string' && url.includes('/sessions/resumed-1/summary'),
      );
      expect(summaryCall).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('the debounced flush never blocks the handler from returning', async () => {
    vi.useFakeTimers();
    try {
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
      await vi.advanceTimersByTimeAsync(500);

      released();
    } finally {
      vi.useRealTimers();
    }
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

  it('event(message.part.updated) accumulates the assistant turn, flushed alongside the user turn', async () => {
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
    // message.updated carries no `parts` on the real Message type (Assistant |
    // User) — only metadata. It exists solely to record id → role.
    await handlers.event!({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'm1', role: 'assistant', sessionID: 'mu1' } },
      },
    } as never);
    await handlers.event!({
      event: {
        type: 'message.part.updated',
        properties: {
          part: { id: 'p1', sessionID: 'mu1', messageID: 'm1', type: 'text', text: 'Fixed it.' },
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

  it('event(message.part.updated) replaces text in place under streaming updates (same part id)', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);

    await handlers.event!({
      event: {
        type: 'session.created',
        properties: { info: { id: 'mu2', parentID: '', title: 'work' } },
      },
    } as never);
    await handlers.event!({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'm-stream', role: 'assistant', sessionID: 'mu2' } },
      },
    } as never);
    for (const partial of ['Hel', 'Hello,', 'Hello, working on it.']) {
      await handlers.event!({
        event: {
          type: 'message.part.updated',
          properties: {
            part: {
              id: 'p-stream',
              sessionID: 'mu2',
              messageID: 'm-stream',
              type: 'text',
              text: partial,
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

  it('event(message.part.updated) ignores non-assistant roles and unknown session ids', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const before = fetchMock.mock.calls.length;

    await handlers.event!({
      event: {
        type: 'message.updated',
        properties: { info: { id: 'm-user', role: 'user', sessionID: 'never-registered' } },
      },
    } as never);
    await handlers.event!({
      event: {
        type: 'message.part.updated',
        properties: {
          part: {
            id: 'p-user',
            sessionID: 'never-registered',
            messageID: 'm-user',
            type: 'text',
            text: 'x',
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

  function summaryCallsFor(sessionId: string): unknown[][] {
    return fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.endsWith(`/sessions/${sessionId}/summary`),
    );
  }

  function jsonBodyOf(call: unknown[]): Record<string, unknown> {
    return JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
  }

  const created = (id: string, parentID = '', title = 'work') => ({
    event: { type: 'session.created', properties: { info: { id, parentID, title } } },
  });

  const assistantText = (sessionId: string, messageId: string, partId: string, text: string) => [
    {
      event: {
        type: 'message.updated',
        properties: { info: { id: messageId, role: 'assistant', sessionID: sessionId } },
      },
    },
    {
      event: {
        type: 'message.part.updated',
        properties: {
          part: { id: partId, sessionID: sessionId, messageID: messageId, type: 'text', text },
        },
      },
    },
  ];

  it('session registration posts agent "opencode" and the context directory as cwd', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    await handlers.event!(created('reg-1') as never);

    const registerCalls = fetchMock.mock.calls.filter(
      ([url]) => url === 'http://localhost:9999/api/demo/sessions',
    );
    expect(registerCalls).toHaveLength(1);
    const body = jsonBodyOf(registerCalls[0]!);
    expect(body.id).toBe('reg-1');
    expect(body.agent).toBe('opencode');
    expect(body.cwd).toBe(dir);
  });

  it('every POST carries exactly `Bearer <token>` and nothing echoes the token', async () => {
    const written: string[] = [];
    const stderrSpy = spyOnStderr(written);
    try {
      const handlers = await RembricPlugin({ directory: dir } as never);
      await handlers.event!(created('auth-1') as never);
      await handlers['chat.message']!(
        { sessionID: 'auth-1' } as never,
        { parts: [{ type: 'text', text: 'do the thing' }], message: {} } as never,
      );
      await handlers.event!({
        event: { type: 'session.compacted', properties: { sessionID: 'auth-1' } },
      } as never);
      // The dispose path builds its own fetch init rather than going through
      // rembricPost, so the header has to be asserted on both.
      await handlers.event!({ event: { type: 'server.instance.disposed' } } as never);

      expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(3);
      for (const [, init] of fetchMock.mock.calls) {
        const request = init as { headers: Record<string, string>; body: string };
        expect(request.headers.Authorization).toBe('Bearer test-token');
        expect(request.body).not.toContain('test-token');
      }
      expect(written.length).toBeGreaterThan(0);
      for (const line of written) expect(line).not.toContain('test-token');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  it('every injected nudge part carries a host-valid prt_ id, session id and message id', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const output = {
      parts: [{ type: 'text', text: 'recall the auth fix' }],
      message: { id: 'm-nudge' },
    };
    await handlers['chat.message']!(
      { sessionID: 'prt-1', messageID: 'm-nudge' } as never,
      output as never,
    );

    const injected = output.parts.slice(1) as Array<{
      id?: string;
      sessionID?: string;
      messageID?: string;
    }>;
    expect(injected.length).toBeGreaterThanOrEqual(3);
    for (const part of injected) {
      expect(part.id).toMatch(/^prt_[0-9a-f]{32}$/);
      expect(part.sessionID).toBe('prt-1');
      expect(part.messageID).toBe('m-nudge');
    }
    expect(new Set(injected.map((p) => p.id)).size).toBe(injected.length);
  });

  it('the summary title is the first user turn truncated to 100 chars', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    const first = `first turn ${'a'.repeat(200)}`;
    await handlers.event!(created('title-1') as never);
    await handlers['chat.message']!(
      { sessionID: 'title-1' } as never,
      { parts: [{ type: 'text', text: first }], message: {} } as never,
    );
    await handlers['chat.message']!(
      { sessionID: 'title-1' } as never,
      { parts: [{ type: 'text', text: 'second turn' }], message: {} } as never,
    );
    await handlers.event!({
      event: { type: 'session.compacted', properties: { sessionID: 'title-1' } },
    } as never);

    const calls = summaryCallsFor('title-1');
    expect(calls.length).toBeGreaterThan(0);
    const body = jsonBodyOf(calls[calls.length - 1]!);
    expect(body.title).toBe(first.slice(0, 100));
    expect(body.title).toHaveLength(100);
    expect(body.summary).toContain('second turn');
  });

  it('the summary body omits title when the session has no user turn', async () => {
    const handlers = await RembricPlugin({ directory: dir } as never);
    await handlers.event!(created('title-2') as never);
    for (const event of assistantText('title-2', 'm-t2', 'p-t2', 'Fixed it.')) {
      await handlers.event!(event as never);
    }
    await handlers.event!({
      event: { type: 'session.compacted', properties: { sessionID: 'title-2' } },
    } as never);

    const calls = summaryCallsFor('title-2');
    expect(calls).toHaveLength(1);
    const body = jsonBodyOf(calls[0]!);
    expect(body.summary).toBe('assistant: Fixed it.');
    expect('title' in body).toBe(false);
  });

  it('server.instance.disposed dispatches one un-awaited POST per known non-subagent session', async () => {
    const written: string[] = [];
    const stderrSpy = spyOnStderr(written);
    try {
      const handlers = await RembricPlugin({ directory: dir } as never);
      for (const id of ['d-1', 'd-2']) {
        await handlers.event!(created(id) as never);
        for (const event of assistantText(id, `m-${id}`, `p-${id}`, `work on ${id}`)) {
          await handlers.event!(event as never);
        }
      }

      // Inverted on purpose: session.created returns early for a sub-agent, so
      // marking it after chat.message is the only way the dispose loop's
      // sub-agent guard is reachable at all.
      await handlers['chat.message']!(
        { sessionID: 'd-sub' } as never,
        { parts: [{ type: 'text', text: 'sub work' }], message: {} } as never,
      );
      await handlers.event!(created('d-sub', 'd-1', 'sub work') as never);

      const registered = fetchMock.mock.calls
        .filter(([url]) => url === 'http://localhost:9999/api/demo/sessions')
        .map((call) => jsonBodyOf(call).id);
      expect(registered).toContain('d-sub');

      const before = fetchMock.mock.calls.length;
      // Never resolves: an awaited dispose flush would hang the handler.
      fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
      await handlers.event!({ event: { type: 'server.instance.disposed' } } as never);

      const disposeCalls = fetchMock.mock.calls.slice(before);
      expect(disposeCalls.map(([url]) => url).sort()).toEqual([
        'http://localhost:9999/api/demo/sessions/d-1/summary',
        'http://localhost:9999/api/demo/sessions/d-2/summary',
      ]);
      // rembricPost attaches an AbortSignal; the fire-and-forget path does not.
      for (const [, init] of disposeCalls) {
        expect((init as { signal?: unknown }).signal).toBeUndefined();
      }

      const flushLines = written.filter((line) => line.includes('dispose-flush'));
      expect(flushLines).toHaveLength(2);
      expect(flushLines.join('')).toContain('sessionId=d-1');
      expect(flushLines.join('')).toContain('sessionId=d-2');
      expect(flushLines.join('')).not.toContain('d-sub');
    } finally {
      stderrSpy.mockRestore();
    }
  });

  describe('the per-session entry cap evicts the per-message state with it', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    // Past the cap is where the two maps keyed by assistant message id can grow
    // without bound, since forgetSession reports only the surviving entries.
    async function fillPastTheCap(
      handlers: Awaited<ReturnType<typeof RembricPlugin>>,
      sessionId: string,
      turns: number,
    ): Promise<void> {
      for (let turn = 0; turn < turns; turn++) {
        await handlers['chat.message']!(
          { sessionID: sessionId } as never,
          { parts: [{ type: 'text', text: `turn ${turn}` }], message: {} } as never,
        );
      }
    }

    it('a late part for an evicted assistant turn cannot resurrect it', async () => {
      const handlers = await RembricPlugin({ directory: dir } as never);
      await handlers.event!(created('cap-evict') as never);
      for (const event of assistantText('cap-evict', 'm-old', 'p-old', 'OLDEST TURN')) {
        await handlers.event!(event as never);
      }
      await fillPastTheCap(handlers, 'cap-evict', 400);

      const [, latePart] = assistantText('cap-evict', 'm-old', 'p-late', 'RESURRECTED');
      await handlers.event!(latePart as never);
      await handlers.event!({
        event: { type: 'session.compacted', properties: { sessionID: 'cap-evict' } },
      } as never);

      const calls = summaryCallsFor('cap-evict');
      expect(calls.length).toBeGreaterThan(0);
      const summary = jsonBodyOf(calls[calls.length - 1]!).summary as string;
      // Control: the flush really carried this session's transcript, so the
      // absence below is not an empty body.
      expect(summary).toContain('turn 399');
      expect(summary).not.toContain('OLDEST TURN');
      expect(summary).not.toContain('RESURRECTED');
    });

    it('an assistant turn evicted by later assistant turns is dropped too', async () => {
      // No user turn at all, so only the assistant upsert path can evict.
      const handlers = await RembricPlugin({ directory: dir } as never);
      await handlers.event!(created('cap-assistant') as never);
      for (let i = 0; i < 400; i++) {
        for (const event of assistantText('cap-assistant', `m-${i}`, `p-${i}`, `reply ${i}`)) {
          await handlers.event!(event as never);
        }
      }

      const [, latePart] = assistantText('cap-assistant', 'm-0', 'p-0-late', 'RESURRECTED');
      await handlers.event!(latePart as never);
      await handlers.event!({
        event: { type: 'session.compacted', properties: { sessionID: 'cap-assistant' } },
      } as never);

      const calls = summaryCallsFor('cap-assistant');
      expect(calls.length).toBeGreaterThan(0);
      const summary = jsonBodyOf(calls[calls.length - 1]!).summary as string;
      expect(summary).toContain('reply 399');
      expect(summary).not.toContain('reply 0\n');
      expect(summary).not.toContain('RESURRECTED');
    });

    it('control — a late part for a turn still inside the window is accumulated', async () => {
      const handlers = await RembricPlugin({ directory: dir } as never);
      await handlers.event!(created('cap-keep') as never);
      for (const event of assistantText('cap-keep', 'm-live', 'p-first', 'FIRST PART')) {
        await handlers.event!(event as never);
      }
      await fillPastTheCap(handlers, 'cap-keep', 5);

      const [, latePart] = assistantText('cap-keep', 'm-live', 'p-late', 'SECOND PART');
      await handlers.event!(latePart as never);
      await handlers.event!({
        event: { type: 'session.compacted', properties: { sessionID: 'cap-keep' } },
      } as never);

      const calls = summaryCallsFor('cap-keep');
      const summary = jsonBodyOf(calls[calls.length - 1]!).summary as string;
      expect(summary).toContain('FIRST PART');
      expect(summary).toContain('SECOND PART');
    });
  });

  describe('session.deleted clears the per-session state', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('session.deleted deregisters the session so later events cannot revive it', async () => {
      const handlers = await RembricPlugin({ directory: dir } as never);
      await handlers.event!(created('del-known') as never);
      await handlers['chat.message']!(
        { sessionID: 'del-known' } as never,
        { parts: [{ type: 'text', text: 'first turn' }], message: {} } as never,
      );
      await handlers.event!({
        event: { type: 'session.deleted', properties: { info: { id: 'del-known' } } },
      } as never);

      for (const event of assistantText('del-known', 'm-dk', 'p-dk', 'after deletion')) {
        await handlers.event!(event as never);
      }
      await handlers.event!({
        event: { type: 'session.idle', properties: { sessionID: 'del-known' } },
      } as never);
      await vi.advanceTimersByTimeAsync(500);

      expect(summaryCallsFor('del-known')).toHaveLength(0);
    });

    it('session.deleted drops the transcript so a reused id does not inherit it', async () => {
      const handlers = await RembricPlugin({ directory: dir } as never);
      await handlers.event!(created('del-tx') as never);
      await handlers['chat.message']!(
        { sessionID: 'del-tx' } as never,
        { parts: [{ type: 'text', text: 'PRE-DELETION TURN' }], message: {} } as never,
      );
      await handlers.event!({
        event: { type: 'session.deleted', properties: { info: { id: 'del-tx' } } },
      } as never);

      await handlers.event!(created('del-tx') as never);
      await handlers['chat.message']!(
        { sessionID: 'del-tx' } as never,
        { parts: [{ type: 'text', text: 'POST-DELETION TURN' }], message: {} } as never,
      );
      await vi.advanceTimersByTimeAsync(500);

      const calls = summaryCallsFor('del-tx');
      expect(calls.length).toBeGreaterThan(0);
      const summary = jsonBodyOf(calls[calls.length - 1]!).summary as string;
      expect(summary).toContain('POST-DELETION TURN');
      expect(summary).not.toContain('PRE-DELETION TURN');
    });

    it('session.deleted resets the turn counter so a reused id nudges from turn 1 again', async () => {
      const handlers = await RembricPlugin({ directory: dir } as never);
      await handlers.event!(created('del-turns') as never);
      for (const turn of [1, 2]) {
        await handlers['chat.message']!(
          { sessionID: 'del-turns' } as never,
          { parts: [{ type: 'text', text: `turn ${turn}` }], message: {} } as never,
        );
      }
      await handlers.event!({
        event: { type: 'session.deleted', properties: { info: { id: 'del-turns' } } },
      } as never);
      await handlers.event!(created('del-turns') as never);

      const output = { parts: [{ type: 'text', text: 'fresh turn' }], message: {} };
      await handlers['chat.message']!({ sessionID: 'del-turns' } as never, output as never);
      expect(output.parts.some((p) => p.text === nudgeFixtures.firstPromptRelevance)).toBe(true);
    });

    it('session.deleted forgets message roles so a stale assistant id is not trusted after reuse', async () => {
      const handlers = await RembricPlugin({ directory: dir } as never);
      await handlers.event!(created('del-roles') as never);
      for (const event of assistantText('del-roles', 'm-stale', 'p-before', 'BEFORE')) {
        await handlers.event!(event as never);
      }
      await handlers.event!({
        event: { type: 'session.deleted', properties: { info: { id: 'del-roles' } } },
      } as never);
      await handlers.event!(created('del-roles') as never);

      const [, partOnly] = assistantText('del-roles', 'm-stale', 'p-after', 'AFTER');
      await handlers.event!(partOnly as never);
      await handlers.event!({
        event: { type: 'session.idle', properties: { sessionID: 'del-roles' } },
      } as never);
      await vi.advanceTimersByTimeAsync(500);
      expect(summaryCallsFor('del-roles')).toHaveLength(0);

      // Control: with the role re-declared, the identical part does accumulate.
      for (const event of assistantText('del-roles', 'm-stale', 'p-after', 'AFTER')) {
        await handlers.event!(event as never);
      }
      await handlers.event!({
        event: { type: 'session.idle', properties: { sessionID: 'del-roles' } },
      } as never);
      await vi.advanceTimersByTimeAsync(500);
      expect(summaryCallsFor('del-roles')).toHaveLength(1);
    });

    it('session.deleted drops accumulated assistant parts so a reused message id cannot resurrect them', async () => {
      const handlers = await RembricPlugin({ directory: dir } as never);
      await handlers.event!(created('del-parts') as never);
      for (const event of assistantText('del-parts', 'm-p', 'p-a', 'ALPHA')) {
        await handlers.event!(event as never);
      }
      const [, bravo] = assistantText('del-parts', 'm-p', 'p-b', 'BRAVO');
      await handlers.event!(bravo as never);
      await handlers.event!({
        event: { type: 'session.deleted', properties: { info: { id: 'del-parts' } } },
      } as never);

      await handlers.event!(created('del-parts') as never);
      for (const event of assistantText('del-parts', 'm-p', 'p-a', 'CHARLIE')) {
        await handlers.event!(event as never);
      }
      await handlers.event!({
        event: { type: 'session.idle', properties: { sessionID: 'del-parts' } },
      } as never);
      await vi.advanceTimersByTimeAsync(500);

      const calls = summaryCallsFor('del-parts');
      expect(calls).toHaveLength(1);
      const summary = jsonBodyOf(calls[0]!).summary as string;
      expect(summary).toBe('assistant: CHARLIE');
      expect(summary).not.toContain('BRAVO');
    });

    it('session.deleted disarms the debounce so an orphaned timer cannot POST after the id is reused', async () => {
      const handlers = await RembricPlugin({ directory: dir } as never);
      await handlers.event!(created('del-timer') as never);
      await handlers['chat.message']!(
        { sessionID: 'del-timer' } as never,
        { parts: [{ type: 'text', text: 'armed turn' }], message: {} } as never,
      );
      await handlers.event!({
        event: { type: 'session.deleted', properties: { info: { id: 'del-timer' } } },
      } as never);

      // Re-registered and re-filled WITHOUT re-arming: neither message.updated
      // nor message.part.updated touches the debounce, so a POST at t=500ms can
      // only come from the timer session.deleted was meant to clear.
      await handlers.event!(created('del-timer') as never);
      for (const event of assistantText('del-timer', 'm-dt', 'p-dt', 'still here')) {
        await handlers.event!(event as never);
      }
      await vi.advanceTimersByTimeAsync(500);

      expect(summaryCallsFor('del-timer')).toHaveLength(0);
    });
  });
});

describe('the shared accumulator reports what its per-session cap evicts', () => {
  it('reports every entry that left the window, oldest first, and keeps the window bounded', () => {
    const protocol = createSessionProtocol({
      agent: 'opencode',
      serverUrl: 'http://localhost:9999',
      apiToken: 'test-token',
      slug: 'demo',
    });

    const total = 500;
    const evicted: string[] = [];
    for (let i = 0; i < total; i++) {
      for (const entry of protocol.upsertAssistantMessage('cap', `m-${i}`, `entry ${i}`)) {
        if (entry.id) evicted.push(entry.id);
      }
    }

    // No cap size is asserted, only that every entry that left the window was
    // reported exactly once and in order.
    expect(evicted.length).toBeGreaterThan(0);
    expect(evicted).toEqual(Array.from({ length: evicted.length }, (_, i) => `m-${i}`));
    expect(evicted.length).toBeLessThan(total);
  });

  it('reports nothing when an upsert replaces an entry already in the window', () => {
    const protocol = createSessionProtocol({
      agent: 'opencode',
      serverUrl: 'http://localhost:9999',
      apiToken: 'test-token',
      slug: 'demo',
    });
    protocol.upsertAssistantMessage('stream', 'm-1', 'Hel');
    expect(protocol.upsertAssistantMessage('stream', 'm-1', 'Hello, done.')).toEqual([]);
  });
});

describe('RembricPlugin without credentials', () => {
  let dir: string;
  let fetchMock: ReturnType<typeof vi.fn>;
  let written: string[];
  let stderrSpy: ReturnType<typeof spyOnStderr>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rembric-plugin-nocreds-'));
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=demo\n');
    delete process.env.REMBRIC_SERVER_URL;
    delete process.env.REMBRIC_API_TOKEN;
    fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    written = [];
    // The diagnostic is written while RembricPlugin is being constructed, so
    // the spy has to be installed before it runs.
    stderrSpy = spyOnStderr(written);
  });

  afterEach(() => {
    stderrSpy.mockRestore();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.REMBRIC_SERVER_URL;
    delete process.env.REMBRIC_API_TOKEN;
    vi.restoreAllMocks();
  });

  const cases = [
    { label: 'both unset', url: undefined, token: undefined },
    { label: 'only REMBRIC_SERVER_URL set', url: 'http://localhost:9999', token: undefined },
    { label: 'only REMBRIC_API_TOKEN set', url: undefined, token: 'test-token' },
  ];

  for (const { label, url, token } of cases) {
    it(`emits one configuration diagnostic and issues no request — ${label}`, async () => {
      if (url) process.env.REMBRIC_SERVER_URL = url;
      if (token) process.env.REMBRIC_API_TOKEN = token;
      vi.useFakeTimers();
      try {
        const handlers = await RembricPlugin({ directory: dir } as never);
        expect(written).toHaveLength(1);
        expect(written[0]).toContain('REMBRIC_SERVER_URL');
        expect(written[0]).toContain('REMBRIC_API_TOKEN');
        expect(written[0]).toContain('plugin disabled');
        if (token) expect(written[0]).not.toContain(token);

        await handlers.event!({
          event: {
            type: 'session.created',
            properties: { info: { id: 'nc-1', parentID: '', title: 'work' } },
          },
        } as never);
        const output = { parts: [{ type: 'text', text: 'recall the auth fix' }], message: {} };
        await handlers['chat.message']!({ sessionID: 'nc-1' } as never, output as never);
        await handlers.event!({
          event: { type: 'session.idle', properties: { sessionID: 'nc-1' } },
        } as never);
        await handlers.event!({ event: { type: 'server.instance.disposed' } } as never);
        await vi.advanceTimersByTimeAsync(1000);

        expect(fetchMock).not.toHaveBeenCalled();
        // Control: nudges are deliberately unaffected by the missing
        // configuration, so their presence is what proves the handlers ran.
        expect(output.parts.some((p) => p.text === nudgeFixtures.firstPromptRelevance)).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });
  }
});
