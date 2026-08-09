import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionProtocol } from '../bin/rembric-plugin-core.mjs';

// The resume emission lives in the shared core rather than in each JS/TS
// client, so this is the only place the rule can be pinned for all of them at
// once — the clients contribute a transport and nothing else.

const SLUG = 'resume-fixture';

function protocol(): ReturnType<typeof createSessionProtocol> {
  return createSessionProtocol({
    agent: 'resume-fixture-agent',
    serverUrl: 'http://127.0.0.1:9',
    apiToken: 'unused-fetch-is-stubbed',
    slug: SLUG,
    cwd: '/tmp/resume-fixture',
  });
}

type FetchStub = { paths: string[]; bodies: string[]; stderr: string[] };

function stubFetch(respond?: (url: string) => Response): FetchStub {
  const stub: FetchStub = { paths: [], bodies: [], stderr: [] };
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stub.stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      stub.paths.push(new URL(url).pathname);
      stub.bodies.push(String(init?.body));
      return respond?.(url) ?? new Response('', { status: 200 });
    },
  );
  return stub;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the shared core resumes every session it ensures', () => {
  it('POSTs resume immediately after the ensure, in that order', async () => {
    const stub = stubFetch();
    await protocol().ensureSession('s-order');

    expect(stub.paths).toEqual([`/api/${SLUG}/sessions`, `/api/${SLUG}/sessions/s-order/resume`]);
    expect(JSON.parse(stub.bodies[1]!)).toEqual({});
  });

  it('POSTs resume exactly once per session id', async () => {
    const stub = stubFetch();
    const core = protocol();
    await core.ensureSession('s-once');
    const afterFirst = [...stub.paths];
    await core.ensureSession('s-once');
    await core.ensureSession('s-once');

    // Control: the first ensure really did emit both writes, so the
    // nothing-further assertion below is not measured over an empty set.
    expect(afterFirst).toHaveLength(2);
    expect(stub.paths).toEqual(afterFirst);
  });

  it('keeps one resume per id when two ensures for the same id overlap', async () => {
    const stub = stubFetch();
    const core = protocol();
    await Promise.all([core.ensureSession('s-concurrent'), core.ensureSession('s-concurrent')]);

    expect(stub.paths.filter((p) => p.endsWith('/resume'))).toEqual([
      `/api/${SLUG}/sessions/s-concurrent/resume`,
    ]);
  });

  it('resumes each session id separately', async () => {
    const stub = stubFetch();
    const core = protocol();
    await core.ensureSession('s-a');
    await core.ensureSession('s-b');

    expect(stub.paths.filter((p) => p.endsWith('/resume'))).toEqual([
      `/api/${SLUG}/sessions/s-a/resume`,
      `/api/${SLUG}/sessions/s-b/resume`,
    ]);
  });

  it('emits no resume for a sub-agent session', async () => {
    const stub = stubFetch();
    const core = protocol();
    core.markSubAgent('s-sub');
    await core.ensureSession('s-sub');
    // Control: the same protocol does emit for a session it did not mark.
    await core.ensureSession('s-main');

    expect(stub.paths).toEqual([`/api/${SLUG}/sessions`, `/api/${SLUG}/sessions/s-main/resume`]);
  });

  it('emits nothing at all when the protocol is disabled', async () => {
    const stub = stubFetch();
    const core = createSessionProtocol({
      agent: 'resume-fixture-agent',
      serverUrl: 'http://127.0.0.1:9',
      apiToken: 'unused-fetch-is-stubbed',
      slug: null,
    });
    await core.ensureSession('s-disabled');

    expect(core.disabled).toBe(true);
    expect(stub.paths).toEqual([]);
  });

  // Every way the ensure fails is a way the resume would fail too, so the skip
  // costs no resume — and it keeps a dead server's cost at one POST_TIMEOUT_MS.
  it('skips the resume when the ensure did not land', async () => {
    for (const status of [401, 404, 500]) {
      const stub = stubFetch(() => new Response('refused', { status }));
      await protocol().ensureSession(`s-ensure-${status}`);

      expect(stub.paths, `ensure ${status}`).toEqual([`/api/${SLUG}/sessions`]);
      vi.restoreAllMocks();
    }

    // Control: the only difference is the ensure's status, and it does resume.
    const ok = stubFetch();
    await protocol().ensureSession('s-ensure-ok');
    expect(ok.paths).toEqual([`/api/${SLUG}/sessions`, `/api/${SLUG}/sessions/s-ensure-ok/resume`]);
  });

  it('skips the resume when the ensure never reached the server', async () => {
    const stub = stubFetch();
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      stub.paths.push(new URL(String(input)).pathname);
      throw new Error('econnrefused');
    });

    await expect(protocol().ensureSession('s-ensure-down')).resolves.toBeUndefined();
    expect(stub.paths).toEqual([`/api/${SLUG}/sessions`]);
  });

  it('does not propagate a rejected resume POST, and reports it on stderr', async () => {
    const stub = stubFetch();
    vi.mocked(globalThis.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      stub.paths.push(new URL(url).pathname);
      if (url.endsWith('/resume')) throw new Error('econnrefused');
      return new Response('', { status: 200 });
    });

    await expect(protocol().ensureSession('s-throw')).resolves.toBeUndefined();
    expect(stub.stderr.join('')).toContain(
      `POST /api/${SLUG}/sessions/s-throw/resume econnrefused`,
    );
  });

  it('does not propagate a non-OK resume response', async () => {
    const stub = stubFetch((url) =>
      url.endsWith('/resume')
        ? new Response('nope', { status: 404 })
        : new Response('', { status: 200 }),
    );

    await expect(protocol().ensureSession('s-404')).resolves.toBeUndefined();
    // Without this the assertion above would pass on a build that never resumes.
    expect(stub.stderr.join('')).toContain(`POST /api/${SLUG}/sessions/s-404/resume 404 body=nope`);
  });
});
