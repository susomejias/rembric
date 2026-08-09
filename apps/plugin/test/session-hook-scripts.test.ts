import { createServer, type IncomingMessage, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, '..', 'scripts');

type CapturedRequest = { method: string; path: string; body: string };

let server: Server;
let serverUrl: string;
let requests: CapturedRequest[];
let dir: string;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

/** Paths answered with `404 session_not_found` instead of `200`. */
let notFound: Set<string>;

beforeEach(async () => {
  requests = [];
  notFound = new Set();
  dir = mkdtempSync(join(tmpdir(), 'rembric-session-hooks-'));
  server = createServer((req, res) => {
    readBody(req)
      .then((body) => {
        requests.push({ method: req.method ?? '', path: req.url ?? '', body });
        if (notFound.has(req.url ?? '')) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end('{"error":"session_not_found"}');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true}');
      })
      .catch(() => {
        res.writeHead(500);
        res.end();
      });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  serverUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  rmSync(dir, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

// Async execFile — NOT execFileSync: the script's curl and this test's HTTP
// server share one event loop, and a synchronous spawn deadlocks until curl
// times out (same constraint stop-sync.test.ts documents).
async function runFull(
  script: string,
  stdin: string,
  ...args: string[]
): Promise<{ stdout: string; stderr: string }> {
  const child = execFileAsync('bash', [join(scripts, script), ...args], {
    encoding: 'utf8',
    // The shipped 3s POST cap is a production budget, not a test one: under the
    // full suite's worker load curl can hit it, the request never reaches the
    // stub, and an assertion on `requests[0]` fails intermittently. The cap has
    // its own describe below, which sets the value explicitly.
    env: {
      ...process.env,
      REMBRIC_SERVER_URL: serverUrl,
      REMBRIC_API_TOKEN: 'test-token',
      REMBRIC_POST_MAX_TIME: '30',
    },
  });
  child.child.stdin?.end(stdin);
  return child;
}

async function run(script: string, stdin: string, ...args: string[]): Promise<string> {
  return (await runFull(script, stdin, ...args)).stdout;
}

const paths = (): string[] => requests.map((r) => r.path);

function writeRembricFile(slug: string): void {
  writeFileSync(join(dir, '.rembric'), `PROJECT_SLUG=${slug}\n`);
}

describe('session-start.sh ensures then resumes', () => {
  it('POSTs the ensure and then the resume, in that order, with an empty body', async () => {
    writeRembricFile('demo');

    const out = await run(
      'session-start.sh',
      JSON.stringify({ session_id: 'sess-abc', cwd: dir, source: 'startup' }),
      'claude-code',
    );

    expect(paths()).toEqual(['/api/demo/sessions', '/api/demo/sessions/sess-abc/resume']);
    expect(JSON.parse(requests[0]!.body)).toEqual({
      id: 'sess-abc',
      cwd: dir,
      agent: 'claude-code',
    });
    expect(JSON.parse(requests[1]!.body)).toEqual({});
    expect(requests[1]!.method).toBe('POST');
    expect(out).toContain('rembric: If this is a continuation');
  });

  // The rule is unconditional by design: no host reports a resume on a cold
  // start, so a client that branched on `source` would still miss the case the
  // resume exists for. Removing the field entirely must change nothing.
  it.each([['startup'], ['resume'], ['clear'], ['fork'], ['compact']])(
    'does not condition the resume on source=%s',
    async (source) => {
      writeRembricFile('demo');
      await run(
        'session-start.sh',
        JSON.stringify({ session_id: 'sess-abc', cwd: dir, source }),
        'claude-code',
      );
      expect(paths()).toEqual(['/api/demo/sessions', '/api/demo/sessions/sess-abc/resume']);
    },
  );

  it('posts the same pair when the host supplies no source field at all', async () => {
    writeRembricFile('demo');
    await run(
      'session-start.sh',
      JSON.stringify({ session_id: 'sess-abc', cwd: dir }),
      'claude-code',
    );
    expect(paths()).toEqual(['/api/demo/sessions', '/api/demo/sessions/sess-abc/resume']);
  });

  it('posts neither when no slug resolves', async () => {
    await run(
      'session-start.sh',
      JSON.stringify({ session_id: 'sess-abc', cwd: dir, source: 'startup' }),
      'claude-code',
    );
    expect(paths()).toEqual([]);
  });

  // A server predating the route answers 404. The nudge and the exit code are
  // what must survive it: the host session continues either way.
  it('degrades a rejected resume to one stderr diagnostic and keeps the session', async () => {
    writeRembricFile('demo');
    notFound.add('/api/demo/sessions/sess-abc/resume');

    const { stdout, stderr } = await runFull(
      'session-start.sh',
      JSON.stringify({ session_id: 'sess-abc', cwd: dir, source: 'startup' }),
      'claude-code',
    );

    expect(paths()).toEqual(['/api/demo/sessions', '/api/demo/sessions/sess-abc/resume']);
    expect(stdout).toContain('rembric: If this is a continuation');
    const diagnostics = stderr.trim().split('\n').filter(Boolean);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain('/api/demo/sessions/sess-abc/resume');
    expect(diagnostics[0]).toContain('status=404');
  });

  it('posts neither when the host supplies no session id', async () => {
    writeRembricFile('demo');
    await run('session-start.sh', JSON.stringify({ cwd: dir, source: 'startup' }), 'claude-code');
    expect(paths()).toEqual([]);
  });
});

describe('post-compact.sh ensures then resumes', () => {
  it('POSTs the pair and still emits the compaction instruction', async () => {
    writeRembricFile('demo');

    const out = await run(
      'post-compact.sh',
      JSON.stringify({ session_id: 'sess-xyz', cwd: dir }),
      'codex-cli',
    );

    expect(paths()).toEqual(['/api/demo/sessions', '/api/demo/sessions/sess-xyz/resume']);
    expect(JSON.parse(requests[0]!.body)).toMatchObject({ agent: 'codex-cli' });
    expect(JSON.parse(requests[1]!.body)).toEqual({});
    expect(out).toContain('memory.session_summary');
  });

  it('posts neither when no slug resolves', async () => {
    await run('post-compact.sh', JSON.stringify({ session_id: 'sess-xyz', cwd: dir }), 'codex-cli');
    expect(paths()).toEqual([]);
  });
});

describe('session-end.sh selects its transcript parser from the agent argument', () => {
  function writeClaudeTranscript(): string {
    const path = join(dir, 'claude.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({ type: 'user', message: { role: 'user', content: 'please fix the bug' } }),
        JSON.stringify({
          type: 'assistant',
          message: { role: 'assistant', content: 'Fixed it, running tests now.' },
        }),
      ].join('\n') + '\n',
    );
    return path;
  }

  function writeCodexTranscript(): string {
    const path = join(dir, 'codex.jsonl');
    writeFileSync(
      path,
      [
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'user_message', message: 'please fix the bug' },
        }),
        JSON.stringify({
          type: 'event_msg',
          payload: { type: 'agent_message', message: 'Fixed it, running tests now.' },
        }),
      ].join('\n') + '\n',
    );
    return path;
  }

  it('parses a Codex transcript under codex-cli and POSTs /end with summary and title', async () => {
    writeRembricFile('demo');
    const out = await run(
      'session-end.sh',
      JSON.stringify({
        session_id: 'sess-1',
        cwd: dir,
        transcript_path: writeCodexTranscript(),
        reason: 'other',
      }),
      'codex-cli',
    );

    expect(out).toBe('');
    expect(paths()).toEqual(['/api/demo/sessions/sess-1/end']);
    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body.summary).toContain('please fix the bug');
    expect(body.summary).toContain('Fixed it, running tests now.');
    expect(body.title).toContain('Fixed it, running tests now.');
    expect(body.final).toBe(false);
  });

  // The control that makes the dispatch load-bearing: the same Codex transcript
  // read by the Claude parser yields nothing, so the script degrades to `{}`.
  it('yields a degraded /end for a Codex transcript read by the Claude parser', async () => {
    writeRembricFile('demo');
    await run(
      'session-end.sh',
      JSON.stringify({ session_id: 'sess-1', cwd: dir, transcript_path: writeCodexTranscript() }),
      'claude-code',
    );

    expect(paths()).toEqual(['/api/demo/sessions/sess-1/end']);
    expect(JSON.parse(requests[0]!.body)).toEqual({});
  });

  it('defaults to the Claude parser when no agent argument is passed', async () => {
    writeRembricFile('demo');
    await run(
      'session-end.sh',
      JSON.stringify({ session_id: 'sess-1', cwd: dir, transcript_path: writeClaudeTranscript() }),
    );

    const body = JSON.parse(requests[0]!.body) as Record<string, unknown>;
    expect(body.summary).toContain('Fixed it, running tests now.');
  });

  it('degrades to /end {} when the transcript is unreadable', async () => {
    writeRembricFile('demo');
    await run(
      'session-end.sh',
      JSON.stringify({ session_id: 'sess-1', cwd: dir, transcript_path: join(dir, 'gone.jsonl') }),
      'codex-cli',
    );

    expect(paths()).toEqual(['/api/demo/sessions/sess-1/end']);
    expect(JSON.parse(requests[0]!.body)).toEqual({});
  });
});

