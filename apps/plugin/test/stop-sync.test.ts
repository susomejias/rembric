import { createServer, type IncomingMessage, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const stopSyncSh = join(here, '..', 'scripts', 'stop-sync.sh');

type CapturedRequest = { method: string; path: string; body: string };

let server: Server;
let serverUrl: string;
let requests: CapturedRequest[];
let dir: string;
let responseDelayMs: number;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

beforeEach(async () => {
  requests = [];
  responseDelayMs = 0;
  dir = mkdtempSync(join(tmpdir(), 'rembric-stopsync-'));
  server = createServer((req, res) => {
    readBody(req)
      .then((body) => {
        requests.push({ method: req.method ?? '', path: req.url ?? '', body });
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end('{"ok":true}');
        }, responseDelayMs);
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  serverUrl = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function writeRembricFile(cwd: string, slug: string): void {
  writeFileSync(join(cwd, '.rembric'), `PROJECT_SLUG=${slug}\n`);
}

function writeTranscript(cwd: string, name: string): string {
  const path = join(cwd, name);
  const lines = [
    JSON.stringify({ type: 'user', message: { role: 'user', content: 'please fix the bug' } }),
    JSON.stringify({
      type: 'assistant',
      message: { role: 'assistant', content: 'Fixed it, running tests now.' },
    }),
  ];
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

function writeCodexTranscript(cwd: string, name: string): string {
  const path = join(cwd, name);
  const lines = [
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'user_message', message: 'please fix the bug' },
    }),
    JSON.stringify({
      type: 'event_msg',
      payload: { type: 'agent_message', message: 'Fixed it, running tests now.' },
    }),
  ];
  writeFileSync(path, lines.join('\n') + '\n');
  return path;
}

async function runStopSync(stdin: string, agent?: string): Promise<string> {
  // Async execFile — NOT execFileSync — is required here: the script's
  // curl call and this test's in-process HTTP server share one Node event
  // loop. A synchronous spawn blocks that loop while curl waits on it,
  // deadlocking until curl's own timeout (verified: reproduces even with a
  // bare node+curl script outside vitest).
  const child = execFileAsync('bash', agent ? [stopSyncSh, agent] : [stopSyncSh], {
    encoding: 'utf8',
    env: { ...process.env, REMBRIC_SERVER_URL: serverUrl, REMBRIC_API_TOKEN: 'test-token' },
  });
  child.child.stdin?.end(stdin);
  const { stdout } = await child;
  return stdout;
}

// Claude Code's sync runs in a detached background subshell (see
// stop-sync.sh's header), so the script's own exit no longer implies the
// request has landed — poll for it instead of asserting synchronously.
function waitForRequest(): Promise<void> {
  return vi.waitFor(
    () => {
      if (requests.length === 0) throw new Error('no request received yet');
    },
    { timeout: 3000, interval: 20 },
  );
}

describe('stop-sync.sh (Claude Code Stop hook, pure side effect)', () => {
  it('POSTs summary+title to /summary, omitting final entirely, with no stdout', async () => {
    writeRembricFile(dir, 'demo');
    const transcriptPath = writeTranscript(dir, 'transcript.jsonl');

    const out = await runStopSync(
      JSON.stringify({ session_id: 'sess-abc', cwd: dir, transcript_path: transcriptPath }),
    );
    expect(out).toBe('');

    await waitForRequest();
    expect(requests).toHaveLength(1);
    expect(requests[0]!.method).toBe('POST');
    expect(requests[0]!.path).toBe('/api/demo/sessions/sess-abc/summary');
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body.summary).toContain('please fix the bug');
    expect(body.summary).toContain('Fixed it, running tests now.');
    expect(body.title).toContain('Fixed it, running tests now.');
    expect('final' in body).toBe(false);
  });

  it('a torn trailing JSONL line does not discard the good lines before it (#260)', async () => {
    writeRembricFile(dir, 'demo');
    const transcriptPath = join(dir, 'torn.jsonl');
    const goodLines = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'please fix the bug' } }),
      JSON.stringify({
        type: 'assistant',
        message: { role: 'assistant', content: 'Fixed it, running tests now.' },
      }),
    ];
    // A line torn mid-write (Stop hook racing the append, or a crash) —
    // valid JSON up to a point, then cut off. jq errors on THIS line but
    // has already streamed the two good lines above by the time it does.
    const tornLine = '{"type":"user","message":{"content":"cut off mid-wri';
    writeFileSync(transcriptPath, goodLines.join('\n') + '\n' + tornLine);

    const out = await runStopSync(
      JSON.stringify({ session_id: 'sess-torn', cwd: dir, transcript_path: transcriptPath }),
    );
    expect(out).toBe('');

    await waitForRequest();
    expect(requests).toHaveLength(1);
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    // Before the fix, the bash wrapper's `|| out=""` discarded jq's partial
    // output because jq exits non-zero on the parse error — the summary
    // would have been empty instead of containing the two good lines.
    expect(body.summary).toContain('please fix the bug');
    expect(body.summary).toContain('Fixed it, running tests now.');
  });

  it('returns almost immediately even when the server is slow to respond', async () => {
    writeRembricFile(dir, 'demo');
    const transcriptPath = writeTranscript(dir, 'transcript.jsonl');
    responseDelayMs = 2000;

    const startedAt = Date.now();
    const out = await runStopSync(
      JSON.stringify({ session_id: 'sess-slow', cwd: dir, transcript_path: transcriptPath }),
    );
    const elapsedMs = Date.now() - startedAt;

    expect(out).toBe('');
    expect(elapsedMs).toBeLessThan(1000);

    await waitForRequest();
    expect(requests).toHaveLength(1);
  });

  it('makes no POST and emits no stdout when transcript_path is missing', async () => {
    writeRembricFile(dir, 'demo');
    const out = await runStopSync(JSON.stringify({ session_id: 'sess-abc', cwd: dir }));
    expect(out).toBe('');
    expect(requests).toHaveLength(0);
  });

  it('makes no POST when transcript_path points to a nonexistent file', async () => {
    writeRembricFile(dir, 'demo');
    const out = await runStopSync(
      JSON.stringify({
        session_id: 'sess-abc',
        cwd: dir,
        transcript_path: join(dir, 'does-not-exist.jsonl'),
      }),
    );
    expect(out).toBe('');
    expect(requests).toHaveLength(0);
  });

  it('makes no POST when the project slug does not resolve (no .rembric file)', async () => {
    const transcriptPath = writeTranscript(dir, 'transcript.jsonl');
    const out = await runStopSync(
      JSON.stringify({ session_id: 'sess-abc', cwd: dir, transcript_path: transcriptPath }),
    );
    expect(out).toBe('');
    expect(requests).toHaveLength(0);
  });

  it('makes no POST when session_id is missing from stdin', async () => {
    writeRembricFile(dir, 'demo');
    const transcriptPath = writeTranscript(dir, 'transcript.jsonl');
    const out = await runStopSync(JSON.stringify({ cwd: dir, transcript_path: transcriptPath }));
    expect(out).toBe('');
    expect(requests).toHaveLength(0);
  });

  it('exits 0 and emits no stdout on empty/unparseable stdin', async () => {
    expect(await runStopSync('')).toBe('');
    expect(await runStopSync('not json')).toBe('');
    expect(requests).toHaveLength(0);
  });
});

