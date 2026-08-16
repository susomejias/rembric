import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionProtocol } from '../bin/rembric-plugin-core.mjs';

// The tool-observation latch and the report that reads it live in the shared
// core, so the ordering between the two is pinned once for every client rather
// than per client — an ordering bug here is unreachable from one host and a
// trap for the next one to call `reportTurn` without the host's own guard.

const SLUG = 'turn-report-fixture';

function protocol(): ReturnType<typeof createSessionProtocol> {
  return createSessionProtocol({
    agent: 'turn-report-fixture-agent',
    serverUrl: 'http://127.0.0.1:9',
    apiToken: 'unused-fetch-is-stubbed',
    slug: SLUG,
    cwd: '/tmp/turn-report-fixture',
  });
}

type TurnStub = { paths: string[]; turns: Array<{ usedTools?: boolean }> };

function stubFetch(): TurnStub {
  const stub: TurnStub = { paths: [], turns: [] };
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const path = new URL(String(input)).pathname;
      stub.paths.push(path);
      if (path.endsWith('/turn')) {
        stub.turns.push(JSON.parse(String(init?.body ?? '{}')) as { usedTools?: boolean });
        return new Response('{"ok":true,"sessionId":"s","lines":[]}', { status: 200 });
      }
      return new Response('', { status: 200 });
    },
  );
  return stub;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('the shared core reads the tool latch only on a report it actually sends', () => {
  it('leaves the latch armed when the report is dropped for an unknown session', async () => {
    const stub = stubFetch();
    const core = protocol();

    core.markToolUsed('s-unknown');
    await core.reportTurn('s-unknown');
    // Control: the guard really did drop this report, so the surviving latch
    // below is not just a report that quietly succeeded.
    expect(stub.paths).toEqual([]);

    await core.ensureSession('s-unknown');
    await core.reportTurn('s-unknown');

    expect(stub.turns).toEqual([{ usedTools: true }]);
  });

  it('still reads and clears the latch on a report it does send', async () => {
    const stub = stubFetch();
    const core = protocol();

    await core.ensureSession('s-known');
    core.markToolUsed('s-known');
    await core.reportTurn('s-known');
    await core.reportTurn('s-known');

    expect(stub.turns).toEqual([{ usedTools: true }, { usedTools: false }]);
  });
});
