import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import fixtures from './file-recall-fixtures.json' with { type: 'json' };

// A git hook exports GIT_DIR, which would point the git calls in these tests at the real repository.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, '..', 'scripts');
const fileRecallSh = join(scripts, 'file-recall.sh');
const postCompactSh = join(scripts, 'post-compact.sh');
const apiSh = join(scripts, '_api.sh');

const bashLines = (fn: string, arg: string): string[] =>
  execFileSync('bash', ['-c', `source "${apiSh}"; ${fn} "$1"`, 'x', arg])
    .toString()
    .split('\n')
    .filter(Boolean);

describe('shell-path extraction (bash) agrees with the shared fixture', () => {
  it.each(fixtures.commands.map((c) => [c.command, c.paths] as const))('%j', (command, paths) => {
    expect(bashLines('rembric_command_paths', command)).toEqual(paths);
  });

  it.each(fixtures.patches.map((p) => [p.patch, p.paths] as const))('patch %#', (patch, paths) => {
    expect(bashLines('rembric_patch_paths', patch)).toEqual(paths);
  });
});

describe('file-recall.sh', () => {
  let server: Server;
  let baseUrl = '';
  let repo = '';
  let scratch = '';
  let requests: { url: string; body: Record<string, unknown> }[] = [];
  let respond: (path: string) => { status: number; body: unknown } | 'hang';
  let held: ServerResponse[] = [];

  const LINE = (path: string) => `rembric: memories about ${path}:`;

  beforeEach(async () => {
    requests = [];
    held = [];
    respond = (path) => ({
      status: 200,
      body: { ok: true, lines: [LINE(path)], exhausted: false },
    });
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c));
      req.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(raw) as Record<string, unknown>;
        } catch {}
        requests.push({ url: req.url ?? '', body });
        const answer = (req.url ?? '').endsWith('/file-recall')
          ? respond(String(body['path']))
          : { status: 200, body: { ok: true } };
        if (answer === 'hang') {
          held.push(res);
          return;
        }
        res.statusCode = answer.status;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(answer.body));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    baseUrl = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

    repo = mkdtempSync(join(tmpdir(), 'rembric-filerecall-repo-'));
    scratch = mkdtempSync(join(tmpdir(), 'rembric-filerecall-tmp-'));
    writeFileSync(join(repo, '.rembric'), 'PROJECT_SLUG=fr-test\n');
    for (const f of [
      'packages/db/src/migrate.ts',
      'packages/core/src/services/review.ts',
      'apps/web/src/services/review.ts',
      'src/a.ts',
      'src/b.ts',
      'nb/analysis.ipynb',
      ...Array.from({ length: 8 }, (_, i) => `par/f${i}.ts`),
    ]) {
      mkdirSync(join(repo, dirname(f)), { recursive: true });
      writeFileSync(join(repo, f), 'x\n');
    }
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
  });

  afterEach(() => {
    for (const r of held) r.destroy();
    server.close();
    rmSync(repo, { recursive: true, force: true });
    rmSync(scratch, { recursive: true, force: true });
  });

  function run(
    script: string,
    stdin: Record<string, unknown>,
    args: string[] = ['claude-code'],
    env: Record<string, string> = {},
  ): Promise<{ stdout: string; status: number | null; ms: number }> {
    const started = Date.now();
    return new Promise((resolve, reject) => {
      const child = spawn('bash', [script, ...args], {
        cwd: repo,
        env: {
          ...process.env,
          TMPDIR: scratch,
          REMBRIC_SERVER_URL: baseUrl,
          REMBRIC_API_TOKEN: 'tok',
          ...env,
        },
      });
      let stdout = '';
      child.stdout.on('data', (d: Buffer) => (stdout += d));
      child.on('error', reject);
      child.on('close', (status) => resolve({ stdout, status, ms: Date.now() - started }));
      child.stdin.end(JSON.stringify({ session_id: 'sess-1', cwd: repo, ...stdin }));
    });
  }

  const bash = (command: string, extra: Record<string, unknown> = {}) =>
    run(fileRecallSh, { tool_name: 'Bash', tool_input: { command }, ...extra });
  const recallRequests = () => requests.filter((r) => r.url.endsWith('/file-recall'));

  it('injects a Bash read once per file, then issues no request for it', async () => {
    const first = await bash('sed -n 1,40p packages/db/src/migrate.ts');
    expect(first.status).toBe(0);
    const out = JSON.parse(first.stdout) as { hookSpecificOutput: Record<string, unknown> };
    expect(out.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      additionalContext: LINE('packages/db/src/migrate.ts'),
    });
    expect(recallRequests()).toHaveLength(1);
    expect(recallRequests()[0]!.url).toBe('/api/fr-test/sessions/sess-1/file-recall');
    expect(recallRequests()[0]!.body).toEqual({
      path: 'packages/db/src/migrate.ts',
      siblings: ['packages/db/src/migrate.ts'],
    });

    const second = await bash('cat packages/db/src/migrate.ts');
    expect(second.stdout).toBe('');
    expect(recallRequests()).toHaveLength(1);
  });

  it('sends every same-name sibling so the server can judge suffixes', async () => {
    await bash('cat packages/core/src/services/review.ts');
    expect(recallRequests()[0]!.body['siblings']).toEqual([
      'apps/web/src/services/review.ts',
      'packages/core/src/services/review.ts',
    ]);
  });

  it('omits the siblings past 64 same-name files, so only the exact path can match', async () => {
    for (let i = 0; i < 65; i++) {
      mkdirSync(join(repo, `many/d${i}`), { recursive: true });
      writeFileSync(join(repo, `many/d${i}/same.md`), 'x');
    }
    execFileSync('git', ['add', '-A'], { cwd: repo });
    await bash('cat many/d0/same.md');
    expect(recallRequests()[0]!.body).toEqual({ path: 'many/d0/same.md' });
  });

  it('reads the path of Read, Edit, Write and NotebookEdit, made repo-relative', async () => {
    await run(fileRecallSh, {
      tool_name: 'Read',
      tool_input: { file_path: join(repo, 'src/a.ts') },
    });
    await run(fileRecallSh, {
      tool_name: 'Edit',
      tool_input: { file_path: join(repo, 'src/b.ts') },
    });
    await run(fileRecallSh, {
      tool_name: 'NotebookEdit',
      tool_input: { notebook_path: join(repo, 'nb/analysis.ipynb') },
    });
    expect(recallRequests().map((r) => r.body['path'])).toEqual([
      'src/a.ts',
      'src/b.ts',
      'nb/analysis.ipynb',
    ]);
  });

  it('never lets a directory or glob token stand in for a file it happens to match', async () => {
    await bash(`grep -rn TODO ${repo}/src/`);
    await bash('ls src/*.ts packages/db/src/');
    expect(recallRequests()).toHaveLength(0);
    await bash('cat src/a.ts');
    expect(recallRequests().map((r) => r.body['path'])).toEqual(['src/a.ts']);
  });

  it('matches a bracketed route path literally, never as a glob', async () => {
    mkdirSync(join(repo, 'app', '[id]'), { recursive: true });
    writeFileSync(join(repo, 'app', '[id]', 'page.ts'), 'x');
    mkdirSync(join(repo, 'app', 'i'), { recursive: true });
    writeFileSync(join(repo, 'app', 'i', 'page.ts'), 'x');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    await bash('cat "app/[id]/page.ts"');
    expect(recallRequests().map((r) => r.body['path'])).toEqual(['app/[id]/page.ts']);
  });

  it('sends a non-ASCII file name as itself, not C-quoted', async () => {
    writeFileSync(join(repo, 'src', 'ünï.ts'), 'x');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    await bash('cat src/ünï.ts');
    expect(recallRequests()[0]!.body).toEqual({ path: 'src/ünï.ts', siblings: ['src/ünï.ts'] });
  });

  it('stops a firing at its first failed request and leaves the other files for later', async () => {
    respond = () => 'hang';
    const hung = await bash('cat src/a.ts src/b.ts packages/db/src/migrate.ts');
    expect(hung.stdout).toBe('');
    expect(recallRequests()).toHaveLength(1);
    expect(hung.ms).toBeLessThan(1500);
    respond = (path) => ({ status: 200, body: { ok: true, lines: [LINE(path)] } });
    await bash('cat src/b.ts');
    expect(recallRequests().map((r) => r.body['path'])).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('reads a CRLF apply_patch', async () => {
    const patch = '*** Begin Patch\r\n*** Update File: src/a.ts\r\n@@\r\n-x\r\n+y\r\n*** End Patch';
    await run(fileRecallSh, { tool_name: 'apply_patch', tool_input: { command: patch } }, [
      'codex-cli',
    ]);
    expect(recallRequests().map((r) => r.body['path'])).toEqual(['src/a.ts']);
  });

  it('never sends a path the repository does not track', async () => {
    const r = await bash('cat /etc/hosts ../outside.ts src/missing.ts');
    expect(r.stdout).toBe('');
    expect(recallRequests()).toHaveLength(0);
  });

  it('recalls the files of a Codex apply_patch and prints JSON without a permission decision', async () => {
    const patch = '*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch';
    const r = await run(
      fileRecallSh,
      { tool_name: 'apply_patch', tool_input: { command: patch } },
      ['codex-cli'],
    );
    const out = JSON.parse(r.stdout) as { hookSpecificOutput: Record<string, unknown> };
    expect(Object.keys(out.hookSpecificOutput).sort()).toEqual([
      'additionalContext',
      'hookEventName',
    ]);
    expect(recallRequests().map((x) => x.body['path'])).toEqual(['src/a.ts']);
  });

  it('prints JSON or nothing in every situation', async () => {
    respond = (path) =>
      path === 'src/b.ts'
        ? { status: 404, body: {} }
        : { status: 200, body: { ok: true, lines: [] } };
    for (const command of ['cat src/a.ts', 'cat src/b.ts', 'ls', 'cat src/a.ts']) {
      const r = await bash(command);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    }
  });

  it('stays silent and quick when the server hangs, answers 404, or the cwd is no repository', async () => {
    respond = () => 'hang';
    const hung = await bash('cat src/a.ts');
    expect(hung.stdout).toBe('');
    expect(hung.status).toBe(0);
    expect(hung.ms).toBeLessThan(2000);

    respond = () => ({ status: 404, body: { ok: false } });
    expect((await bash('cat src/b.ts')).stdout).toBe('');

    const outside = mkdtempSync(join(tmpdir(), 'rembric-filerecall-nogit-'));
    writeFileSync(join(outside, '.rembric'), 'PROJECT_SLUG=fr-test\n');
    mkdirSync(join(outside, 'src'));
    writeFileSync(join(outside, 'src', 'z.ts'), 'x');
    const before = recallRequests().length;
    const r = await bash('cat src/z.ts', { cwd: outside });
    rmSync(outside, { recursive: true, force: true });
    expect(r.stdout).toBe('');
    expect(recallRequests()).toHaveLength(before);
  });

  it('skips a sub-agent call', async () => {
    const r = await bash('cat src/a.ts', { agent_id: 'agent-123' });
    expect(r.stdout).toBe('');
    expect(recallRequests()).toHaveLength(0);
    await bash('cat src/a.ts');
    expect(recallRequests()).toHaveLength(1);
  });

  it('stops calling once the server says the session is exhausted', async () => {
    respond = (path) => ({ status: 200, body: { ok: true, lines: [LINE(path)], exhausted: true } });
    expect((await bash('cat src/a.ts')).stdout).toContain('src/a.ts');
    await bash('cat src/b.ts');
    expect(recallRequests()).toHaveLength(1);
  });

  it('claims each file atomically under concurrent firings', async () => {
    await Promise.all(Array.from({ length: 8 }, () => bash('cat packages/db/src/migrate.ts')));
    expect(recallRequests()).toHaveLength(1);

    const runs = await Promise.all(Array.from({ length: 8 }, (_, i) => bash(`cat par/f${i}.ts`)));
    expect(runs.every((r) => r.status === 0)).toBe(true);
    expect(
      recallRequests()
        .map((r) => r.body['path'])
        .filter((p) => String(p).startsWith('par/'))
        .sort(),
    ).toEqual(Array.from({ length: 8 }, (_, i) => `par/f${i}.ts`));
    const claims = readdirSync(join(scratch, 'rembric-file-recall', 'sess-1'));
    expect(claims).toHaveLength(9);
  });

  it('lets a compacted session be told again', async () => {
    await bash('cat src/a.ts');
    await bash('cat src/a.ts');
    expect(recallRequests()).toHaveLength(1);
    await run(postCompactSh, {});
    await bash('cat src/a.ts');
    expect(recallRequests()).toHaveLength(2);
  });
});
