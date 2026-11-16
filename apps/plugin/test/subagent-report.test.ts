import { spawn, spawnSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const subagentReportSh = join(here, '..', 'scripts', 'subagent-report.sh');

const HIDE_JQ = `command() { [ "$2" = jq ] && return 1; builtin command "$@"; }`;

type CapturedRequest = { method: string; path: string; body: string; auth: string };
type RunResult = { stdout: string; stderr: string; code: number | null; ms: number };

const LEARNINGS = '## Key Learnings\n1. The parser keeps "quoted" text and a back\\slash.';
const REPORT = `Done: refactored\tthe loader.\n\n${LEARNINGS}`;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

let scratch: string;
let cwd: string;
let server: Server;
let serverUrl: string;
let requests: CapturedRequest[];

function run(
  agent: string,
  stdin: string,
  opts: { env?: NodeJS.ProcessEnv; hideJq?: boolean } = {},
): Promise<RunResult> {
  const args = opts.hideJq
    ? ['-c', `${HIDE_JQ}\nsource '${subagentReportSh}' "$@"`, 'bash', agent]
    : [subagentReportSh, agent];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn('bash', args, {
      env: {
        ...process.env,
        TMPDIR: scratch,
        REMBRIC_SERVER_URL: serverUrl,
        REMBRIC_API_TOKEN: 'test-token',
        ...opts.env,
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString('utf8')));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));
    child.on('close', (code) => resolve({ stdout, stderr, code, ms: Date.now() - started }));
    child.stdin.end(stdin);
  });
}

function handback(message: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'parent-1',
    transcript_path: '/tmp/parent.jsonl',
    cwd,
    permission_mode: 'auto',
    hook_event_name: 'PreToolUse',
    tool_name: 'SubagentHandback',
    tool_input: { message },
    tool_use_id: 'toolu_1',
    agent_id: 'agent-1',
    agent_type: 'Explore',
    ...extra,
  });
}

function claudeStop(message: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'parent-1',
    transcript_path: '/tmp/parent.jsonl',
    cwd,
    permission_mode: 'default',
    hook_event_name: 'SubagentStop',
    stop_hook_active: false,
    agent_id: 'agent-1',
    agent_type: 'general-purpose',
    agent_transcript_path: '/tmp/agent-1.jsonl',
    last_assistant_message: message,
    background_tasks: [],
    session_crons: [],
    ...extra,
  });
}

function codexStop(message: string | null, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    session_id: 'codex-parent',
    transcript_path: '/tmp/codex.jsonl',
    cwd,
    hook_event_name: 'SubagentStop',
    model: 'gpt-5-codex',
    permission_mode: 'default',
    turn_id: 'turn-1',
    agent_id: 'agent-9',
    agent_type: 'worker',
    agent_transcript_path: '/tmp/agent-9.jsonl',
    stop_hook_active: false,
    last_assistant_message: message,
    ...extra,
  });
}

