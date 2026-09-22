import { spawn } from 'node:child_process';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const promptHintsSh = join(here, '..', 'scripts', 'prompt-hints.sh');
const HINT = 'rembric: entity hint line';

describe('prompt-hints.sh (dedicated entity-recall transport)', () => {
  let hintServer: Server;
  let capturedBody = '';
  let capturedPath = '';
  let respondWith: () => { status: number; body: string };
  let leaveUnanswered = false;
  let responseDelayMs = 0;
  let heldResponses = new Set<ServerResponse>();
  let baseUrl = '';
  let projectDir = '';

  beforeEach(async () => {
    capturedBody = '';
    capturedPath = '';
    leaveUnanswered = false;
    responseDelayMs = 0;
    heldResponses = new Set();
    respondWith = () => ({ status: 200, body: JSON.stringify({ ok: true, lines: [HINT] }) });
    hintServer = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk: Buffer) => (body += chunk));
      req.on('end', () => {
        capturedBody = body;
        capturedPath = req.url ?? '';
        if (leaveUnanswered) {
          heldResponses.add(res);
          return;
        }
        const respond = () => {
          const { status, body: out } = respondWith();
          res.statusCode = status;
          res.setHeader('Content-Type', 'application/json');
          res.end(out);
        };
        if (responseDelayMs > 0) setTimeout(respond, responseDelayMs);
        else respond();
      });
    });
    await new Promise<void>((resolve) => hintServer.listen(0, '127.0.0.1', resolve));
    const addr = hintServer.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    projectDir = mkdtempSync(join(tmpdir(), 'rembric-hintssh-proj-'));
    writeFileSync(join(projectDir, '.rembric'), 'PROJECT_SLUG=hint-test-proj\n');
  });

  afterEach(() => {
    for (const response of heldResponses) response.destroy();
    hintServer.close();
    rmSync(projectDir, { recursive: true, force: true });
  });

  function run(
    stdin: string,
    overrides: Record<string, string | undefined>,
  ): Promise<{ stdout: string; stderr: string; status: number | null }> {
    return new Promise((resolve, reject) => {
      const child = spawn('bash', [promptHintsSh], {
        cwd: projectDir,
        env: { ...process.env, ...overrides },
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d));
      child.stderr.on('data', (d: Buffer) => (stderr += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ stdout, stderr, status: code }));
      child.stdin.write(stdin);
      child.stdin.end();
    });
  }

  const withServer = () => ({ REMBRIC_SERVER_URL: baseUrl, REMBRIC_API_TOKEN: 'test-token' });

  it('posts the redacted prompt to the session-scoped hints path and echoes the lines', async () => {
    const { stdout, stderr } = await run(
      JSON.stringify({
        session_id: 's-1',
        prompt: 'look at <private>secret stuff</private> then fix src/auth/handler.ts',
      }),
      withServer(),
    );
    expect({ stderr, path: capturedPath }).toEqual({
      stderr: '',
      path: '/api/hint-test-proj/sessions/s-1/recall-hints',
    });
    expect(JSON.parse(capturedBody)).toEqual({
      prompt: 'look at [REDACTED] then fix src/auth/handler.ts',
    });
    expect(stderr).toBe('');
    expect(stdout).toContain(HINT);
  });

  it('uses the canonical case-insensitive redaction before truncating and JSON escaping', async () => {
    await run(
      JSON.stringify({
        session_id: 's-2',
        prompt: 'head <PRIVATE>secret\nstill private</pRiVaTe> after "quoted"',
      }),
      withServer(),
    );
    const parsed = JSON.parse(capturedBody) as { prompt: string };
    expect(parsed.prompt).toBe('head [REDACTED] after "quoted"');
    expect(parsed.prompt.length).toBeLessThanOrEqual(500);
  });

  it('redacts through end-of-text on an unclosed case-insensitive span', async () => {
    await run(
      JSON.stringify({
        session_id: 's-2-unclosed',
        prompt: `head <PrIvAtE>tail flows on ${'x'.repeat(600)}`,
      }),
      withServer(),
    );
    const parsed = JSON.parse(capturedBody) as { prompt: string };
    expect(parsed.prompt).toBe('head [REDACTED]');
  });

  it('makes no request without server credentials, and still exits 0', async () => {
    const { stdout, status } = await run(
      JSON.stringify({ session_id: 's-3', prompt: 'fix src/auth/handler.ts' }),
      { REMBRIC_SERVER_URL: undefined, REMBRIC_API_TOKEN: undefined },
    );
    expect(capturedBody).toBe('');
    expect(stdout).toBe('');
    expect(status).toBe(0);
  });

  it('emits nothing when the endpoint fails, so the model is never blocked', async () => {
    respondWith = () => ({ status: 500, body: 'boom' });
    const { stdout, status } = await run(
      JSON.stringify({ session_id: 's-4', prompt: 'fix src/auth/handler.ts' }),
      withServer(),
    );
    expect(stdout).not.toContain(HINT);
    expect(status).toBe(0);
  });

  it('uses the 200ms start-of-turn deadline instead of the shared 3s POST default', async () => {
    responseDelayMs = 260;
    const started = performance.now();
    const { stdout, status } = await run(
      JSON.stringify({ session_id: 's-deadline', prompt: 'fix src/auth/handler.ts' }),
      { ...withServer(), REMBRIC_POST_MAX_TIME: undefined },
    );
    const elapsed = performance.now() - started;

    expect(capturedPath).toBe('/api/hint-test-proj/sessions/s-deadline/recall-hints');
    expect(stdout).toBe('');
    expect(status).toBe(0);
    expect(elapsed).toBeLessThan(1_000);
  });

  it('skips the request entirely when the prompt is missing', async () => {
    const { status } = await run(JSON.stringify({ session_id: 's-5' }), withServer);
    expect(capturedBody).toBe('');
    expect(status).toBe(0);
  });
});
