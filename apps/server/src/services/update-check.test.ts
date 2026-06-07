import { describe, expect, it } from 'vitest';

import { parseSemver, semverGt, UpdateCheckService } from './update-check.js';

function release(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tag_name: 'server-v0.22.0',
    body: '## New features\n- one-click updates',
    html_url: 'https://github.com/susomejias/rembric/releases/tag/server-v0.22.0',
    published_at: '2026-06-01T00:00:00Z',
    prerelease: false,
    draft: false,
    ...over,
  };
}

function fakeFetch(responses: Array<{ status: number; body?: unknown; etag?: string }>): {
  fetchImpl: typeof fetch;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  let i = 0;
  const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url,
      headers: (init?.headers as Record<string, string>) ?? {},
    });
    const r = responses[Math.min(i, responses.length - 1)];
    i++;
    if (!r) throw new Error('no response configured');
    return Promise.resolve(
      new Response(r.body === undefined ? null : JSON.stringify(r.body), {
        status: r.status,
        headers: r.etag ? { etag: r.etag } : {},
      }),
    );
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function svc(
  opts: Partial<ConstructorParameters<typeof UpdateCheckService>[0]> & {
    fetchImpl: typeof fetch;
  },
): UpdateCheckService {
  return new UpdateCheckService({ currentVersion: '0.21.1', enabled: true, ...opts });
}

describe('semver helpers', () => {
  it('parses plain and v-prefixed versions', () => {
    expect(parseSemver('0.21.1')).toEqual([0, 21, 1]);
    expect(parseSemver('v1.2.3')).toEqual([1, 2, 3]);
    expect(parseSemver('1.2.3-rc.1')).toBeNull();
    expect(parseSemver('latest')).toBeNull();
  });

  it('compares correctly', () => {
    expect(semverGt('0.22.0', '0.21.1')).toBe(true);
    expect(semverGt('0.21.1', '0.21.1')).toBe(false);
    expect(semverGt('0.21.0', '0.21.1')).toBe(false);
    expect(semverGt('1.0.0', '0.99.99')).toBe(true);
  });
});

