import { execFile, execFileSync } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { inspectRepository, normalizeRemote, resolveSlug } from '../mcp-bridge/rembric-project.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const scripts = join(here, '..', 'scripts');
const apiSh = join(scripts, '_api.sh');

type Captured = { method: string; path: string; body: string };
type Reply = { status: number; body: string; delayMs?: number } | 'hang';

const HEX40 = /^[0-9a-f]{40}$/;

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('GIT_') || key === 'REMBRIC_PROJECT_SLUG') continue;
    env[key] = value;
  }
  return env;
}

let fixtures: string;
let gitEnv: NodeJS.ProcessEnv;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' }).trim();
}

let clock = Date.parse('2020-01-01T00:00:00Z') / 1000;

function commit(cwd: string, file: string): string {
  writeFileSync(join(cwd, file), file);
  git(cwd, 'add', file);
  clock += 60;
  const date = `${clock} +0000`;
  execFileSync('git', ['commit', '-q', '-m', file], {
    cwd,
    env: { ...gitEnv, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
  });
  return git(cwd, 'rev-parse', 'HEAD');
}

function newRepo(name: string, first = 'a.txt'): { dir: string; root: string } {
  const dir = join(fixtures, name);
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  const root = commit(dir, first);
  return { dir, root };
}

let twoRoot: { dir: string; root: string; libRoot: string };
let orphan: { dir: string; mainRoot: string; orphanRoot: string };
let shallow: string;
let empty: string;
let notGit: string;
let worktree: string;
let featureWorktree: string;
let above: { parent: string; repo: string };
let creds: string;

beforeAll(() => {
  fixtures = realpathSync(mkdtempSync(join(tmpdir(), 'rembric-projres-fixtures-')));
  const gitConfig = join(fixtures, 'gitconfig');
  writeFileSync(gitConfig, '');
  gitEnv = {
    ...cleanEnv(),
    GIT_CONFIG_GLOBAL: gitConfig,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'Test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
  };

  const app = newRepo('two-root');
  const lib = newRepo('lib', 'lib.txt');
  git(app.dir, 'fetch', '-q', lib.dir, 'main:lib');
  git(app.dir, 'merge', '-q', '--allow-unrelated-histories', '-m', 'merge lib', 'lib');
  git(app.dir, 'checkout', '-q', '-b', 'feature');
  commit(app.dir, 'feature.txt');
  git(app.dir, 'checkout', '-q', 'main');
  mkdirSync(join(app.dir, 'packages', 'api', 'src'), { recursive: true });
  twoRoot = { dir: app.dir, root: app.root, libRoot: lib.root };

  const o = newRepo('orphan', 'orphan-main.txt');
  git(o.dir, 'checkout', '-q', '--orphan', 'other');
  const orphanRoot = commit(o.dir, 'orphan.txt');
  orphan = { dir: o.dir, mainRoot: o.root, orphanRoot };

  const deep = newRepo('deep');
  commit(deep.dir, 'b.txt');
  commit(deep.dir, 'c.txt');
  shallow = join(fixtures, 'shallow');
  git(fixtures, 'clone', '-q', '--depth', '1', `file://${deep.dir}`, shallow);

  empty = join(fixtures, 'empty');
  mkdirSync(empty);
  git(empty, 'init', '-q');

  notGit = realpathSync(mkdtempSync(join(tmpdir(), 'rembric-projres-nogit-')));

  worktree = join(fixtures, 'linked-wt');
  git(twoRoot.dir, 'worktree', 'add', '-q', '-b', 'wt', worktree);
  featureWorktree = join(fixtures, 'feature-wt');
  git(twoRoot.dir, 'worktree', 'add', '-q', featureWorktree, 'feature');

  const parent = join(fixtures, 'above');
  mkdirSync(parent);
  writeFileSync(join(parent, '.rembric'), 'PROJECT_SLUG=other\n');
  const inner = newRepo('above/shop');
  mkdirSync(join(inner.dir, 'src'));
  above = { parent, repo: inner.dir };

  const c = newRepo('creds');
  git(c.dir, 'remote', 'add', 'origin', 'https://user:secret@Git.Example.com/Acme/Shop.git');
  git(c.dir, 'remote', 'add', 'upstream', 'git@github.com:Acme/Shop.git');
  git(c.dir, 'remote', 'add', 'mirror', 'ssh://git@github.com:22/acme/shop.git');
  git(c.dir, 'remote', 'add', 'slashed', 'https://user:se/cr@et@Host.Example/x');
  creds = c.dir;
});

afterAll(() => {
  rmSync(fixtures, { recursive: true, force: true });
  rmSync(notGit, { recursive: true, force: true });
});

let server: Server;
let serverUrl: string;
let requests: Captured[];
let resolveReply: Reply;
let replyQueue: Reply[];
let held: ServerResponse[];
let tmp: string;

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

beforeEach(async () => {
  requests = [];
  held = [];
  resolveReply = { status: 200, body: '{"ok":true,"outcome":"unbound","reason":"not_bound"}' };
  replyQueue = [];
  tmp = mkdtempSync(join(tmpdir(), 'rembric-projres-tmp-'));
  server = createServer((req, res) => {
    void readBody(req).then((body) => {
      requests.push({ method: req.method ?? '', path: req.url ?? '', body });
      if (req.url === '/api/repositories/resolve') {
        const reply = replyQueue.shift() ?? resolveReply;
        if (reply === 'hang') {
          held.push(res);
          return;
        }
        setTimeout(() => {
          res.writeHead(reply.status, { 'Content-Type': 'application/json' });
          res.end(reply.body);
        }, reply.delayMs ?? 0);
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  serverUrl = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  for (const res of held) res.destroy();
  rmSync(tmp, { recursive: true, force: true });
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

type Run = { stdout: string; stderr: string; code: number };

function runHook(
  script: string,
  stdin: Record<string, unknown>,
  env: NodeJS.ProcessEnv = {},
  args: string[] = ['claude-code'],
): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(
      'bash',
      [join(scripts, script), ...args],
      {
        encoding: 'utf8',
        env: {
          ...cleanEnv(),
          REMBRIC_SERVER_URL: serverUrl,
          REMBRIC_API_TOKEN: 'test-token',
          REMBRIC_POST_MAX_TIME: '5',
          TMPDIR: tmp,
          HOME: tmp,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        const code = error && typeof error.code === 'number' ? error.code : 0;
        resolve({ stdout, stderr, code });
      },
    );
    child.stdin?.end(JSON.stringify(stdin));
  });
}

const start = (cwd: string, env: NodeJS.ProcessEnv = {}, session = 'sess-1') =>
  runHook('session-start.sh', { session_id: session, cwd, source: 'startup' }, env);

const resolveRequests = () => requests.filter((r) => r.path === '/api/repositories/resolve');
const slugRequests = () =>
  requests.filter((r) => r.path.startsWith('/api/') && r.path !== '/api/repositories/resolve');
const resolveBody = (i = 0) =>
  JSON.parse(resolveRequests()[i]!.body) as {
    fingerprint: string | null;
    remotes: string[];
    rootName?: string;
    explicit?: { slug: string; source: string };
  };
const cacheFile = (session = 'sess-1') => join(tmp, 'rembric-project', session);

const bound = (slug: string): Reply => ({
  status: 200,
  body: JSON.stringify({ ok: true, outcome: 'bound', slug }),
});
const explicit = (slug: string, boundSlugs: string[] | null): Reply => ({
  status: 200,
  body: JSON.stringify({
    ok: true,
    outcome: 'explicit',
    slug,
    conflict: boundSlugs ? { boundSlugs } : null,
  }),
});

describe('fingerprint: the first-parent root commit of the checked-out history', () => {
  it('a two-root repository fingerprints by its own history from main and from a feature branch', async () => {
    await start(twoRoot.dir, {}, 'main-branch');
    await start(featureWorktree, {}, 'feature-branch');

    expect(resolveRequests()).toHaveLength(2);
    expect(resolveBody(0).fingerprint).toBe(twoRoot.root);
    expect(resolveBody(1).fingerprint).toBe(twoRoot.root);
    expect(resolveBody(0).fingerprint).not.toBe(twoRoot.libRoot);
    expect(twoRoot.root).toMatch(HEX40);
    expect(git(twoRoot.dir, 'rev-list', '--max-parents=0', 'HEAD').split('\n')[0]).toBe(
      twoRoot.libRoot,
    );
  });

  it('an orphan branch is a different repository identity', async () => {
    await start(orphan.dir);
    expect(resolveBody().fingerprint).toBe(orphan.orphanRoot);
    expect(resolveBody().fingerprint).not.toBe(orphan.mainRoot);
  });

  it('a linked worktree and a subdirectory share the main checkout fingerprint', async () => {
    await start(worktree, {}, 'wt');
    await start(join(twoRoot.dir, 'packages', 'api', 'src'), {}, 'sub');
    expect(resolveBody(0).fingerprint).toBe(twoRoot.root);
    expect(resolveBody(1).fingerprint).toBe(twoRoot.root);
  });

  it('a shallow clone sends no fingerprint, calls nothing and names the cause', async () => {
    expect(git(shallow, 'rev-parse', '--is-shallow-repository')).toBe('true');
    const out = await start(shallow);
    expect(requests).toEqual([]);
    expect(out.stdout).toContain('shallow clone');
    expect(out.stdout).toContain('.rembric');
    expect(readFileSync(cacheFile(), 'utf8')).toContain('outcome=nofp');
  });

  it('a repository with no commits has no fingerprint and calls nothing', async () => {
    const out = await start(empty);
    expect(requests).toEqual([]);
    expect(out.stdout).toContain('no commit yet');
    expect(out.stdout).toContain('.rembric');
  });
});

describe('remote normalization and credential stripping', () => {
  it('sends every remote normalized, with the credentials removed, plus the root name', async () => {
    await start(creds);
    const body = resolveBody();
    expect([...body.remotes].sort()).toEqual([
      'git.example.com/acme/shop',
      'github.com/acme/shop',
      'host.example/x',
    ]);
    expect(body.rootName).toBe('creds');
    for (const fragment of ['secret', 'user', 'se/cr', 'cr@et', 'et@']) {
      expect(requests.some((r) => r.body.includes(fragment))).toBe(false);
    }
  });

  it('a repository without remotes sends an empty list and its basename', async () => {
    await start(twoRoot.dir);
    expect(resolveBody().remotes).toEqual([]);
    expect(resolveBody().rootName).toBe(basename(twoRoot.dir));
  });

  it.each([
    ['git@github.com:Acme/Shop.git', 'github.com/acme/shop'],
    ['https://github.com/acme/shop/', 'github.com/acme/shop'],
    ['ssh://git@github.com:22/acme/shop.git', 'github.com/acme/shop'],
    ['https://user:secret@git.example.com/acme/shop.git', 'git.example.com/acme/shop'],
    ['https://gitlab.com/group/sub/repo.git?ref=x', 'gitlab.com/group/sub/repo'],
    ['github.com:acme/shop.git/', 'github.com/acme/shop'],
    ['https://user:se/cr@et@host/x', 'host/x'],
    ['https://user:p?ss@host/acme/shop', 'host/acme/shop'],
  ])('rembric_normalize_remote %s → %s', (input, expected) => {
    const out = execFileSync(
      'bash',
      ['-c', `source '${apiSh}'; rembric_normalize_remote "$1"`, '_', input],
      { encoding: 'utf8' },
    );
    expect(out).toBe(expected);
  });
});

describe('the cascade: nearest .rembric up to the checkout root, then REMBRIC_PROJECT_SLUG, then the fingerprint', () => {
  it('a root .rembric scopes a subdirectory and is reported as rembric-root', async () => {
    writeFileSync(join(twoRoot.dir, '.rembric'), 'PROJECT_SLUG=shop\n');
    try {
      resolveReply = explicit('shop', null);
      await start(join(twoRoot.dir, 'packages', 'api'));
      expect(resolveBody().explicit).toEqual({ slug: 'shop', source: 'rembric-root' });
      expect(slugRequests().map((r) => r.path)).toEqual([
        '/api/shop/sessions',
        '/api/shop/sessions/sess-1/resume',
      ]);
    } finally {
      rmSync(join(twoRoot.dir, '.rembric'));
    }
  });

  it('the nearest .rembric wins and is reported as rembric-nested', async () => {
    writeFileSync(join(twoRoot.dir, '.rembric'), 'PROJECT_SLUG=shop\n');
    writeFileSync(join(twoRoot.dir, 'packages', 'api', '.rembric'), 'PROJECT_SLUG=api\n');
    try {
      resolveReply = explicit('api', null);
      await start(join(twoRoot.dir, 'packages', 'api', 'src'));
      expect(resolveBody().explicit).toEqual({ slug: 'api', source: 'rembric-nested' });
      expect(slugRequests()[0]!.path).toBe('/api/api/sessions');
    } finally {
      rmSync(join(twoRoot.dir, '.rembric'));
      rmSync(join(twoRoot.dir, 'packages', 'api', '.rembric'));
    }
  });

  it('the walk stops at the checkout root: a .rembric above it is never read', async () => {
    resolveReply = bound('shop');
    await start(join(above.repo, 'src'));
    expect(resolveBody().explicit).toBeUndefined();
    expect(slugRequests().map((r) => r.path)).toEqual([
      '/api/shop/sessions',
      '/api/shop/sessions/sess-1/resume',
    ]);
    expect(requests.some((r) => r.path.startsWith('/api/other/'))).toBe(false);
  });

  it('rembric_read_project_slug walks up inside git and stops at the checkout root', () => {
    const call = (dir: string) =>
      execFileSync('bash', ['-c', `source '${apiSh}'; rembric_read_project_slug "$1"`, '_', dir], {
        encoding: 'utf8',
        env: cleanEnv(),
      });
    writeFileSync(join(twoRoot.dir, '.rembric'), 'PROJECT_SLUG=shop\n');
    try {
      expect(call(join(twoRoot.dir, 'packages', 'api', 'src'))).toBe('shop');
    } finally {
      rmSync(join(twoRoot.dir, '.rembric'));
    }
    expect(call(join(above.repo, 'src'))).toBe('');
  });

  it('REMBRIC_PROJECT_SLUG selects the project inside git and is reported as env', async () => {
    resolveReply = explicit('from-env', null);
    await start(twoRoot.dir, { REMBRIC_PROJECT_SLUG: 'from-env' });
    expect(resolveBody().explicit).toEqual({ slug: 'from-env', source: 'env' });
    expect(slugRequests()[0]!.path).toBe('/api/from-env/sessions');
  });

  it('an invalid REMBRIC_PROJECT_SLUG is discarded and the cascade continues to the fingerprint', async () => {
    resolveReply = bound('shop');
    await start(twoRoot.dir, { REMBRIC_PROJECT_SLUG: 'Not_Valid' });
    expect(resolveBody().explicit).toBeUndefined();
    expect(slugRequests()[0]!.path).toBe('/api/shop/sessions');
  });
});

describe('outcomes of POST /api/repositories/resolve', () => {
  it('a bound fingerprint registers the session under the bound slug', async () => {
    resolveReply = bound('shop');
    const out = await start(twoRoot.dir);
    expect(slugRequests().map((r) => r.path)).toEqual([
      '/api/shop/sessions',
      '/api/shop/sessions/sess-1/resume',
    ]);
    expect(out.stdout).toContain('rembric: If this is a continuation');
    expect(out.stdout).not.toContain('not bound');
  });

  it('control: a session with a project keeps printing the plain-text nudge, not JSON', async () => {
    resolveReply = bound('shop');
    const out = await start(twoRoot.dir);
    expect(out.stdout).toBe(
      'rembric: If this is a continuation of recent work, call memory.context before responding.\n',
    );
  });

  it('shows the unbound notice to the user and asks the model to relay it in its first reply', async () => {
    const out = await start(twoRoot.dir);
    const json = JSON.parse(out.stdout) as {
      systemMessage: string;
      hookSpecificOutput: { hookEventName: string; additionalContext: string };
    };
    expect(json.systemMessage).toContain('not bound');
    expect(json.systemMessage).toContain(twoRoot.root.slice(0, 12));
    expect(json.hookSpecificOutput.hookEventName).toBe('SessionStart');
    expect(json.hookSpecificOutput.additionalContext).toContain(json.systemMessage);
    expect(json.hookSpecificOutput.additionalContext).toContain(
      'Tell the user about this in your first reply',
    );
    expect(Object.keys(json).sort()).toEqual(['hookSpecificOutput', 'systemMessage']);
    expect(out.code).toBe(0);
  });

  it('an unbound repository registers nothing and says how to bind it, without the admin-only tool', async () => {
    const out = await start(twoRoot.dir);
    expect(resolveRequests()).toHaveLength(1);
    expect(slugRequests()).toEqual([]);
    expect(out.stdout).toContain('not bound');
    expect(out.stdout).toContain(twoRoot.root.slice(0, 12));
    expect(out.stdout).not.toContain(twoRoot.root.slice(0, 13));
    expect(out.stdout).toContain('default project');
    expect(out.stdout).toContain('a repository without a .rembric file used the default project');
    expect(out.stdout).toContain('the project its earlier sessions used');
    expect(out.stdout).not.toContain('Sessions in this repository used the default project');
    expect(out.stdout).toContain('next session');
    expect(out.stdout).toContain('dashboard');
    expect(out.stdout).toContain('.rembric');
    expect(out.stdout).not.toContain('project.bind_repository');
    expect(out.code).toBe(0);
  });

  it('an unknown remote is held back like an unbound repository and says why', async () => {
    resolveReply = {
      status: 200,
      body: '{"ok":true,"outcome":"unbound","reason":"unknown_remote"}',
    };
    const out = await start(creds);
    expect(slugRequests()).toEqual([]);
    expect(out.stdout).toContain('remote');
    expect(out.stdout).toContain('not bound');
  });

  it('an ambiguous fingerprint registers nothing and names the visible projects', async () => {
    resolveReply = {
      status: 409,
      body: '{"ok":false,"code":"repository_ambiguous","slugs":["sandbox","shop"]}',
    };
    const out = await start(twoRoot.dir);
    expect(slugRequests()).toEqual([]);
    expect(out.stdout).toContain('sandbox');
    expect(out.stdout).toContain('shop');
    expect(out.stdout).toContain('.rembric');
  });

  it('an explicit selection that conflicts with a binding wins and names both projects and the source', async () => {
    writeFileSync(join(twoRoot.dir, '.rembric'), 'PROJECT_SLUG=sandbox\n');
    try {
      resolveReply = explicit('sandbox', ['shop']);
      const out = await start(twoRoot.dir);
      expect(slugRequests()[0]!.path).toBe('/api/sandbox/sessions');
      expect(out.stdout).toContain('sandbox');
      expect(out.stdout).toContain('shop');
      expect(out.stdout).toContain('.rembric');
      const json = JSON.parse(out.stdout) as {
        systemMessage: string;
        hookSpecificOutput: { additionalContext: string };
      };
      expect(json.systemMessage).toContain('bound to shop');
      expect(json.hookSpecificOutput.additionalContext).toContain(
        'rembric: If this is a continuation of recent work',
      );
    } finally {
      rmSync(join(twoRoot.dir, '.rembric'));
    }
  });

  it('an explicit selection still works when the server lacks the endpoint', async () => {
    resolveReply = { status: 404, body: 'Not Found' };
    const out = await start(twoRoot.dir, { REMBRIC_PROJECT_SLUG: 'from-env' });
    expect(slugRequests()[0]!.path).toBe('/api/from-env/sessions');
    expect(out.stderr).toBe('');
  });

  it('a server without the endpoint (404) gets no request under any slug and a diagnostic', async () => {
    resolveReply = { status: 404, body: 'Not Found' };
    const out = await start(twoRoot.dir);
    expect(slugRequests()).toEqual([]);
    expect(out.stderr).toContain('/api/repositories/resolve');
    expect(out.stderr).toContain('.rembric');
    expect(out.stdout).toContain('Update the Rembric server');
    expect(out.code).toBe(0);
  });

  it('an unparseable 200 is not treated as unbound', async () => {
    resolveReply = { status: 200, body: '{"ok":true}' };
    const out = await start(twoRoot.dir);
    expect(slugRequests()).toEqual([]);
    expect(out.stdout).not.toContain('not bound');
    expect(readFileSync(cacheFile(), 'utf8')).toContain('outcome=error');
  });

  it.each([
    ['a 200 whose ok is not true', 200, '{"ok":false,"outcome":"unbound","reason":"not_bound"}'],
    [
      'a 500 that carries an unbound body',
      500,
      '{"ok":true,"outcome":"unbound","reason":"not_bound"}',
    ],
  ])('%s is not treated as unbound', async (_label, status, body) => {
    resolveReply = { status, body };
    const out = await start(twoRoot.dir);
    expect(slugRequests()).toEqual([]);
    expect(out.stdout).not.toContain('not bound');
    expect(readFileSync(cacheFile(), 'utf8')).toContain('outcome=error');
  });

  it('a timeout is not treated as unbound and is not retried by the next hook', async () => {
    resolveReply = 'hang';
    const out = await start(twoRoot.dir, { REMBRIC_POST_MAX_TIME: '1' });
    expect(slugRequests()).toEqual([]);
    expect(out.stdout).not.toContain('not bound');
    resolveReply = bound('shop');
    await runHook('stop-report.sh', {
      session_id: 'sess-1',
      cwd: twoRoot.dir,
      stop_hook_active: false,
    });
    expect(resolveRequests()).toHaveLength(1);
    expect(slugRequests()).toEqual([]);
  });
});

describe('once per session: the first outcome is cached and reused', () => {
  it('writes the cache once and a later hook reuses it without calling resolve', async () => {
    resolveReply = bound('shop');
    await start(twoRoot.dir);
    const cached = readFileSync(cacheFile(), 'utf8');
    expect(cached).toContain('outcome=slug');
    expect(cached).toContain('slug=shop');

    resolveReply = bound('store');
    await start(twoRoot.dir);
    await runHook('stop-report.sh', {
      session_id: 'sess-1',
      cwd: twoRoot.dir,
      stop_hook_active: false,
    });

    expect(resolveRequests()).toHaveLength(1);
    expect(readFileSync(cacheFile(), 'utf8')).toBe(cached);
    expect(slugRequests().some((r) => r.path === '/api/shop/sessions/sess-1/turn')).toBe(true);
    expect(requests.some((r) => r.path.startsWith('/api/store/'))).toBe(false);
  });

  it('a first resolution from another hook wins over a later session-start', async () => {
    resolveReply = bound('shop');
    await runHook('stop-report.sh', {
      session_id: 'sess-1',
      cwd: twoRoot.dir,
      stop_hook_active: false,
    });
    resolveReply = bound('store');
    await start(twoRoot.dir);
    expect(resolveRequests()).toHaveLength(1);
    expect(requests.some((r) => r.path.startsWith('/api/store/'))).toBe(false);
  });

  it('two hooks resolving at once agree on the outcome that reached the cache first', async () => {
    replyQueue = [
      { ...(bound('shop') as { status: number; body: string }), delayMs: 500 },
      bound('store'),
    ];
    const session = { session_id: 'sess-1', cwd: twoRoot.dir };
    const first = runHook('stop-report.sh', { ...session, stop_hook_active: false });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await Promise.all([first, start(twoRoot.dir)]);

    expect(resolveRequests()).toHaveLength(2);
    expect(readFileSync(cacheFile(), 'utf8')).toContain('slug=store');
    expect(requests.some((r) => r.path.startsWith('/api/shop/'))).toBe(false);
    expect(requests.some((r) => r.path === '/api/store/sessions/sess-1/turn')).toBe(true);
  });

  it('an unbound session posts nothing from any hook', async () => {
    await start(twoRoot.dir);
    const session = { session_id: 'sess-1', cwd: twoRoot.dir };
    await runHook('prompt-search.sh', { ...session, prompt: 'fix src/a.ts' });
    await runHook('prompt-nudge.sh', { ...session, prompt: 'fix src/a.ts' });
    await runHook('prompt-hints.sh', { ...session, prompt: 'fix src/a.ts' });
    await runHook('file-recall.sh', {
      ...session,
      tool_name: 'Read',
      tool_input: { file_path: join(twoRoot.dir, 'a.txt') },
    });
    await runHook('stop-report.sh', { ...session, stop_hook_active: false });
    await runHook('pre-compact.sh', session);
    await runHook('post-compaction.sh', { ...session, compaction_summary: 'summary' });
    await runHook('post-compact.sh', session);
    await runHook('subagent-report.sh', {
      ...session,
      hook_event_name: 'SubagentStop',
      agent_type: 'Explore',
      last_assistant_message: 'done\n## Key Learnings\n1. something useful here',
    });
    await runHook('session-end.sh', session);

    expect(resolveRequests()).toHaveLength(1);
    expect(slugRequests()).toEqual([]);
  });

  it('without server credentials nothing is resolved and nothing is cached', async () => {
    const out = await start(twoRoot.dir, { REMBRIC_SERVER_URL: '', REMBRIC_API_TOKEN: '' });
    expect(requests).toEqual([]);
    expect(existsSync(cacheFile())).toBe(false);
    expect(out.code).toBe(0);
  });
});

describe('regression pins: outside git nothing changes', () => {
  it('no .rembric and no env: no request at all, no resolve, only the continuation nudge', async () => {
    const out = await start(notGit);
    expect(requests).toEqual([]);
    expect(out.stdout).toBe(
      'rembric: If this is a continuation of recent work, call memory.context before responding.\n',
    );
    expect(out.stderr).toBe('');
  });

  it('an inherited GIT_DIR does not make a directory outside git look like a repository', async () => {
    const out = await start(notGit, { GIT_DIR: join(twoRoot.dir, '.git') });
    expect(requests).toEqual([]);
    expect(out.stdout).toBe(
      'rembric: If this is a continuation of recent work, call memory.context before responding.\n',
    );
  });

  it('a .rembric in cwd still selects its slug and never calls resolve', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rembric-projres-plain-'));
    try {
      writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=demo\n');
      await start(dir);
      expect(requests.map((r) => r.path)).toEqual([
        '/api/demo/sessions',
        '/api/demo/sessions/sess-1/resume',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('outside git only the start directory is checked, never a parent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rembric-projres-parent-'));
    try {
      writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=demo\n');
      mkdirSync(join(dir, 'child'));
      await start(join(dir, 'child'));
      expect(requests).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REMBRIC_PROJECT_SLUG selects the slug when there is no .rembric, without calling resolve', async () => {
    await start(notGit, { REMBRIC_PROJECT_SLUG: 'from-env' });
    expect(requests.map((r) => r.path)).toEqual([
      '/api/from-env/sessions',
      '/api/from-env/sessions/sess-1/resume',
    ]);
  });
});

describe('git unavailable', () => {
  let noGitBin: string;

  beforeAll(() => {
    noGitBin = join(fixtures, 'no-git-bin');
    mkdirSync(noGitBin);
    const seen = new Set<string>(['git']);
    for (const dir of (process.env.PATH ?? '').split(':')) {
      if (!dir || !existsSync(dir)) continue;
      for (const name of readdirSync(dir)) {
        if (seen.has(name)) continue;
        seen.add(name);
        symlinkSync(join(dir, name), join(noGitBin, name));
      }
    }
  });

  it('a checkout whose git cannot run has no fingerprint, calls nothing and names the cause', async () => {
    const out = await start(twoRoot.dir, { PATH: noGitBin });
    expect(requests).toEqual([]);
    expect(out.stdout).toContain('git could not read this repository');
    expect(readFileSync(cacheFile(), 'utf8')).toContain('cause=git_unavailable');
  });

  it('outside git, a missing git changes nothing', async () => {
    const out = await start(notGit, { PATH: noGitBin });
    expect(requests).toEqual([]);
    expect(out.stdout).toBe(
      'rembric: If this is a continuation of recent work, call memory.context before responding.\n',
    );
  });
});

describe('parity with the shared JavaScript resolver (rembric-project.mjs)', () => {
  function bashView(dir: string, env: NodeJS.ProcessEnv = {}) {
    const script = [
      `source '${apiSh}'`,
      'info="$(_rembric_git_info "$1")"',
      'top="${info%%$\'\\n\'*}"',
      'printf "top=%s\\n" "$top"',
      'if [ -n "$top" ]; then printf "fp=%s\\n" "$(_rembric_fingerprint "$1" "${info#*$\'\\n\'}")"; printf "remotes=%s\\n" "$(_rembric_remotes_json "$top")"; fi',
      'printf "explicit=%s\\n" "$(_rembric_explicit_selection "$1" "$top")"',
    ].join('\n');
    const out = execFileSync('bash', ['-c', script, '_', dir], {
      encoding: 'utf8',
      env: { ...cleanEnv(), ...env },
    });
    const field = (key: string) => out.match(new RegExp(`^${key}=(.*)$`, 'm'))?.[1] ?? '';
    const fp = field('fp');
    const explicitSel = field('explicit');
    return {
      insideGit: field('top') !== '',
      fingerprint: fp.startsWith('fp ') ? fp.slice(3) : null,
      cause: fp.startsWith('nofp ') ? fp.slice(5) : null,
      remotes: field('remotes') ? (JSON.parse(`[${field('remotes')}]`) as string[]) : [],
      slug: explicitSel ? explicitSel.split(' ')[0] : null,
      source: explicitSel ? explicitSel.split(' ')[1] : null,
    };
  }

  async function jsView(dir: string, env: NodeJS.ProcessEnv = {}) {
    const repo = (await inspectRepository(dir)) as {
      insideGit: boolean;
      root?: string;
      fingerprint?: string | null;
      cause?: string | null;
      remotes?: string[];
    };
    const selected = resolveSlug(dir, env, repo.insideGit ? repo.root : null) as {
      slug: string | null;
      source: string | null;
    };
    return {
      insideGit: repo.insideGit,
      fingerprint: repo.insideGit ? (repo.fingerprint ?? null) : null,
      cause: repo.insideGit && !repo.fingerprint ? (repo.cause ?? null) : null,
      remotes: repo.insideGit && repo.fingerprint ? (repo.remotes ?? []) : [],
      slug: selected.slug,
      source: selected.source,
    };
  }

  const hermesTests = join(apiSh, '..', '..', '.hermes-plugin', 'tests');

  function pythonView(dir: string, env: NodeJS.ProcessEnv = {}) {
    const program = [
      'import json, sys',
      'sys.path.insert(0, sys.argv[1])',
      'from _loader import fresh_plugin',
      'p = fresh_plugin()',
      'cwd, profile = sys.argv[2], (sys.argv[3] or None)',
      'inside, root = p._git_work_tree(cwd)',
      'fp, cause = p._repository_fingerprint(cwd) if inside else (None, None)',
      'slug, source = p._explicit_selection(cwd, profile, inside, root)',
      'remotes = p._repository_remotes(cwd) if inside and fp else []',
      'print(json.dumps({"insideGit": inside, "fingerprint": fp, "cause": cause, "remotes": remotes, "slug": slug, "source": source}))',
    ].join('\n');
    const out = execFileSync(
      'python3',
      ['-B', '-c', program, hermesTests, dir, env['REMBRIC_PROJECT_SLUG'] ?? ''],
      { encoding: 'utf8', env: cleanEnv() },
    );
    return JSON.parse(out.trim().split('\n').at(-1)!) as {
      insideGit: boolean;
      fingerprint: string | null;
      cause: string | null;
      remotes: string[];
      slug: string | null;
      source: string | null;
    };
  }

  it('every fixture repository gives the same outcome from the Hermes plugin as from rembric-project.mjs', async () => {
    writeFileSync(join(twoRoot.dir, 'packages', 'api', '.rembric'), 'PROJECT_SLUG=api\n');
    try {
      const dirs = [
        twoRoot.dir,
        featureWorktree,
        worktree,
        join(twoRoot.dir, 'packages', 'api', 'src'),
        orphan.dir,
        shallow,
        empty,
        notGit,
        join(above.repo, 'src'),
        creds,
      ];
      for (const dir of dirs) {
        const js = await jsView(dir);
        const py = pythonView(dir);
        expect({ dir, ...py, remotes: [...py.remotes].sort() }).toEqual({
          dir,
          ...js,
          remotes: [...js.remotes].sort(),
        });
      }
      const envSel = { REMBRIC_PROJECT_SLUG: 'from-env' };
      expect(pythonView(twoRoot.dir, envSel)).toEqual(await jsView(twoRoot.dir, envSel));
    } finally {
      rmSync(join(twoRoot.dir, 'packages', 'api', '.rembric'));
    }
  });

  it.each([
    'git@github.com:Acme/Shop.git',
    'https://user:secret@git.example.com/acme/shop.git',
    'https://user:se/cr@et@host/x',
    'https://user:p?ss@host/acme/shop',
    'https://user:pa#ss@host/x',
    'https://gitlab.com/group/sub/repo.git?ref=x',
    'file:///srv/repo.git',
    '/srv/repo.git',
  ])('the Hermes plugin normalizes %s the same way', (input) => {
    const out = execFileSync(
      'python3',
      [
        '-B',
        '-c',
        'import sys; sys.path.insert(0, sys.argv[1]); from _loader import fresh_plugin; r = fresh_plugin()._normalize_remote(sys.argv[2]); print(r if r is not None else "")',
        hermesTests,
        input,
      ],
      { encoding: 'utf8', env: cleanEnv() },
    );
    expect(out.trim().split('\n').at(-1) || null).toBe(normalizeRemote(input));
  });

  it('every fixture repository gives the same outcome from _api.sh as from rembric-project.mjs', async () => {
    writeFileSync(join(twoRoot.dir, 'packages', 'api', '.rembric'), 'PROJECT_SLUG=api\n');
    try {
      const dirs = [
        twoRoot.dir,
        featureWorktree,
        worktree,
        join(twoRoot.dir, 'packages', 'api', 'src'),
        orphan.dir,
        shallow,
        empty,
        notGit,
        join(above.repo, 'src'),
        creds,
      ];
      for (const dir of dirs) {
        const js = await jsView(dir);
        const sh = bashView(dir);
        expect({ dir, ...sh, remotes: [...sh.remotes].sort() }).toEqual({
          dir,
          ...js,
          remotes: [...js.remotes].sort(),
        });
      }
      const envSel = { REMBRIC_PROJECT_SLUG: 'from-env' };
      expect(bashView(twoRoot.dir, envSel)).toEqual(await jsView(twoRoot.dir, envSel));
    } finally {
      rmSync(join(twoRoot.dir, 'packages', 'api', '.rembric'));
    }
  });

  it.each([
    'git@github.com:Acme/Shop.git',
    'https://github.com/acme/shop/',
    'ssh://git@github.com:22/acme/shop.git',
    'https://user:secret@git.example.com/acme/shop.git',
    'https://user:se/cr@et@host/x',
    'https://gitlab.com/group/sub/repo.git?ref=x',
    'git@host:/abs/path.git',
    'file:///srv/repo.git',
    'file://server/share/repo.git',
    'ssh:///srv/repo.git',
    '/srv/repo.git',
    '../sibling',
    'c:/repo',
  ])('normalizes %s the same way', (input) => {
    const out = execFileSync(
      'bash',
      ['-c', `source '${apiSh}'; rembric_normalize_remote "$1"`, '_', input],
      { encoding: 'utf8' },
    );
    expect(out || null).toBe(normalizeRemote(input));
  });
});
