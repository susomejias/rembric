import { createServer, type IncomingMessage, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const stopReportSh = join(here, '..', 'scripts', 'stop-report.sh');
const execFileAsync = promisify(execFile);

type CapturedRequest = { method: string; path: string; body: string };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

let counterDir: string;
let transcriptDir: string;
let cwd: string;
let server: Server;
let serverUrl: string;
let requests: CapturedRequest[];
/** What the stub answers `/turn` with. */
let turnResponse: { status: number; body: string };

function writeTranscript(name: string, content: string): string {
  const p = join(transcriptDir, name);
  writeFileSync(p, content);
  return p;
}

async function run(
  agent: string | undefined,
  stdin: string,
  env: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string }> {
  const child = execFileAsync('bash', agent ? [stopReportSh, agent] : [stopReportSh], {
    encoding: 'utf8',
    env: {
      ...process.env,
      TMPDIR: counterDir,
      REMBRIC_SERVER_URL: serverUrl,
      REMBRIC_API_TOKEN: 'test-token',
      ...env,
    },
  });
  child.child.stdin?.end(stdin);
  return child;
}

beforeEach(async () => {
  counterDir = mkdtempSync(join(tmpdir(), 'rbr-stopreport-'));
  transcriptDir = mkdtempSync(join(tmpdir(), 'rbr-stopreport-tx-'));
  cwd = mkdtempSync(join(tmpdir(), 'rbr-stopreport-cwd-'));
  writeFileSync(join(cwd, '.rembric'), 'PROJECT_SLUG=demo\n');
  requests = [];
  turnResponse = { status: 200, body: '{"ok":true,"sessionId":"s","lines":[]}' };
  server = createServer((req, res) => {
    readBody(req)
      .then((body) => {
        requests.push({ method: req.method ?? '', path: req.url ?? '', body });
        if (req.url?.endsWith('/turn')) {
          res.writeHead(turnResponse.status, { 'Content-Type': 'application/json' });
          res.end(turnResponse.body);
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
  rmSync(counterDir, { recursive: true, force: true });
  rmSync(transcriptDir, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('stop-report.sh', () => {
  it('emits nothing on Claude Code and reports the turn', async () => {
    const transcript = writeTranscript('t1.jsonl', '{"type":"user"}\n');
    const { stdout } = await run(
      'claude-code',
      JSON.stringify({
        session_id: 's-cc',
        cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    );
    expect(stdout).toBe('');
    expect(requests.some((r) => r.path.endsWith('/turn'))).toBe(true);
  });

  it('emits exactly {} on Codex', async () => {
    const transcript = writeTranscript('t2.jsonl', '{"type":"user"}\n');
    const { stdout } = await run(
      'codex-cli',
      JSON.stringify({
        session_id: 's-codex',
        cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    );
    expect(stdout).toBe('{}');
  });

  it('detects a tool-use turn on Claude Code via "type":"tool_use"', async () => {
    const transcript = writeTranscript(
      't3.jsonl',
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Bash"}]}}\n',
    );
    await run(
      'claude-code',
      JSON.stringify({
        session_id: 's-tool',
        cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    );
    const turnReq = requests.find((r) => r.path.endsWith('/turn'));
    expect(turnReq).toBeDefined();
    expect(JSON.parse(turnReq!.body).usedTools).toBe(true);
  });

  it('reports usedTools:false for a conversation-only turn', async () => {
    const transcript = writeTranscript(
      't4.jsonl',
      '{"type":"user","message":{"content":[{"type":"text","text":"hi"}]}}\n',
    );
    await run(
      'claude-code',
      JSON.stringify({
        session_id: 's-convo',
        cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    );
    const turnReq = requests.find((r) => r.path.endsWith('/turn'));
    expect(JSON.parse(turnReq!.body).usedTools).toBe(false);
  });

  it('detects a tool-use turn on Codex via "function_call"', async () => {
    const transcript = writeTranscript(
      't5.jsonl',
      '{"type":"item","item":{"type":"function_call","name":"shell"}}\n',
    );
    await run(
      'codex-cli',
      JSON.stringify({
        session_id: 's-codex-tool',
        cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    );
    const turnReq = requests.find((r) => r.path.endsWith('/turn'));
    expect(JSON.parse(turnReq!.body).usedTools).toBe(true);
  });

  it('scans only the delta since the previous report, not the whole transcript again', async () => {
    const transcript = join(transcriptDir, 't6.jsonl');
    writeFileSync(transcript, '{"type":"user"}\n');
    await run(
      'claude-code',
      JSON.stringify({
        session_id: 's-delta',
        cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    );
    let turnReq = requests.find((r) => r.path.endsWith('/turn'));
    expect(JSON.parse(turnReq!.body).usedTools).toBe(false);

    requests.length = 0;
    // Append a tool-use event AFTER the first report's offset.
    writeFileSync(
      transcript,
      '{"type":"user"}\n{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}\n',
      { flag: 'a' },
    );
    await run(
      'claude-code',
      JSON.stringify({
        session_id: 's-delta',
        cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    );
    turnReq = requests.find((r) => r.path.endsWith('/turn'));
    expect(JSON.parse(turnReq!.body).usedTools).toBe(true);
  });

  it('caches the response lines for prompt-nudge.sh to print', async () => {
    turnResponse = {
      status: 200,
      body: '{"ok":true,"sessionId":"s","lines":["rembric: a notice"]}',
    };
    const transcript = writeTranscript('t7.jsonl', '{"type":"user"}\n');
    await run(
      'claude-code',
      JSON.stringify({
        session_id: 's-cache',
        cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    );
    const cached = readFileSync(join(counterDir, 'rembric-pending', 's-cache'), 'utf8');
    expect(cached).toBe('rembric: a notice');
  });

  it('sends the recorded first prompt as title on the first report only', async () => {
    mkdirSync(join(counterDir, 'rembric-first-prompt'), { recursive: true });
    writeFileSync(join(counterDir, 'rembric-first-prompt', 's-title'), 'the first prompt');
    const transcript = writeTranscript('t8.jsonl', '{"type":"user"}\n');
    await run(
      'claude-code',
      JSON.stringify({
        session_id: 's-title',
        cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    );
    const turnReq = requests.find((r) => r.path.endsWith('/turn'));
    expect(JSON.parse(turnReq!.body).title).toBe('the first prompt');

    // Consumed: a second report for the same session carries no title.
    requests.length = 0;
    await run(
      'claude-code',
      JSON.stringify({
        session_id: 's-title',
        cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    );
    const secondReq = requests.find((r) => r.path.endsWith('/turn'));
    expect('title' in JSON.parse(secondReq!.body)).toBe(false);
  });

  describe('the loop guard', () => {
    it('fires before any transcript read (assert ORDER, not just the outcome)', async () => {
      // A transcript path that does not exist: if the script reads it before
      // checking stop_hook_active, this would surface as a distinct failure
      // mode from "guard checked first, transcript never touched".
      const missingPath = join(transcriptDir, 'does-not-exist.jsonl');
      const { stdout } = await run(
        'claude-code',
        JSON.stringify({
          session_id: 's-guard',
          transcript_path: missingPath,
          stop_hook_active: true,
        }),
      );
      expect(stdout).toBe('');
      expect(requests).toHaveLength(0);
    });

    it('the identical input with the flag false issues exactly one report', async () => {
      const transcript = writeTranscript('t9.jsonl', '{"type":"user"}\n');
      await run(
        'claude-code',
        JSON.stringify({
          session_id: 's-guard-2',
          cwd,
          transcript_path: transcript,
          stop_hook_active: false,
        }),
      );
      expect(requests.filter((r) => r.path.endsWith('/turn'))).toHaveLength(1);
    });

    it('an absent stop_hook_active key still reports', async () => {
      const transcript = writeTranscript('t10.jsonl', '{"type":"user"}\n');
      await run(
        'claude-code',
        JSON.stringify({ session_id: 's-guard-absent', cwd, transcript_path: transcript }),
      );
      expect(requests.filter((r) => r.path.endsWith('/turn'))).toHaveLength(1);
    });
  });

  it('a 404 caches nothing and clears nothing', async () => {
    turnResponse = { status: 404, body: '{"ok":false,"code":"not_found"}' };
    mkdirSync(join(counterDir, 'rembric-pending'), { recursive: true });
    writeFileSync(join(counterDir, 'rembric-pending', 's-404'), 'a pending notice');
    const transcript = writeTranscript('t11.jsonl', '{"type":"user"}\n');
    await run(
      'claude-code',
      JSON.stringify({
        session_id: 's-404',
        cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    );
    const cached = readFileSync(join(counterDir, 'rembric-pending', 's-404'), 'utf8');
    expect(cached).toBe('a pending notice');
  });

  it('an unreachable server prints one stderr line and exits 0', async () => {
    const transcript = writeTranscript('t12.jsonl', '{"type":"user"}\n');
    const { stderr } = await run(
      'claude-code',
      JSON.stringify({
        session_id: 's-down',
        cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
      { REMBRIC_SERVER_URL: 'http://127.0.0.1:1', REMBRIC_POST_MAX_TIME: '1' },
    );
    const diagnosticLines = stderr.split('\n').filter((l) => l.startsWith('[rembric]'));
    expect(diagnosticLines).toHaveLength(1);
  });

  it('the cold-offset path scans at most 256 KB', async () => {
    // A transcript with no marker within the last 256 KB, but WITH one
    // further back — only the bounded cold scan is exercised, so it must
    // NOT be found.
    const filler = 'x'.repeat(300 * 1024);
    const transcript = join(transcriptDir, 't13.jsonl');
    writeFileSync(
      transcript,
      `{"type":"assistant","message":{"content":[{"type":"tool_use"}]}}\n${filler}\n{"type":"user"}\n`,
    );
    await run(
      'claude-code',
      JSON.stringify({
        session_id: 's-cold',
        cwd,
        transcript_path: transcript,
        stop_hook_active: false,
      }),
    );
    const turnReq = requests.find((r) => r.path.endsWith('/turn'));
    expect(JSON.parse(turnReq!.body).usedTools).toBe(false);
  });
});
