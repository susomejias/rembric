import { execFileSync, spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const promptSearchSh = join(here, '..', 'scripts', 'prompt-search.sh');
const RECALL_NUDGE =
  'rembric: User intent: recall. Call memory.search with the user keywords before responding.';
const FIRST_PROMPT_NUDGE =
  'rembric: New session — call memory.context with focus set to this prompt before responding, to surface relevant prior work.';

let counterDir: string;

beforeEach(() => {
  counterDir = mkdtempSync(join(tmpdir(), 'rembric-promptsearch-'));
});

afterEach(() => {
  rmSync(counterDir, { recursive: true, force: true });
});

function runPromptSearch(stdin: string): string {
  return execFileSync('bash', [promptSearchSh], {
    input: stdin,
    encoding: 'utf8',
    env: { ...process.env, TMPDIR: counterDir },
  });
}

describe('prompt-search.sh (self-filtering, independent of the hook matcher)', () => {
  it('the first prompt of a session emits the first-prompt nudge even without a recall keyword', () => {
    const out = runPromptSearch(
      JSON.stringify({ session_id: 's1', prompt: 'please fix the failing test' }),
    );
    expect(out.trim()).toBe(FIRST_PROMPT_NUDGE);
  });

  it('the second prompt of the same session does not re-fire the first-prompt nudge', () => {
    runPromptSearch(JSON.stringify({ session_id: 's1', prompt: 'first prompt' }));
    const out = runPromptSearch(
      JSON.stringify({ session_id: 's1', prompt: 'please fix the failing test' }),
    );
    expect(out.trim()).toBe('');
  });

  it('a new session gets its own first-prompt nudge independent of another session', () => {
    runPromptSearch(JSON.stringify({ session_id: 's1', prompt: 'first prompt of s1' }));
    const out = runPromptSearch(JSON.stringify({ session_id: 's2', prompt: 'unrelated prompt' }));
    expect(out.trim()).toBe(FIRST_PROMPT_NUDGE);
  });

  it('emits the recall nudge when the prompt matches a recall keyword, on any turn', () => {
    runPromptSearch(JSON.stringify({ session_id: 's1', prompt: 'first prompt' }));
    const out = runPromptSearch(
      JSON.stringify({ session_id: 's1', prompt: 'can you recall what we did yesterday?' }),
    );
    expect(out.trim()).toBe(RECALL_NUDGE);
  });

  it('matches case-insensitively', () => {
    runPromptSearch(JSON.stringify({ session_id: 's1', prompt: 'first prompt' }));
    const out = runPromptSearch(
      JSON.stringify({ session_id: 's1', prompt: 'Remember what we discussed?' }),
    );
    expect(out.trim()).toBe(RECALL_NUDGE);
  });

  it('matches the Spanish keyword variants', () => {
    runPromptSearch(JSON.stringify({ session_id: 's1', prompt: 'first prompt' }));
    const out = runPromptSearch(
      JSON.stringify({ session_id: 's1', prompt: '¿Acuérdate de lo que hicimos?' }),
    );
    expect(out.trim()).toBe(RECALL_NUDGE);
  });

  it('both nudges fire together when the first prompt of a session also matches a recall keyword', () => {
    const out = runPromptSearch(
      JSON.stringify({ session_id: 's1', prompt: 'remember what we did?' }),
    );
    expect(out.trim().split('\n')).toEqual([FIRST_PROMPT_NUDGE, RECALL_NUDGE]);
  });

  it('stays fully silent on a later turn with no keyword match', () => {
    runPromptSearch(JSON.stringify({ session_id: 's1', prompt: 'turn one' }));
    const out = runPromptSearch(
      JSON.stringify({ session_id: 's1', prompt: 'please fix the failing test' }),
    );
    expect(out.trim()).toBe('');
  });

  it('falls through and emits the recall nudge when stdin has no prompt field', () => {
    runPromptSearch(JSON.stringify({ session_id: 's1' }));
    const out = runPromptSearch(JSON.stringify({ session_id: 's1' }));
    expect(out.trim()).toBe(RECALL_NUDGE);
  });

  it('falls through and emits the recall nudge when stdin is empty', () => {
    runPromptSearch('');
    const out = runPromptSearch('');
    expect(out.trim()).toBe(RECALL_NUDGE);
  });

  it('an unwritable counter dir fails closed on first-turn detection but keyword matching still works', () => {
    // TMPDIR pointing at a regular file (not a directory) makes
    // `mkdir -p "$TMPDIR/rembric-relevance-prefetch"` fail, so the counter
    // can never be written or read — the exact "COUNT unreadable" case.
    const notADir = join(counterDir, 'this-is-a-file-not-a-dir');
    writeFileSync(notADir, '');
    const out = execFileSync('bash', [promptSearchSh], {
      input: JSON.stringify({
        session_id: 's-broken-counter',
        prompt: 'please fix the failing test',
      }),
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: notADir },
    });
    expect(out.trim()).toBe('');
  });
});