beforeEach(async () => {
  scratch = mkdtempSync(join(tmpdir(), 'rbr-subagent-'));
  cwd = mkdtempSync(join(tmpdir(), 'rbr-subagent-cwd-'));
  writeFileSync(join(cwd, '.rembric'), 'PROJECT_SLUG=demo\n');
  requests = [];
  server = createServer((req, res) => {
    readBody(req)
      .then((body) => {
        requests.push({
          method: req.method ?? '',
          path: req.url ?? '',
          body,
          auth: req.headers.authorization ?? '',
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"ok":true,"saved":1,"skipped":0}');
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
  rmSync(scratch, { recursive: true, force: true });
  rmSync(cwd, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('subagent-report.sh claude-code', () => {
  it('forwards a hand-back report with its agent type, silently', async () => {
    const result = await run('claude-code', handback(REPORT));
    expect(result).toMatchObject({ stdout: '', stderr: '', code: 0 });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toEqual({
      method: 'POST',
      path: '/api/demo/sessions/parent-1/learnings',
      body: JSON.stringify({ report: REPORT, agentType: 'Explore' }),
      auth: 'Bearer test-token',
    });
  });

  it('forwards a SubagentStop report', async () => {
    const result = await run('claude-code', claudeStop(REPORT));
    expect(result).toMatchObject({ stdout: '', stderr: '', code: 0 });
    expect(requests.map((r) => [r.path, r.body])).toEqual([
      [
        '/api/demo/sessions/parent-1/learnings',
        JSON.stringify({ report: REPORT, agentType: 'general-purpose' }),
      ],
    ]);
  });

  it.each([
    ['an empty agent_type', { agent_type: '' }],
    ['no agent_type at all', { agent_type: undefined }],
  ])('ignores a host-internal agent with %s', async (_label, extra) => {
    const result = await run('claude-code', claudeStop(REPORT, extra));
    expect(result).toMatchObject({ stdout: '', stderr: '', code: 0 });
    expect(requests).toEqual([]);
  });

  it('does not send a report without the phrase', async () => {
    const result = await run('claude-code', claudeStop('Done. Nothing else to say.'));
    expect(result).toMatchObject({ stdout: '', stderr: '', code: 0 });
    expect(requests).toEqual([]);
  });

  it('matches the phrase in any letter case', async () => {
    const shouting = 'Done.\n\n## KEY LEARNINGS\n1. Upper case still counts as the phrase.';
    await run('claude-code', claudeStop(shouting));
    expect(requests.map((r) => JSON.parse(r.body).report)).toEqual([shouting]);
  });

  it('never sends a private span', async () => {
    const withSecret = `Context <private>secret-value</private> kept.\n${LEARNINGS}`;
    await run('claude-code', handback(withSecret));
    expect(requests).toHaveLength(1);
    expect(requests[0]!.body).not.toContain('secret-value');
    expect(JSON.parse(requests[0]!.body).report).toBe(`Context [REDACTED] kept.\n${LEARNINGS}`);
  });

  it('does not send a report whose only phrase is inside a private span', async () => {
    const hidden = 'Done. <private>## Key Learnings\n1. secret</private>';
    const result = await run('claude-code', handback(hidden));
    expect(result).toMatchObject({ stdout: '', stderr: '', code: 0 });
    expect(requests).toEqual([]);
  });

  it.each([
    ['a null report', claudeStop(null)],
    ['an empty report', claudeStop('')],
    ['an empty session id', claudeStop(REPORT, { session_id: '' })],
    ['an unrelated event', claudeStop(REPORT, { hook_event_name: 'Stop' })],
  ])('makes no request for %s', async (_label, stdin) => {
    const result = await run('claude-code', stdin);
    expect(result).toMatchObject({ stdout: '', stderr: '', code: 0 });
    expect(requests).toEqual([]);
  });

  it('makes no request when no slug resolves from the cwd', async () => {
    const bare = mkdtempSync(join(tmpdir(), 'rbr-subagent-noslug-'));
    try {
      const result = await run('claude-code', claudeStop(REPORT, { cwd: bare }));
      expect(result).toMatchObject({ stdout: '', stderr: '', code: 0 });
      expect(requests).toEqual([]);
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  });

  it('turns a failed POST into one stderr line and exit 0', async () => {
    const result = await run('claude-code', handback(REPORT), {
      env: { REMBRIC_SERVER_URL: 'http://127.0.0.1:1' },
    });
    expect(result.stdout).toBe('');
    expect(result.code).toBe(0);
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
    expect(result.stderr).toContain('/api/demo/sessions/parent-1/learnings');
  });
});

describe('subagent-report.sh codex-cli', () => {
  it('forwards the report to the parent session and prints exactly {}', async () => {
    const result = await run('codex-cli', codexStop(REPORT));
    expect(result).toMatchObject({ stdout: '{}', stderr: '', code: 0 });
    expect(requests.map((r) => [r.path, r.body])).toEqual([
      [
        '/api/demo/sessions/codex-parent/learnings',
        JSON.stringify({ report: REPORT, agentType: 'worker' }),
      ],
    ]);
  });

  it('forwards a report with no agent type and omits agentType', async () => {
    const result = await run('codex-cli', codexStop(REPORT, { agent_type: '' }));
    expect(result).toMatchObject({ stdout: '{}', stderr: '', code: 0 });
    expect(requests.map((r) => r.body)).toEqual([JSON.stringify({ report: REPORT })]);
  });

  it.each([
    ['a report without the phrase', codexStop('Finished the task.')],
    ['a null report', codexStop(null)],
    ['an empty stdin', ''],
  ])('prints exactly {} and sends nothing for %s', async (_label, stdin) => {
    const result = await run('codex-cli', stdin);
    expect(result).toMatchObject({ stdout: '{}', stderr: '', code: 0 });
    expect(requests).toEqual([]);
  });

  it('prints exactly {} and one stderr line when the server is unreachable', async () => {
    const result = await run('codex-cli', codexStop(REPORT), {
      env: { REMBRIC_SERVER_URL: 'http://127.0.0.1:1' },
    });
    expect(result.stdout).toBe('{}');
    expect(result.code).toBe(0);
    expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
  });

  it('caps a hanging POST at 2 seconds, inside the 3-second hook timeout', async () => {
    const hanging = createServer(() => undefined);
    await new Promise<void>((resolve) => hanging.listen(0, '127.0.0.1', resolve));
    const address = hanging.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    try {
      const result = await run('codex-cli', codexStop(REPORT), {
        env: { REMBRIC_SERVER_URL: `http://127.0.0.1:${port}` },
      });
      expect(result.stdout).toBe('{}');
      expect(result.code).toBe(0);
      expect(result.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(result.ms).toBeGreaterThanOrEqual(1900);
      expect(result.ms).toBeLessThan(2900);
    } finally {
      hanging.closeAllConnections();
      await new Promise<void>((resolve) => hanging.close(() => resolve()));
    }
  });
});

describe('rembric_subagent_report fails closed without the redactor', () => {
  const scripts = join(here, '..', 'scripts');

  function callHelper(sourced: string[]): Promise<number | null> {
    const script = [
      ...sourced.map((f) => `source '${join(scripts, f)}'`),
      'rembric_subagent_report claude-code "$1"',
    ].join('\n');
    return new Promise((resolve) => {
      const child = spawn('bash', ['-c', script, 'bash', handback(REPORT)], {
        env: {
          ...process.env,
          TMPDIR: scratch,
          REMBRIC_SERVER_URL: serverUrl,
          REMBRIC_API_TOKEN: 'test-token',
        },
        stdio: 'ignore',
      });
      child.on('close', resolve);
    });
  }

  it('sends nothing when _transcript.sh was not sourced', async () => {
    await callHelper(['_api.sh']);
    expect(requests).toEqual([]);
  });

  it('control: the same call with the redactor loaded sends the report', async () => {
    await callHelper(['_api.sh', '_transcript.sh']);
    expect(requests.map((r) => r.path)).toEqual(['/api/demo/sessions/parent-1/learnings']);
  });
});

describe('subagent-report.sh sends the same body with and without jq', () => {
  const TRICKY = [
    'Line "one" with \\ a backslash, a /slash/ and\ttab.',
    'Unicode: café — ✓',
    '<PRIVATE>drop me</private> tail',
    '### key learnings',
    '1. message: "not a key" here',
  ].join('\n');

  it('control: the override really hides jq, and jq is otherwise present', () => {
    expect(spawnSync('bash', ['-c', `${HIDE_JQ}\ncommand -v jq`]).status).not.toBe(0);
    expect(spawnSync('bash', ['-c', 'command -v jq']).status).toBe(0);
  });

  it.each([
    ['claude-code', 'a hand-back', () => handback(TRICKY)],
    ['claude-code', 'a SubagentStop', () => claudeStop(TRICKY)],
    ['codex-cli', 'a Codex SubagentStop', () => codexStop(TRICKY)],
  ])('%s: %s', async (agent, _label, stdin) => {
    const withJq = await run(agent, stdin());
    const withoutJq = await run(agent, stdin(), { hideJq: true });
    expect(withoutJq.stdout).toBe(withJq.stdout);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.path).toBe(requests[0]!.path);
    expect(requests[1]!.body).toBe(requests[0]!.body);
    expect(JSON.parse(requests[0]!.body).report).toBe(
      TRICKY.replace('<PRIVATE>drop me</private>', '[REDACTED]'),
    );
  });
});
