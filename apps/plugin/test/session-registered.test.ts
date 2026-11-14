import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSessionProtocol } from '../bin/rembric-plugin-core.mjs';

function protocol(): ReturnType<typeof createSessionProtocol> {
  return createSessionProtocol({
    agent: 'session-registered-fixture-agent',
    serverUrl: 'http://127.0.0.1:9',
    apiToken: 'unused-fetch-is-stubbed',
    slug: 'session-registered-fixture',
  });
}

function stubEnsure(status: number): void {
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  vi.spyOn(globalThis, 'fetch').mockImplementation(
    async (): Promise<Response> => new Response(JSON.stringify({ created: true }), { status }),
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isRegistered tells a successful ensure from a failed one', () => {
  it('is true once the server accepted the session', async () => {
    stubEnsure(200);
    const core = protocol();
    await core.ensureSession('sess-ok-1');
    expect(core.isKnown('sess-ok-1')).toBe(true);
    expect(core.isRegistered('sess-ok-1')).toBe(true);
  });

  it('stays false when the ensure POST failed, although the id is known', async () => {
    stubEnsure(500);
    const core = protocol();
    await core.ensureSession('sess-fail-1');
    expect(core.isKnown('sess-fail-1')).toBe(true);
    expect(core.isRegistered('sess-fail-1')).toBe(false);
  });

  it('is cleared by forgetSession', async () => {
    stubEnsure(200);
    const core = protocol();
    await core.ensureSession('sess-forget-1');
    core.forgetSession('sess-forget-1');
    expect(core.isRegistered('sess-forget-1')).toBe(false);
  });
});
