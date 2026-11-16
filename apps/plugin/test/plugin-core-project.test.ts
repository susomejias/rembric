import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  FINGERPRINT_HEADER,
  inspectRepository,
  normalizeRemote,
  resolveProject,
  resolveSlug,
} from '../mcp-bridge/rembric-project.mjs';

// A git hook exports GIT_DIR, which would point the git calls in these tests at the real repository.
for (const key of Object.keys(process.env)) if (key.startsWith('GIT_')) delete process.env[key];

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Fixture Author',
  GIT_AUTHOR_EMAIL: 'author@example.test',
  GIT_COMMITTER_NAME: 'Fixture Committer',
  GIT_COMMITTER_EMAIL: 'committer@example.test',
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_NOSYSTEM: '1',
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env: GIT_ENV, encoding: 'utf8' }).trim();
}

function commit(cwd: string, name: string): string {
  writeFileSync(join(cwd, name), `${name}\n`);
  git(cwd, 'add', '-A');
  git(cwd, 'commit', '-q', '-m', name);
  return git(cwd, 'rev-parse', 'HEAD');
}

function newRepo(dir: string): string {
  mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q', '-b', 'main');
  return dir;
}

let scratch: string;

beforeAll(() => {
  scratch = realpathSync(mkdtempSync(join(tmpdir(), 'rembric-project-')));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

let counter = 0;
function fresh(name: string): string {
  counter += 1;
  return join(scratch, `${counter}-${name}`);
}

type Recorded = { method: string; path: string; headers: IncomingHttpHeaders; body: string };
type Reply = { status: number; body?: unknown } | 'hang';

const servers: Server[] = [];

async function startStub(resolveReply: (body: Record<string, unknown>) => Reply) {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk: Buffer) => (raw += chunk));
    req.on('end', () => {
      const path = req.url ?? '';
      requests.push({ method: req.method ?? '', path, headers: req.headers, body: raw });
      if (path === '/api/repositories/resolve') {
        const reply = resolveReply(JSON.parse(raw) as Record<string, unknown>);
        if (reply === 'hang') return;
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body ?? {}));
        return;
      }
      if (path === '/mcp' || path.startsWith('/mcp/')) {
        const message = raw ? (JSON.parse(raw) as { id?: number; method?: string }) : {};
        if (message.id === undefined) {
          res.writeHead(202);
          res.end();
          return;
        }
        const result =
          message.method === 'initialize'
            ? { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'stub' } }
            : message.method === 'tools/list'
              ? { tools: [{ name: 'project.current', inputSchema: { type: 'object' } }] }
              : { content: [{ type: 'text', text: 'ok' }] };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, created: true }));
    });
  });
  servers.push(server);
  server.listen(0, '127.0.0.1');
  await new Promise<void>((done) => server.once('listening', () => done()));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub did not bind');
  const url = `http://127.0.0.1:${address.port}`;
  return {
    url,
    requests,
    resolveCalls: () => requests.filter((r) => r.path === '/api/repositories/resolve'),
    resolveBodies: () =>
      requests
        .filter((r) => r.path === '/api/repositories/resolve')
        .map((r) => JSON.parse(r.body) as Record<string, unknown>),
  };
}

afterEach(() => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    server.close();
  }
});

const bound = (slug: string): Reply => ({
  status: 200,
  body: { ok: true, outcome: 'bound', slug },
});
const unbound = (reason = 'not_bound'): Reply => ({
  status: 200,
  body: { ok: true, outcome: 'unbound', reason },
});