describe('UpdateCheckService', () => {
  it('reports a newer server release', async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: [release()] }]);
    const s = svc({ fetchImpl });
    const info = await s.refresh();
    expect(info).not.toBeNull();
    expect(info?.latestVersion).toBe('0.22.0');
    expect(info?.currentVersion).toBe('0.21.1');
    expect(info?.changelog).toContain('one-click');
    expect(s.peek()?.latestVersion).toBe('0.22.0');
  });

  it('returns null when latest equals or precedes the running version', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: [release({ tag_name: 'server-v0.21.1' })] },
    ]);
    expect(await svc({ fetchImpl }).refresh()).toBeNull();

    const older = fakeFetch([{ status: 200, body: [release({ tag_name: 'server-v0.20.0' })] }]);
    expect(await svc({ fetchImpl: older.fetchImpl }).refresh()).toBeNull();
  });

  it('skips prereleases, drafts, and non-server components', async () => {
    const { fetchImpl } = fakeFetch([
      {
        status: 200,
        body: [
          release({ tag_name: 'server-v0.23.0', prerelease: true }),
          release({ tag_name: 'server-v0.24.0', draft: true }),
          release({ tag_name: 'claude-code-plugin-v9.9.9' }),
          release({ tag_name: 'server-v0.22.0' }),
        ],
      },
    ]);
    const info = await svc({ fetchImpl }).refresh();
    expect(info?.latestVersion).toBe('0.22.0');
  });

  it('is disabled by REMBRIC_UPDATE_CHECK=off semantics', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: [release()] }]);
    const s = svc({ fetchImpl, enabled: false });
    expect(await s.refresh()).toBeNull();
    expect(s.peek()).toBeNull();
    expect(calls.length).toBe(0);
  });

  it('fails silently on network errors', async () => {
    const fetchImpl = (() => Promise.reject(new Error('offline'))) as typeof fetch;
    const s = svc({ fetchImpl });
    expect(await s.refresh()).toBeNull();
    expect(s.peek()).toBeNull();
  });

  it('sends If-None-Match and keeps the cache on 304', async () => {
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, body: [release()], etag: 'W/"abc"' },
      { status: 304 },
    ]);
    const s = svc({ fetchImpl, intervalMs: 0 });
    await s.refresh();
    const info = await s.refresh();
    expect(info?.latestVersion).toBe('0.22.0');
    expect(calls[1]?.headers['if-none-match']).toBe('W/"abc"');
  });

  it('checkNow bypasses the 24h window and reports update', async () => {
    let t = 0;
    const { fetchImpl, calls } = fakeFetch([
      { status: 200, body: [release({ tag_name: 'server-v0.21.1' })] },
      { status: 200, body: [release()] },
    ]);
    const s = svc({ fetchImpl, now: () => t, intervalMs: 1000 });
    expect(await s.checkNow()).toEqual({ outcome: 'none', info: null });
    t = 1; // deep inside the interval — peek would not refetch
    const second = await s.checkNow();
    expect(calls.length).toBe(2);
    expect(second.outcome).toBe('update');
    expect(second.info?.latestVersion).toBe('0.22.0');
    expect(s.peek()?.latestVersion).toBe('0.22.0');
  });

  it('checkNow reports none on same/older release and on 304', async () => {
    const { fetchImpl } = fakeFetch([
      { status: 200, body: [release({ tag_name: 'server-v0.21.1' })], etag: 'W/"abc"' },
      { status: 304 },
    ]);
    const s = svc({ fetchImpl });
    expect((await s.checkNow()).outcome).toBe('none');
    expect((await s.checkNow()).outcome).toBe('none');
  });

  it('checkNow reports error on network failure and non-OK status', async () => {
    const failing = svc({ fetchImpl: () => Promise.reject(new Error('offline')) });
    expect((await failing.checkNow()).outcome).toBe('error');

    const rateLimited = svc({ fetchImpl: fakeFetch([{ status: 403, body: {} }]).fetchImpl });
    expect((await rateLimited.checkNow()).outcome).toBe('error');
  });

  it('checkNow error does not lose a previously cached update', async () => {
    const { fetchImpl } = fakeFetch([{ status: 200, body: [release()] }, { status: 500 }]);
    const s = svc({ fetchImpl });
    expect((await s.checkNow()).outcome).toBe('update');
    const after = await s.checkNow();
    expect(after.outcome).toBe('error');
    expect(after.info?.latestVersion).toBe('0.22.0');
  });

  it('checkNow on a disabled service never fetches', async () => {
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: [release()] }]);
    const s = svc({ fetchImpl, enabled: false });
    expect(await s.checkNow()).toEqual({ outcome: 'none', info: null });
    expect(calls.length).toBe(0);
    expect(s.enabled).toBe(false);
  });

  it('lastCheckedAt reflects manual and automatic checks', async () => {
    let t = 5000;
    const { fetchImpl } = fakeFetch([{ status: 200, body: [release()] }]);
    const s = svc({ fetchImpl, now: () => t, intervalMs: 1000 });
    expect(s.lastCheckedAt).toBeNull();
    await s.checkNow();
    expect(s.lastCheckedAt?.getTime()).toBe(5000);
    t = 7000;
    s.peek(); // stale — background refresh fires
    await new Promise((r) => setTimeout(r, 0));
    expect(s.lastCheckedAt?.getTime()).toBe(7000);
  });

  it('peek respects the 24h interval', async () => {
    let t = 0;
    const { fetchImpl, calls } = fakeFetch([{ status: 200, body: [release()] }]);
    const s = svc({ fetchImpl, now: () => t, intervalMs: 1000 });
    s.peek();
    await s.refresh(); // settle the background kick
    const before = calls.length;
    t = 500;
    s.peek(); // within interval — no new fetch
    expect(calls.length).toBe(before);
    t = 1500;
    s.peek(); // stale — background refresh fires
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBeGreaterThan(before);
  });
});
