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