// The wiring, not the helper. `_transcript.sh`'s extraction is unit-tested in
// extract-facts.test.ts; these assert that stop-sync.sh actually SENDS it, and
// that a host or environment without an extraction still sends what it sent
// before. The `async: true` defect this change fixed lived in the wiring, and no
// helper test would have seen it.
describe('stop-sync.sh sends extracted facts, not a conversation slice', () => {
  function writeToolTranscript(target: string): string {
    const lines = [
      { type: 'user', message: { content: [{ type: 'text', text: 'please fix the bug' }] } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/repo/src/bug.ts' } },
          ],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'e1', is_error: false, content: 'ok' }],
        },
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'pnpm test' } }],
        },
      },
      {
        type: 'user',
        message: {
          content: [{ type: 'tool_result', tool_use_id: 'b1', is_error: true, content: 'boom' }],
        },
      },
      {
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Fixed it, running tests now.' }] },
      },
    ];
    const path = join(dir, target);
    writeFileSync(path, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
    return path;
  }

  it('posts the facts: the edited path and the FAILED command', async () => {
    writeRembricFile(dir, 'demo');
    const transcriptPath = writeToolTranscript('tools.jsonl');

    await runStopSync(
      JSON.stringify({ session_id: 'sess-facts', cwd: dir, transcript_path: transcriptPath }),
    );
    await waitForRequest();
    const body = JSON.parse(requests[0]!.body) as Record<string, string>;
    expect(body.summary).toContain('SESSION FACTS');
    expect(body.summary).toContain('/repo/src/bug.ts');
    expect(body.summary).toContain('failed commands:');
    expect(body.summary).toContain('pnpm test');
    // The conversation-slice shape must be gone: the old body was `user: …` /
    // `assistant: …` lines, and sending both would double the payload.
    expect(body.summary).not.toContain('user: please fix the bug');
  });

  it('still carries what the session was about, so the facts stand alone', async () => {
    writeRembricFile(dir, 'demo');
    const transcriptPath = writeToolTranscript('tools2.jsonl');

    await runStopSync(
      JSON.stringify({ session_id: 'sess-ex', cwd: dir, transcript_path: transcriptPath }),
    );
    await waitForRequest();
    const body = JSON.parse(requests[0]!.body) as Record<string, string>;
    expect(body.summary).toContain('last request: please fix the bug');
    expect(body.summary).toContain('last reply: Fixed it, running tests now.');
  });

  it('stays under the server cap even on a transcript with many tool calls', async () => {
    writeRembricFile(dir, 'demo');
    const lines: string[] = [];
    for (let i = 0; i < 400; i++) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              {
                type: 'tool_use',
                id: `w${i}`,
                name: 'Write',
                input: { file_path: `/repo/gen/f${i}.ts` },
              },
            ],
          },
        }),
      );
    }
    const path = join(dir, 'many.jsonl');
    writeFileSync(path, `${lines.join('\n')}\n`);

    await runStopSync(JSON.stringify({ session_id: 'sess-big', cwd: dir, transcript_path: path }));
    await waitForRequest();
    const body = JSON.parse(requests[0]!.body) as Record<string, string>;
    expect(body.summary.length).toBeLessThanOrEqual(10_000);
    expect(body.summary).toContain('files touched (400 distinct)');
    expect(body.summary).toContain('more not listed');
  });

  // Regression guard for the degrade path: a conversation-only transcript has no
  // facts to extract, and MUST still post exactly what it posted before.
  it('degrades to the conversation slice when there are no tool calls', async () => {
    writeRembricFile(dir, 'demo');
    const transcriptPath = writeTranscript(dir, 'plain.jsonl');

    await runStopSync(
      JSON.stringify({ session_id: 'sess-plain', cwd: dir, transcript_path: transcriptPath }),
    );
    await waitForRequest();
    const body = JSON.parse(requests[0]!.body) as Record<string, string>;
    expect(body.summary).toContain('please fix the bug');
    expect(body.summary).not.toContain('SESSION FACTS');
  });

  // The two degrade paths that do NOT post through this wiring — no `jq`, and a
  // parser with no extraction — are asserted in extract-facts.test.ts, where the
  // condition can be created without also removing `curl` or feeding a parser a
  // transcript in another host's format. An assertion here would pass because
  // nothing arrived, which proves nothing.
});

describe('stop-sync.sh codex-cli (Codex Stop hook)', () => {
  it('POSTs summary+title+final:false to /summary, and emits {} on stdout', async () => {
    writeRembricFile(dir, 'demo');
    const transcriptPath = writeCodexTranscript(dir, 'transcript.jsonl');

    const out = await runStopSync(
      JSON.stringify({ session_id: 'sess-abc', cwd: dir, transcript_path: transcriptPath }),
      'codex-cli',
    );

    expect(out).toBe('{}');
    expect(requests).toHaveLength(1);
    expect(requests[0]!.path).toBe('/api/demo/sessions/sess-abc/summary');
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body.summary).toContain('please fix the bug');
    expect(body.summary).toContain('Fixed it, running tests now.');
    expect(body.title).toContain('Fixed it, running tests now.');
    expect(body.final).toBe(false);
  });

  it('makes no POST but still emits {} on stdout when transcript_path is missing', async () => {
    writeRembricFile(dir, 'demo');
    const out = await runStopSync(
      JSON.stringify({ session_id: 'sess-abc', cwd: dir }),
      'codex-cli',
    );
    expect(out).toBe('{}');
    expect(requests).toHaveLength(0);
  });
});