describe('server-side entity hints (proactive-entity-recall)', () => {
  let hintServer: Server;
  let capturedBody: string;
  let respondWith: () => { status: number; body: string };
  let baseUrl: string;
  let projectDir: string;

  beforeEach(async () => {
    capturedBody = '';
    respondWith = () => ({
      status: 200,
      body: JSON.stringify({ ok: true, lines: ['rembric: entity hint line'] }),
    });
    hintServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk));
      req.on('end', () => {
        capturedBody = body;
        const { status, body: responseBody } = respondWith();
        res.statusCode = status;
        res.setHeader('Content-Type', 'application/json');
        res.end(responseBody);
      });
    });
    await new Promise<void>((resolve) => hintServer.listen(0, '127.0.0.1', resolve));
    const addr = hintServer.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    projectDir = mkdtempSync(join(tmpdir(), 'rembric-promptsearch-proj-'));
    writeFileSync(join(projectDir, '.rembric'), 'PROJECT_SLUG=hint-test-proj\n');
  });

  afterEach(() => {
    hintServer.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  // spawn, not execFileSync: the in-process stub server answers from THIS
  // worker's event loop, which a synchronous spawn would block — curl would
  // time out against a server that never gets to run.
  function runHookAsync(
    stdin: string,
    envOverrides: Record<string, string | undefined>,
  ): Promise<{ stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn('bash', [promptSearchSh], {
        cwd: projectDir,
        env: { ...process.env, TMPDIR: counterDir, ...envOverrides },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d));
      child.stderr.on('data', (d: Buffer) => (stderr += d));
      child.on('error', reject);
      child.on('close', () => resolve({ stdout, stderr }));
      child.stdin.write(stdin);
      child.stdin.end();
    });
  }

  it('echoes hint lines after the local nudges, redacting <private> spans', async () => {
    const { stdout } = await runHookAsync(
      JSON.stringify({
        session_id: 's-hints',
        prompt: 'look at <private>secret stuff</private> then fix src/auth/handler.ts',
      }),
      { REMBRIC_SERVER_URL: baseUrl, REMBRIC_API_TOKEN: 'test-token' },
    );
    expect(capturedBody).toBe(
      JSON.stringify({ prompt: 'look at [REDACTED] then fix src/auth/handler.ts' }),
    );
    expect(stdout).toContain(FIRST_PROMPT_NUDGE);
    expect(stdout).toContain('rembric: entity hint line');
  });

  it('redacts an unclosed <private> span and caps the prompt at 500 chars', async () => {
    const long = 'x'.repeat(600);
    await runHookAsync(
      JSON.stringify({
        session_id: 's-hints',
        prompt: `private <private>tail keeps flowing ${long}`,
      }),
      { REMBRIC_SERVER_URL: baseUrl, REMBRIC_API_TOKEN: 'test-token' },
    );
    const parsed = JSON.parse(capturedBody) as { prompt: string };
    // The core keeps the text BEFORE the unclosed span (replace from the tag
    // to end) — only the flowing tail is redacted.
    expect(parsed.prompt).toBe('private [REDACTED]');
    expect(parsed.prompt.length).toBeLessThanOrEqual(500);
  });

  it('stays silent on hints when the hook carries no server credentials', async () => {
    const { stdout } = await runHookAsync(
      JSON.stringify({ session_id: 's-hints', prompt: 'fix src/auth/handler.ts' }),
      { REMBRIC_SERVER_URL: undefined, REMBRIC_API_TOKEN: undefined },
    );
    expect(capturedBody).toBe('');
    expect(stdout).toContain(FIRST_PROMPT_NUDGE);
    expect(stdout).not.toContain('entity hint');
  });

  it('a failing hints endpoint still emits the local nudges', async () => {
    respondWith = () => ({ status: 500, body: 'boom' });
    const { stdout } = await runHookAsync(
      JSON.stringify({ session_id: 's-hints', prompt: 'fix src/auth/handler.ts' }),
      { REMBRIC_SERVER_URL: baseUrl, REMBRIC_API_TOKEN: 'test-token' },
    );
    expect(stdout).toContain(FIRST_PROMPT_NUDGE);
    expect(stdout).not.toContain('entity hint');
  });
});
