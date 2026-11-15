import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionProtocol } from '../bin/rembric-plugin-core.mjs';

const SLUG = 'subagent-report-fixture';
const PARENT = 'ses-parent';
const REPORT_WITH_PRIVATE =
  'Scanned the module. Token <private>k</private> was rotated.\n\n## Key Learnings\n1. The cache key includes the scope id.';
const REPORT_REDACTED =
  'Scanned the module. Token [REDACTED] was rotated.\n\n## Key Learnings\n1. The cache key includes the scope id.';

type Captured = { path: string; method: string; body: unknown };

function protocol(serverUrl = 'http://127.0.0.1:9', apiToken = 'stubbed') {
  return createSessionProtocol({
    agent: 'subagent-report-fixture-agent',
    serverUrl,
    apiToken,
    slug: SLUG,
    cwd: '/tmp/subagent-report-fixture',
  });
}

function stubFetch(learningsStatus = 200): { learnings: Captured[]; stderr: string[] } {
  const learnings: Captured[] = [];
  const stderr: string[] = [];
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith('/learnings')) {
        learnings.push({
          path,
          method: init?.method ?? 'GET',
          body: JSON.parse(String(init?.body)),
        });
        return new Response('{"error":"session_not_found"}', { status: learningsStatus });
      }
      return new Response('', { status: 200 });
    },
  );
  return { learnings, stderr };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('postSubagentReport forwards a finished subagent report to its parent session', () => {
  it('POSTs the redacted report and the agent type to the parent session learnings route', async () => {
    const stub = stubFetch();
    const core = protocol();
    await core.ensureSession(PARENT);

    const sent = await core.postSubagentReport(PARENT, REPORT_WITH_PRIVATE, 'explore');

    expect(sent).toBe(true);
    expect(stub.learnings).toEqual([
      {
        path: `/api/${SLUG}/sessions/${PARENT}/learnings`,
        method: 'POST',
        body: { report: REPORT_REDACTED, agentType: 'explore' },
      },
    ]);
  });

  it('sends only the report when the host names no agent type', async () => {
    const stub = stubFetch();
    const core = protocol();
    await core.ensureSession(PARENT);

    await core.postSubagentReport(PARENT, REPORT_WITH_PRIVATE);
    await core.postSubagentReport(PARENT, REPORT_WITH_PRIVATE, '');

    expect(stub.learnings.map((c) => c.body)).toEqual([
      { report: REPORT_REDACTED },
      { report: REPORT_REDACTED },
    ]);
  });

  it('matches the phrase in any letter case', async () => {
    const stub = stubFetch();
    const core = protocol();
    await core.ensureSession(PARENT);

    await core.postSubagentReport(PARENT, 'done\n### KEY learnings\n- a fact');

    expect(stub.learnings.map((c) => c.body)).toEqual([
      { report: 'done\n### KEY learnings\n- a fact' },
    ]);
  });

  it('makes no request for a report without the phrase', async () => {
    const stub = stubFetch();
    const core = protocol();
    await core.ensureSession(PARENT);

    const sent = await core.postSubagentReport(PARENT, 'done\n## Learnings\n- key fact', 'explore');

    expect(sent).toBe(false);
    expect(stub.learnings).toEqual([]);
  });

  it('makes no request when the phrase exists only inside a private span', async () => {
    const stub = stubFetch();
    const core = protocol();
    await core.ensureSession(PARENT);

    await core.postSubagentReport(PARENT, 'done <private>## Key Learnings\n- secret</private>');

    expect(stub.learnings).toEqual([]);
  });

  it('makes no request for a session marked as a subagent', async () => {
    const stub = stubFetch();
    const core = protocol();
    await core.ensureSession('ses-child');
    core.markSubAgent('ses-child');

    const sent = await core.postSubagentReport('ses-child', REPORT_WITH_PRIVATE);

    expect(sent).toBe(false);
    expect(stub.learnings).toEqual([]);
  });

  it('makes no request for a session this process never registered', async () => {
    const stub = stubFetch();
    const core = protocol();

    await core.postSubagentReport('ses-unknown', REPORT_WITH_PRIVATE);

    expect(stub.learnings).toEqual([]);
  });

  it('makes no request when the plugin is disabled', async () => {
    const stub = stubFetch();
    const core = protocol('', '');
    await core.ensureSession(PARENT);

    await core.postSubagentReport(PARENT, REPORT_WITH_PRIVATE);

    expect(stub.learnings).toEqual([]);
  });

  it('forwards the same report every time it is handed over, leaving dedupe to the server', async () => {
    const stub = stubFetch();
    const core = protocol();
    await core.ensureSession(PARENT);

    await core.postSubagentReport(PARENT, REPORT_WITH_PRIVATE);
    await core.postSubagentReport(PARENT, REPORT_WITH_PRIVATE);

    expect(stub.learnings).toHaveLength(2);
  });

  it('writes exactly one stderr line when the server refuses the report', async () => {
    const stub = stubFetch(404);
    const core = protocol();
    await core.ensureSession(PARENT);
    stub.stderr.length = 0;

    const sent = await core.postSubagentReport(PARENT, REPORT_WITH_PRIVATE);

    expect(sent).toBe(false);
    expect(stub.stderr).toHaveLength(1);
    expect(stub.stderr[0]).toContain(`/api/${SLUG}/sessions/${PARENT}/learnings 404`);
  });

  it('writes exactly one stderr line when the server is unreachable', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    const core = protocol('http://127.0.0.1:9');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/learnings')) throw new TypeError('fetch failed');
      return new Response('', { status: 200 });
    });
    await core.ensureSession(PARENT);
    stderr.length = 0;

    const sent = await core.postSubagentReport(PARENT, REPORT_WITH_PRIVATE);

    expect(sent).toBe(false);
    expect(stderr).toEqual([
      `[rembric] POST /api/${SLUG}/sessions/${PARENT}/learnings fetch failed\n`,
    ]);
  });

  it('abandons the request after a two-second budget', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(globalThis, 'fetch').mockImplementation(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        if (!String(input).endsWith('/learnings')) return new Response('', { status: 200 });
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        });
      },
    );
    const core = protocol();
    await core.ensureSession(PARENT);

    const started = performance.now();
    const sent = await core.postSubagentReport(PARENT, REPORT_WITH_PRIVATE);
    const elapsed = performance.now() - started;

    expect(sent).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(2600);
  });
});
