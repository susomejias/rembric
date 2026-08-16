import { createServer, type IncomingMessage, type Server } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionProtocol, RESUMED_READ_NUDGE } from '../bin/rembric-plugin-core.mjs';

// The resumed-process read line lives in the shared core (plugin-session-protocol),
// so this is the only place the rule can be pinned for the in-process JS/TS
// clients (Pi, opencode) at once — they contribute a transport and nothing else.

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, 'nudge-fixtures.json'), 'utf8')) as {
  resumedReadCore: string;
  resumedRead: string;
};

const SLUG = 'resumed-read-fixture';

function protocol(): ReturnType<typeof createSessionProtocol> {
  return createSessionProtocol({
    agent: 'resumed-read-fixture-agent',
    serverUrl: 'http://127.0.0.1:9',
    apiToken: 'unused-fetch-is-stubbed',
    slug: SLUG,
  });
}

function stubFetch(respond: (url: string) => Response): void {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL): Promise<Response> => respond(String(input)),
  );
}

function ensureResponse(created: boolean | undefined): Response {
  const body = created === undefined ? {} : { created };
  return new Response(JSON.stringify(body), { status: 200 });
}

function stubEnsureCreated(created: boolean | undefined): void {
  stubFetch((url) =>
    url.endsWith('/resume') ? new Response('', { status: 200 }) : ensureResponse(created),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the fixture text is the rembric:-prefixed shared core, and TS matches it', () => {
  it('resumedRead is rembric: + resumedReadCore', () => {
    expect(fixtures.resumedRead).toBe(`rembric: ${fixtures.resumedReadCore}`);
  });

  it('RESUMED_READ_NUDGE matches the fixture exactly', () => {
    expect(RESUMED_READ_NUDGE).toBe(fixtures.resumedRead);
  });
});

describe('the resumed-process read line', () => {
  it("is emitted once, on the session's first turn, when the FIRST ensure reported created:false", async () => {
    stubEnsureCreated(false);
    const core = protocol();
    await core.ensureSession('s-resumed');

    const turn1 = core.nudgesForTurn('s-resumed', 'anything');
    expect(turn1).toContain(RESUMED_READ_NUDGE);
    // Control: it really did fire, so the next assertion is not measured
    // against an empty set.
    expect(turn1.filter((l) => l === RESUMED_READ_NUDGE)).toHaveLength(1);

    const turn2 = core.nudgesForTurn('s-resumed', 'anything');
    expect(turn2).not.toContain(RESUMED_READ_NUDGE);
  });

  it('is never emitted when the FIRST ensure reported created:true', async () => {
    stubEnsureCreated(true);
    const core = protocol();
    await core.ensureSession('s-fresh');

    const turn1 = core.nudgesForTurn('s-fresh', 'anything');
    expect(turn1).not.toContain(RESUMED_READ_NUDGE);
  });

  it('is never emitted when the FIRST ensure failed (unknown is do-not-advise, not advise-anyway)', async () => {
    stubFetch(() => new Response('refused', { status: 500 }));
    const core = protocol();
    await core.ensureSession('s-ensure-down');

    const turn1 = core.nudgesForTurn('s-ensure-down', 'anything');
    expect(turn1).not.toContain(RESUMED_READ_NUDGE);
  });

  it('is never emitted when the ensure response carries no `created` field', async () => {
    stubEnsureCreated(undefined);
    const core = protocol();
    await core.ensureSession('s-no-field');

    const turn1 = core.nudgesForTurn('s-no-field', 'anything');
    expect(turn1).not.toContain(RESUMED_READ_NUDGE);
  });

  it('does not consult a second ensure for a second session in the same process — the process-wide latch is read once', async () => {
    stubEnsureCreated(false);
    const core = protocol();
    await core.ensureSession('s-first');
    // A LATER ensure in the SAME process reports an unclear outcome (no
    // `created` field); the process-wide latch from the FIRST ensure still
    // governs the resumedRead line for every session. (Its own per-session
    // `created` outcome is `null`, so the OPENING line — which IS tracked
    // per-session — does not fire and mask this one.)
    stubEnsureCreated(undefined);
    await core.ensureSession('s-second');

    expect(core.nudgesForTurn('s-second', 'anything')).toContain(RESUMED_READ_NUDGE);
  });

  it('is emitted as its own line, ahead of a cached server notice, never merged into it', async () => {
    stubEnsureCreated(false);
    const core = protocol();
    await core.ensureSession('s-sibling');
    // Force a notice into the cache by stubbing reportTurn's response.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/turn')) {
        return new Response(JSON.stringify({ ok: true, lines: ['rembric: a server notice'] }), {
          status: 200,
        });
      }
      return new Response('', { status: 200 });
    });
    await core.reportTurn('s-sibling', { usedTools: true });

    const turn1 = core.nudgesForTurn('s-sibling', 'anything');
    const resumedIndex = turn1.indexOf(RESUMED_READ_NUDGE);
    const noticeIndex = turn1.indexOf('rembric: a server notice');
    expect(resumedIndex).toBeGreaterThanOrEqual(0);
    expect(noticeIndex).toBeGreaterThan(resumedIndex);
  });

  it('never reads the response body of a /summary POST', async () => {
    stubEnsureCreated(false);
    const core = protocol();
    await core.ensureSession('s-summary-body');
    core.appendUserMessage('s-summary-body', 'did some work');

    let bodyReadAttempted = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/summary')) {
        return new Proxy(new Response('{"ok":true,"summary":"stored"}', { status: 200 }), {
          get(target, prop, receiver) {
            if (prop === 'json' || prop === 'text') bodyReadAttempted = true;
            return Reflect.get(target, prop, receiver);
          },
        });
      }
      return new Response('', { status: 200 });
    });

    await core.flushSessionSummary('s-summary-body');
    expect(bodyReadAttempted).toBe(false);
  });

  it("a /summary response's body never influences the resumed-process state, even if it contained `created`", async () => {
    // Fresh session (created:true) — the read line must never fire.
    stubEnsureCreated(true);
    const core = protocol();
    await core.ensureSession('s-poison');

    // A /summary response that ALSO happens to carry `created: false` must
    // not be consulted: the contract forbids reading a *summary* response
    // to learn summary (or resume) state at all.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith('/summary')) {
        return new Response(JSON.stringify({ ok: true, created: false }), { status: 200 });
      }
      return new Response('', { status: 200 });
    });
    core.appendUserMessage('s-poison', 'did some work');
    await core.flushSessionSummary('s-poison');

    expect(core.nudgesForTurn('s-poison', 'anything')).not.toContain(RESUMED_READ_NUDGE);
  });
});

