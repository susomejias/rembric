import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createSessionProtocol, extractCommandPaths } from '../bin/rembric-plugin-core.mjs';

import fixtures from './file-recall-fixtures.json' with { type: 'json' };

// A git hook exports GIT_DIR, which would point the git calls in these tests at the real repository.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

describe('shell-path extraction (JS core) agrees with the shared fixture', () => {
  it.each(fixtures.commands.map((c) => [c.command, c.paths] as const))('%j', (command, paths) => {
    expect(extractCommandPaths(command)).toEqual(paths);
  });
});

describe('core fileRecall', () => {
  let server: Server;
  let baseUrl = '';
  let repo = '';
  let requests: Record<string, unknown>[] = [];
  let respond: (path: string) => { status: number; body: unknown } | 'hang';
  let held: ServerResponse[] = [];

  beforeEach(async () => {
    requests = [];
    held = [];
    respond = (path) => ({
      status: 200,
      body: { ok: true, lines: [`rembric: memories about ${path}:`], exhausted: false },
    });
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c));
      req.on('end', () => {
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        let answer: { status: number; body: unknown } | 'hang' = {
          status: 200,
          body: { ok: true, created: true },
        };
        if ((req.url ?? '').endsWith('/file-recall')) {
          requests.push(body);
          answer = respond(String(body['path']));
        }
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
    repo = mkdtempSync(join(tmpdir(), 'rembric-core-filerecall-'));
    for (const f of ['src/a.ts', 'src/b.ts', 'lib/a.ts']) {
      mkdirSync(join(repo, dirname(f)), { recursive: true });
      writeFileSync(join(repo, f), 'x');
    }
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['add', '-A'], { cwd: repo });
  });

  afterEach(() => {
    for (const r of held) r.destroy();
    server.close();
    rmSync(repo, { recursive: true, force: true });
  });

  async function protocol(sessionId = 'sess-1') {
    const core = createSessionProtocol({
      agent: 'pi',
      serverUrl: baseUrl,
      apiToken: 'tok',
      slug: 'demo',
      cwd: repo,
    });
    await core.ensureSession(sessionId);
    return core;
  }

  it('sends a tracked file once per session, repo-relative with its same-name siblings', async () => {
    const core = await protocol();
    expect(await core.fileRecall('sess-1', repo, ['./src/a.ts'])).toEqual([
      'rembric: memories about src/a.ts:',
    ]);
    expect(requests).toEqual([{ path: 'src/a.ts', siblings: ['lib/a.ts', 'src/a.ts'] }]);
    expect(await core.fileRecall('sess-1', repo, [join(repo, 'src/a.ts')])).toEqual([]);
    expect(requests).toHaveLength(1);
  });

  it('omits the siblings past 64 same-name files', async () => {
    for (let i = 0; i < 65; i++) {
      mkdirSync(join(repo, `many/d${i}`), { recursive: true });
      writeFileSync(join(repo, `many/d${i}/same.md`), 'x');
    }
    execFileSync('git', ['add', '-A'], { cwd: repo });
    const core = await protocol();
    await core.fileRecall('sess-1', repo, ['many/d0/same.md']);
    expect(requests).toEqual([{ path: 'many/d0/same.md' }]);
  });

  it('sends a file once even when two calls race for it', async () => {
    const core = await protocol();
    await Promise.all([
      core.fileRecall('sess-1', repo, ['src/b.ts']),
      core.fileRecall('sess-1', repo, ['src/b.ts']),
      core.fileRecall('sess-1', repo, ['src/b.ts']),
    ]);
    expect(requests).toHaveLength(1);
  });

  it('never lets a directory, glob or bracketed name stand in for another file', async () => {
    mkdirSync(join(repo, 'app', '[ID]'), { recursive: true });
    mkdirSync(join(repo, 'app', 'I'), { recursive: true });
    writeFileSync(join(repo, 'app', '[ID]', 'page.ts'), 'x');
    writeFileSync(join(repo, 'app', 'I', 'page.ts'), 'x');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    const core = await protocol();
    expect(await core.fileRecall('sess-1', repo, [join(repo, 'src/'), 'src/*.ts'])).toEqual([]);
    expect(requests).toHaveLength(0);
    await core.fileRecall('sess-1', repo, ['app/[ID]/page.ts']);
    expect(requests.map((r) => r['path'])).toEqual(['app/[ID]/page.ts']);
  });

  it('sends a non-ASCII file name as itself', async () => {
    writeFileSync(join(repo, 'src', 'ünï.ts'), 'x');
    execFileSync('git', ['add', '-A'], { cwd: repo });
    const core = await protocol();
    await core.fileRecall('sess-1', repo, ['src/ünï.ts']);
    expect(requests[0]).toEqual({ path: 'src/ünï.ts', siblings: ['src/ünï.ts'] });
  });

  it('stops at the first failed request and leaves the other files for later', async () => {
    respond = () => 'hang';
    const core = await protocol();
    expect(await core.fileRecall('sess-1', repo, ['src/a.ts', 'src/b.ts', 'lib/a.ts'])).toEqual([]);
    expect(requests).toHaveLength(1);
    respond = (path) => ({ status: 200, body: { ok: true, lines: [path] } });
    await core.fileRecall('sess-1', repo, ['src/b.ts']);
    expect(requests.map((r) => r['path'])).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('never sends what the repository does not track', async () => {
    const core = await protocol();
    expect(await core.fileRecall('sess-1', repo, ['/etc/hosts', '../x.ts', 'src/none.ts'])).toEqual(
      [],
    );
    expect(requests).toHaveLength(0);
  });

  it('stops after the server says the session is exhausted', async () => {
    respond = (path) => ({ status: 200, body: { ok: true, lines: [path], exhausted: true } });
    const core = await protocol();
    await core.fileRecall('sess-1', repo, ['src/a.ts', 'src/b.ts']);
    await core.fileRecall('sess-1', repo, ['lib/a.ts']);
    expect(requests.map((r) => r['path'])).toEqual(['src/a.ts']);
  });

  it('skips sub-agent and unregistered sessions', async () => {
    const core = await protocol();
    core.markSubAgent('sess-1');
    expect(await core.fileRecall('sess-1', repo, ['src/a.ts'])).toEqual([]);
    expect(await core.fileRecall('never-ensured', repo, ['src/a.ts'])).toEqual([]);
    expect(requests).toHaveLength(0);
  });

  it('returns nothing, quickly, when the server hangs or fails', async () => {
    const core = await protocol();
    respond = () => 'hang';
    const started = Date.now();
    expect(await core.fileRecall('sess-1', repo, ['src/a.ts'])).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1500);
    respond = () => ({ status: 404, body: {} });
    expect(await core.fileRecall('sess-1', repo, ['src/b.ts'])).toEqual([]);
  });

  it('forgetSession frees the session to send the same files again', async () => {
    const core = await protocol();
    await core.fileRecall('sess-1', repo, ['src/a.ts']);
    core.forgetSession('sess-1');
    await core.ensureSession('sess-1');
    await core.fileRecall('sess-1', repo, ['src/a.ts']);
    expect(requests).toHaveLength(2);
  });
});