describe('rembric_post honours REMBRIC_POST_MAX_TIME', () => {
  // curl is shimmed so the flag can be read off the real invocation; asserting
  // it any other way would test the assertion, not the helper.
  async function curlArgs(env: Record<string, string>): Promise<string[]> {
    const binDir = join(dir, 'bin');
    const log = join(dir, 'curl-args');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, 'curl'),
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > '${log}'\nprintf '{}\\n200'\n`,
    );
    chmodSync(join(binDir, 'curl'), 0o755);

    await execFileAsync(
      'bash',
      ['-c', `source '${join(scripts, '_api.sh')}'; rembric_post /api/demo/sessions '{}'`],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${binDir}:${process.env.PATH ?? ''}`,
          REMBRIC_SERVER_URL: serverUrl,
          REMBRIC_API_TOKEN: 'test-token',
          ...env,
        },
      },
    );
    return readFileSync(log, 'utf8').split('\n');
  }

  function maxTime(args: string[]): string | undefined {
    const i = args.indexOf('--max-time');
    return i === -1 ? undefined : args[i + 1];
  }

  it('defaults to 3 seconds when the variable is unset', async () => {
    expect(maxTime(await curlArgs({}))).toBe('3');
  });

  it('uses the caller-supplied budget when the variable is set', async () => {
    expect(maxTime(await curlArgs({ REMBRIC_POST_MAX_TIME: '2' }))).toBe('2');
  });
});