const execFileAsync = promisify(execFile);
const scripts = join(here, '..', 'scripts');

type CapturedRequest = { method: string; path: string; body: string };

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

describe('the resumed-process read line (bash: session-start.sh + prompt-nudge.sh)', () => {
  let server: Server;
  let serverUrl: string;
  let requests: CapturedRequest[];
  let root: string;
  let tmpdirEnv: string;
  let cwd: string;
  /** What the stub server answers `/sessions` with, per test. */
  let ensureBody: string;

  beforeEach(async () => {
    requests = [];
    ensureBody = '{"ok":true}';
    root = mkdtempSync(join(tmpdir(), 'rembric-resumedread-'));
    // TMPDIR (the marker root) and the session's cwd (where `.rembric`
    // resolves the slug) are DIFFERENT directories under `root` — the
    // marker mechanism must not depend on them coinciding.
    tmpdirEnv = join(root, 'tmp');
    cwd = join(root, 'cwd');
    mkdirSync(tmpdirEnv, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    writeFileSync(join(cwd, '.rembric'), 'PROJECT_SLUG=demo\n');
    server = createServer((req, res) => {
      readBody(req)
        .then((body) => {
          requests.push({ method: req.method ?? '', path: req.url ?? '', body });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(req.url?.endsWith('/sessions') ? ensureBody : '{"ok":true}');
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
    rmSync(root, { recursive: true, force: true });
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function runSessionStart(sessionId: string): Promise<void> {
    const child = execFileAsync('bash', [join(scripts, 'session-start.sh'), 'claude-code'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        REMBRIC_SERVER_URL: serverUrl,
        REMBRIC_API_TOKEN: 'test-token',
        REMBRIC_POST_MAX_TIME: '30',
        TMPDIR: tmpdirEnv,
      },
    });
    child.child.stdin?.end(JSON.stringify({ session_id: sessionId, cwd, source: 'startup' }));
    await child;
  }

  function runPromptNudge(
    sessionId: string,
    env: NodeJS.ProcessEnv = { TMPDIR: tmpdirEnv },
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = execFile(
        'bash',
        [join(scripts, 'prompt-nudge.sh')],
        { encoding: 'utf8', env: { ...process.env, ...env } },
        (err, stdout) => (err ? reject(err) : resolve(stdout)),
      );
      child.stdin?.end(JSON.stringify({ session_id: sessionId }));
    });
  }

  it('emits the resumedRead line on turn 1 when the ensure reported created:false', async () => {
    ensureBody = '{"ok":true,"created":false}';
    await runSessionStart('s-resumed');
    // Control: the ensure really landed against the stub, so the assertion
    // below is not measured against a request that never happened.
    expect(requests.map((r) => r.path)).toContain('/api/demo/sessions');

    const out = await runPromptNudge('s-resumed');
    const lines = out.split('\n').filter((l) => l.length > 0);
    expect(lines).toContain(fixtures.resumedRead);
  });

  it('never emits the resumedRead line when the ensure reported created:true', async () => {
    ensureBody = '{"ok":true,"created":true}';
    await runSessionStart('s-fresh');
    const out = await runPromptNudge('s-fresh');

    expect(out).not.toContain(fixtures.resumedRead);
  });

  it('never repeats the resumedRead line on a later turn', async () => {
    ensureBody = '{"ok":true,"created":false}';
    await runSessionStart('s-once');
    await runPromptNudge('s-once');
    const out = await runPromptNudge('s-once');
    expect(out).not.toContain(fixtures.resumedRead);
  });

  it('never emits the resumedRead line when session-start.sh never ran (no marker to read)', async () => {
    const out = await runPromptNudge('s-never-started');
    expect(out).not.toContain(fixtures.resumedRead);
  });

  it('fails closed when the marker directory is unreadable', async () => {
    ensureBody = '{"ok":true,"created":false}';
    await runSessionStart('s-broken-marker');

    const otherTmp = mkdtempSync(join(tmpdir(), 'rembric-resumedread-other-'));
    try {
      // A DIFFERENT TMPDIR has no marker at all — indistinguishable from
      // "unreadable" from prompt-nudge.sh's point of view, and it must
      // still exit cleanly and emit nothing.
      const out = await runPromptNudge('s-broken-marker', { TMPDIR: otherTmp });
      expect(out).not.toContain(fixtures.resumedRead);
    } finally {
      rmSync(otherTmp, { recursive: true, force: true });
    }
  });
});