describe('repository fingerprint', () => {
  it('is the own first-parent root of a repository with a merged unrelated history, from main and from a feature branch', async () => {
    const app = newRepo(fresh('app'));
    const appRoot = commit(app, 'app.txt');
    const library = newRepo(fresh('library'));
    const libraryRoot = commit(library, 'lib.txt');
    git(app, 'fetch', '-q', library, 'main:library');
    git(app, 'merge', '-q', '--allow-unrelated-histories', '--no-edit', 'library');
    expect(git(app, 'rev-list', '--max-parents=0', 'HEAD').split('\n').sort()).toEqual(
      [appRoot, libraryRoot].sort(),
    );

    expect((await inspectRepository(app)).fingerprint).toBe(appRoot);
    git(app, 'checkout', '-q', '-b', 'feature');
    commit(app, 'feature.txt');
    const fromFeature = await inspectRepository(app);
    expect(fromFeature.fingerprint).toBe(appRoot);
    expect(fromFeature.fingerprint).not.toBe(libraryRoot);
  });

  it('ignores a GIT_DIR inherited from the environment and fingerprints the working directory', async () => {
    const own = newRepo(fresh('own'));
    const ownRoot = commit(own, 'own.txt');
    const other = newRepo(fresh('other'));
    const otherRoot = commit(other, 'other.txt');
    vi.stubEnv('GIT_DIR', join(other, '.git'));
    vi.stubEnv('GIT_WORK_TREE', other);
    try {
      const fingerprint = (await inspectRepository(own)).fingerprint;
      expect(fingerprint).toBe(ownRoot);
      expect(fingerprint).not.toBe(otherRoot);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('is the orphan branch’s own root, not the main history’s', async () => {
    const repo = newRepo(fresh('orphan'));
    const mainRoot = commit(repo, 'main.txt');
    git(repo, 'checkout', '-q', '--orphan', 'other');
    const orphanRoot = commit(repo, 'orphan.txt');

    const fingerprint = (await inspectRepository(repo)).fingerprint;
    expect(fingerprint).toBe(orphanRoot);
    expect(fingerprint).not.toBe(mainRoot);
  });

  it('is absent for a shallow clone, whose root lookup would return the boundary commit', async () => {
    const source = newRepo(fresh('deep'));
    const trueRoot = commit(source, 'one.txt');
    commit(source, 'two.txt');
    const shallow = fresh('shallow');
    git(scratch, 'clone', '-q', '--depth', '1', `file://${source}`, shallow);
    const falseRoot = git(shallow, 'rev-list', '--first-parent', '--max-parents=0', 'HEAD');
    expect(falseRoot).not.toBe(trueRoot);

    const repository = await inspectRepository(shallow);
    expect(repository).toMatchObject({ insideGit: true, fingerprint: null, cause: 'shallow' });
  });

  it('is absent for a repository with no commit', async () => {
    const repo = newRepo(fresh('empty'));
    expect(await inspectRepository(repo)).toMatchObject({
      insideGit: true,
      fingerprint: null,
      cause: 'no_commit',
    });
  });

  it('reports a directory outside any work tree as outside git', async () => {
    const dir = fresh('plain');
    mkdirSync(dir);
    expect(await inspectRepository(dir)).toEqual({ insideGit: false });
  });

  it('is the same in a linked worktree and from a subdirectory as in the main checkout', async () => {
    const repo = newRepo(fresh('main-checkout'));
    const root = commit(repo, 'a.txt');
    mkdirSync(join(repo, 'packages', 'api'), { recursive: true });
    const worktree = fresh('linked');
    git(repo, 'worktree', 'add', '-q', worktree, '-b', 'feat');

    expect((await inspectRepository(worktree)).fingerprint).toBe(root);
    const fromSubdirectory = await inspectRepository(join(repo, 'packages', 'api'));
    expect(fromSubdirectory.fingerprint).toBe(root);
    expect(fromSubdirectory.root).toBe(repo);
  });
});

describe('remote normalization', () => {
  it('folds the equivalent spellings of one remote into one form', () => {
    for (const remote of [
      'git@github.com:Acme/Shop.git',
      'https://github.com/acme/shop',
      'https://github.com/acme/shop/',
      'ssh://git@github.com:22/acme/shop.git',
    ]) {
      expect(normalizeRemote(remote), remote).toBe('github.com/acme/shop');
    }
  });

  it('strips user information, password included', () => {
    expect(normalizeRemote('https://user:secret@git.example.com/acme/shop.git')).toBe(
      'git.example.com/acme/shop',
    );
    expect(normalizeRemote('user:secret@git.example.com:acme/shop.git')).toBe(
      'git.example.com/acme/shop',
    );
  });

  it('strips a password that contains a slash or an @ up to the last @ before the host', () => {
    expect(normalizeRemote('https://user:se/cr@et@host.example/acme/x.git')).toBe(
      'host.example/acme/x',
    );
    expect(normalizeRemote('user:se/cr@et@host.example:acme/x.git')).toBe('host.example/acme/x');
    expect(normalizeRemote('https://user:p?ss@host.example/acme/shop')).toBe(
      'host.example/acme/shop',
    );
    expect(normalizeRemote('https://user:pa#ss@host.example/acme/x')).toBe('host.example/acme/x');
  });

  it('keeps nested path segments and drops the query string', () => {
    expect(normalizeRemote('git@gitlab.com:Group/Sub/Proj.git')).toBe('gitlab.com/group/sub/proj');
    expect(normalizeRemote('https://host.example/a/b.git?ref=x#frag')).toBe('host.example/a/b');
  });

  it('sends no local path as a remote', () => {
    expect(normalizeRemote('/home/someone/repos/shop.git')).toBeNull();
    expect(normalizeRemote('file:///home/someone/repos/shop.git')).toBeNull();
    expect(normalizeRemote('../shop')).toBeNull();
  });
});

describe('the .rembric walk', () => {
  it('a .rembric at the checkout root scopes a subdirectory', async () => {
    const repo = newRepo(fresh('shop'));
    commit(repo, 'a.txt');
    writeFileSync(join(repo, '.rembric'), 'PROJECT_SLUG=shop\n');
    const start = join(repo, 'packages', 'api');
    mkdirSync(start, { recursive: true });
    const { root } = await inspectRepository(start);

    expect(resolveSlug(start, {}, root)).toMatchObject({ slug: 'shop', source: 'rembric-root' });
  });

  it('the nearest .rembric below the checkout root wins and is reported as nested', async () => {
    const repo = newRepo(fresh('monorepo'));
    commit(repo, 'a.txt');
    writeFileSync(join(repo, '.rembric'), 'PROJECT_SLUG=shop\n');
    mkdirSync(join(repo, 'packages', 'api', 'src'), { recursive: true });
    writeFileSync(join(repo, 'packages', 'api', '.rembric'), 'PROJECT_SLUG=api\n');
    const { root } = await inspectRepository(repo);

    expect(resolveSlug(join(repo, 'packages', 'api', 'src'), {}, root)).toMatchObject({
      slug: 'api',
      source: 'rembric-nested',
    });
  });

  it('never reads a .rembric above the checkout root', async () => {
    const parent = fresh('work');
    mkdirSync(parent);
    writeFileSync(join(parent, '.rembric'), 'PROJECT_SLUG=other\n');
    const repo = newRepo(join(parent, 'shop'));
    commit(repo, 'a.txt');
    mkdirSync(join(repo, 'src'));
    const stub = await startStub(() => unbound());

    const outcome = await resolveProject({
      startDir: join(repo, 'src'),
      env: {},
      serverUrl: stub.url,
      apiToken: 'tok',
    });
    expect(outcome.slug).toBeNull();
    expect(outcome.mode).toBe('unbound');
    expect(stub.resolveCalls()).toHaveLength(1);

    const withDefault = await resolveProject({
      startDir: join(repo, 'src'),
      env: { REMBRIC_PROJECT_SLUG: 'from-env' },
      serverUrl: stub.url,
      apiToken: 'tok',
    });
    expect(withDefault).toMatchObject({ mode: 'project', slug: 'from-env', source: 'env' });
  });

  it('outside git only the start directory is read, as before', async () => {
    const parent = fresh('home');
    mkdirSync(join(parent, 'child'), { recursive: true });
    writeFileSync(join(parent, '.rembric'), 'PROJECT_SLUG=home\n');

    const outcome = await resolveProject({ startDir: join(parent, 'child'), env: {} });
    expect(outcome).toMatchObject({ mode: 'default', slug: null, header: null });
    expect(outcome.issue).toBe(`No .rembric in ${join(parent, 'child')}`);
  });

  it('.rembric in the start directory still beats REMBRIC_PROJECT_SLUG, and the default applies without one', async () => {
    const dir = fresh('explicit');
    mkdirSync(dir);
    writeFileSync(join(dir, '.rembric'), 'PROJECT_SLUG=gamma\n');
    expect(
      (await resolveProject({ startDir: dir, env: { REMBRIC_PROJECT_SLUG: 'alpha' } })).slug,
    ).toBe('gamma');
    const empty = fresh('no-file');
    mkdirSync(empty);
    expect(
      (await resolveProject({ startDir: empty, env: { REMBRIC_PROJECT_SLUG: 'alpha' } })).slug,
    ).toBe('alpha');
  });
});

describe('resolution against the resolve endpoint', () => {
  async function boundRepo(remote?: string) {
    const repo = newRepo(fresh('checkout'));
    const root = commit(repo, 'a.txt');
    if (remote) git(repo, 'remote', 'add', 'origin', remote);
    return { repo, root };
  }

  it('a bound fingerprint selects the bound project and carries the fingerprint header', async () => {
    const { repo, root } = await boundRepo('git@github.com:Acme/Shop.git');
    const stub = await startStub(() => bound('shop'));

    const outcome = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: stub.url,
      apiToken: 'tok',
    });
    expect(outcome).toMatchObject({
      mode: 'project',
      slug: 'shop',
      source: 'fingerprint',
      header: root,
    });
    expect(stub.resolveBodies()).toEqual([
      { fingerprint: root, remotes: ['github.com/acme/shop'] },
    ]);
    expect(stub.resolveCalls()[0]!.headers.authorization).toBe('Bearer tok');
  });

  it('an unbound fingerprint enters unbound mode with a message naming the remedies', async () => {
    const { repo, root } = await boundRepo();
    const stub = await startStub(() => unbound());

    const outcome = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: stub.url,
      apiToken: 'tok',
    });
    expect(outcome).toMatchObject({
      mode: 'unbound',
      slug: null,
      reason: 'not_bound',
      header: root,
    });
    expect(outcome.message).toContain(root.slice(0, 12));
    expect(outcome.message).toContain('dashboard');
    expect(outcome.message).toContain('.rembric');
    expect(outcome.message).toContain('default project');
    expect(outcome.message).not.toContain('project.bind_repository');
  });

  it('sends the checkout root name only when the repository has no remote', async () => {
    const { repo } = await boundRepo();
    const stub = await startStub(() => unbound());
    await resolveProject({ startDir: repo, env: {}, serverUrl: stub.url, apiToken: 'tok' });
    const withRemote = await boundRepo('https://github.com/acme/tools.git');
    await resolveProject({
      startDir: withRemote.repo,
      env: {},
      serverUrl: stub.url,
      apiToken: 'tok',
    });

    const [bare, remoted] = stub.resolveBodies();
    expect(bare!.rootName).toBe(repo.split('/').pop());
    expect(remoted).not.toHaveProperty('rootName');
    expect(JSON.stringify(stub.resolveBodies())).not.toContain(scratch);
  });

  it('an explicit selection wins over the binding and reports the conflict with its source', async () => {
    const { repo, root } = await boundRepo();
    writeFileSync(join(repo, '.rembric'), 'PROJECT_SLUG=sandbox\n');
    const stub = await startStub((body) => ({
      status: 200,
      body: {
        ok: true,
        outcome: 'explicit',
        slug: (body.explicit as { slug: string }).slug,
        conflict: { boundSlugs: ['shop'] },
      },
    }));

    const outcome = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: stub.url,
      apiToken: 'tok',
    });
    expect(outcome).toMatchObject({
      mode: 'project',
      slug: 'sandbox',
      source: 'rembric-root',
      conflict: { boundSlugs: ['shop'] },
      header: root,
    });
    expect(outcome.message).toContain("'shop'");
    expect(outcome.message).toContain("'sandbox'");
    expect(outcome.message).toContain('.rembric');
    expect(stub.resolveBodies()[0]).toMatchObject({
      fingerprint: root,
      explicit: { slug: 'sandbox', source: 'rembric-root' },
    });
  });

  it('reports a nested .rembric and the environment default as their own explicit sources', async () => {
    const { repo } = await boundRepo();
    mkdirSync(join(repo, 'sub'));
    writeFileSync(join(repo, 'sub', '.rembric'), 'PROJECT_SLUG=sub\n');
    const stub = await startStub(() => ({
      status: 200,
      body: { ok: true, outcome: 'explicit', slug: 'x', conflict: null },
    }));

    await resolveProject({
      startDir: join(repo, 'sub'),
      env: {},
      serverUrl: stub.url,
      apiToken: 'tok',
    });
    await resolveProject({
      startDir: repo,
      env: { REMBRIC_PROJECT_SLUG: 'envy' },
      serverUrl: stub.url,
      apiToken: 'tok',
    });
    expect(stub.resolveBodies().map((b) => b.explicit)).toEqual([
      { slug: 'sub', source: 'rembric-nested' },
      { slug: 'envy', source: 'env' },
    ]);
  });

  it('a failed explicit report never prevents the explicit selection', async () => {
    const { repo } = await boundRepo();
    writeFileSync(join(repo, '.rembric'), 'PROJECT_SLUG=sandbox\n');
    const stub = await startStub(() => ({ status: 404, body: 'not found' }));
    expect(
      await resolveProject({ startDir: repo, env: {}, serverUrl: stub.url, apiToken: 'tok' }),
    ).toMatchObject({ mode: 'project', slug: 'sandbox', conflict: null });
  });

  it('several visible bindings refuse the connection and name the projects', async () => {
    const { repo } = await boundRepo();
    const stub = await startStub(() => ({
      status: 409,
      body: { ok: false, code: 'repository_ambiguous', slugs: ['sandbox', 'shop'] },
    }));
    const outcome = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: stub.url,
      apiToken: 'tok',
    });
    expect(outcome).toMatchObject({ mode: 'refused', slug: null, reason: 'ambiguous' });
    expect(outcome.message).toContain('sandbox, shop');
    expect(outcome.message).toContain('.rembric');
  });

  it.each([
    ['a server without the endpoint', { status: 404, body: 'Not Found' }, 'http_404'],
    ['a server error', { status: 500, body: { ok: false } }, 'http_500'],
    ['an unparseable body', { status: 200, body: '<html>' }, 'invalid_response'],
    [
      'an unknown outcome',
      { status: 200, body: { ok: true, outcome: 'maybe' } },
      'invalid_response',
    ],
  ] as const)('%s never falls back to the default project', async (_label, reply, reason) => {
    const { repo } = await boundRepo();
    const stub = await startStub(() => reply);
    const outcome = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: stub.url,
      apiToken: 'tok',
    });
    expect(outcome).toMatchObject({ mode: 'refused', slug: null, reason });
    expect(outcome.message).toContain('update the Rembric server');
    expect(outcome.message).toContain('.rembric');
  });

  it('a timeout is not treated as unbound', async () => {
    const { repo } = await boundRepo();
    const stub = await startStub(() => 'hang');
    const outcome = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: stub.url,
      apiToken: 'tok',
      timeoutMs: 200,
    });
    expect(outcome).toMatchObject({ mode: 'refused', slug: null, reason: 'timeout' });
  });

  it('a git repository without fingerprint asks the server with a null fingerprint and sends unavailable', async () => {
    const repo = newRepo(fresh('no-commit'));
    const stub = await startStub(() => unbound('no_fingerprint'));
    const outcome = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: stub.url,
      apiToken: 'tok',
    });
    expect(outcome).toMatchObject({
      mode: 'unbound',
      header: 'unavailable',
      reason: 'no_fingerprint',
    });
    expect(outcome.message).toContain('first commit');
    expect(stub.resolveBodies()).toEqual([{ fingerprint: null, remotes: [] }]);
  });

  it('a git repository without fingerprint and with an explicit selection makes no request', async () => {
    const repo = newRepo(fresh('no-commit-explicit'));
    writeFileSync(join(repo, '.rembric'), 'PROJECT_SLUG=shop\n');
    const stub = await startStub(() => bound('other'));
    const outcome = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: stub.url,
      apiToken: 'tok',
    });
    expect(outcome).toMatchObject({ mode: 'project', slug: 'shop', header: 'unavailable' });
    expect(stub.requests).toHaveLength(0);
  });

  it('outside git no request is made and no header is produced', async () => {
    const dir = fresh('outside');
    mkdirSync(dir);
    const stub = await startStub(() => bound('shop'));
    const outcome = await resolveProject({
      startDir: dir,
      env: {},
      serverUrl: stub.url,
      apiToken: 'tok',
    });
    expect(outcome).toMatchObject({ mode: 'default', slug: null, header: null });
    expect(stub.requests).toHaveLength(0);
  });

  it('inside git without credentials nothing is requested and nothing connects', async () => {
    const { repo } = await boundRepo();
    const stub = await startStub(() => bound('shop'));
    const outcome = await resolveProject({
      startDir: repo,
      env: {},
      serverUrl: stub.url,
      apiToken: '',
    });
    expect(outcome).toMatchObject({ mode: 'refused', reason: 'no_credentials' });
    expect(stub.requests).toHaveLength(0);
  });

  it('a credential in a remote URL never leaves the client', async () => {
    const { repo } = await boundRepo('https://user:secret@git.example.com/acme/shop.git');
    const stub = await startStub(() => unbound());
    await resolveProject({ startDir: repo, env: {}, serverUrl: stub.url, apiToken: 'tok' });
    expect(stub.resolveBodies()[0]!.remotes).toEqual(['git.example.com/acme/shop']);
    expect(JSON.stringify(stub.requests)).not.toContain('secret');
  });

  it('no fragment of a password holding a slash and an @ reaches the server', async () => {
    const { repo } = await boundRepo('https://user:se/cr@et@git.example.com/acme/shop.git');
    const stub = await startStub(() => unbound());
    await resolveProject({ startDir: repo, env: {}, serverUrl: stub.url, apiToken: 'tok' });
    expect(stub.resolveBodies()[0]!.remotes).toEqual(['git.example.com/acme/shop']);
    const sent = JSON.stringify(stub.requests);
    for (const fragment of ['se/cr', 'cr@et', 'user:']) expect(sent).not.toContain(fragment);
  });

  it('names the shallow clone as the cause and the remedy when the server proves support', async () => {
    const source = newRepo(fresh('deep-src'));
    commit(source, 'one.txt');
    commit(source, 'two.txt');
    const shallow = fresh('shallow-clone');
    git(scratch, 'clone', '-q', '--depth', '1', `file://${source}`, shallow);
    const stub = await startStub(() => unbound('no_fingerprint'));

    const outcome = await resolveProject({
      startDir: shallow,
      env: {},
      serverUrl: stub.url,
      apiToken: 'tok',
    });
    expect(outcome).toMatchObject({ mode: 'unbound', header: 'unavailable' });
    expect(outcome.message).toContain('shallow');
    expect(stub.resolveBodies()).toEqual([{ fingerprint: null, remotes: [] }]);
  });
});
