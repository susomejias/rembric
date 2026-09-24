import type { SessionContext, SessionsService } from '@rembric/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { startMock } = vi.hoisted(() => ({ startMock: vi.fn() }));

interface GuardModule {
  guardAction: (...args: unknown[]) => Promise<unknown>;
  guardFailure: (result: never) => { error: string | null };
}

vi.mock('./self-update-service', () => ({
  getSelfUpdate: () => ({ start: startMock }),
}));

vi.mock('@/lib/actions/guard', async () => {
  const actual = await vi.importActual<GuardModule>('@/lib/actions/guard');
  return { ...actual, guardAction: vi.fn() };
});

import { startUpdate } from './actions';
import { getUpdates } from './update-service';

import { guardAction } from '@/lib/actions/guard';
import type { Services } from '@/lib/services';

function resetUpdatesSingleton(): void {
  delete (globalThis as Record<string, unknown>)['__rembricUpdates'];
}

function grant(): void {
  vi.mocked(guardAction).mockResolvedValue({
    ok: true,
    session: {} as SessionContext,
    sessions: {} as SessionsService,
    services: {} as Services,
  });
}

async function redirectTarget(run: () => Promise<unknown>): Promise<string> {
  try {
    await run();
  } catch (err) {
    const digest = (err as { digest?: unknown }).digest;
    return typeof digest === 'string' ? digest : '';
  }
  throw new Error('expected redirect() to throw');
}

async function primeRelease(version: string): Promise<void> {
  delete process.env['REMBRIC_UPDATE_CHECK'];
  process.env['REMBRIC_UPDATE_CHECK_URL'] = `http://updates.test/releases`;
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(
          JSON.stringify([
            {
              tag_name: `server-v${version}`,
              body: '### Features\n\n* something',
              html_url: 'https://example.test/release',
              published_at: '2026-09-22T10:15:00.000Z',
            },
          ]),
          { status: 200, headers: { etag: 'test-etag' } },
        ),
      ),
    ),
  );
  await getUpdates().checkNow();
}

beforeEach(() => {
  delete process.env['REMBRIC_UPDATE_CHECK_URL'];
  process.env['REMBRIC_UPDATE_CHECK'] = 'off';
  resetUpdatesSingleton();
  startMock.mockReset();
  vi.mocked(guardAction).mockReset();
});

afterEach(() => {
  delete process.env['REMBRIC_UPDATE_CHECK_URL'];
  delete process.env['REMBRIC_UPDATE_CHECK'];
  resetUpdatesSingleton();
  vi.unstubAllGlobals();
});

describe('startUpdate', () => {
  it('refuses without the form CSRF guard', async () => {
    vi.mocked(guardAction).mockResolvedValue({
      ok: false,
      error: 'csrf_invalid',
      message: 'This submission could not be verified. Reload the page and try again.',
    });

    const state = await startUpdate({ error: null }, new FormData());

    expect(state.error).toBe(
      'This submission could not be verified. Reload the page and try again.',
    );
    expect(startMock).not.toHaveBeenCalled();
  });

  it('sends an expired session back to the login page', async () => {
    vi.mocked(guardAction).mockResolvedValue({
      ok: false,
      error: 'session_required',
      message: 'Your dashboard session has expired. Sign in again.',
    });

    const digest = await redirectTarget(() => startUpdate({ error: null }, new FormData()));

    expect(digest).toContain('/dashboard/login');
    expect(startMock).not.toHaveBeenCalled();
  });

  it('refuses when no release is known', async () => {
    grant();

    const digest = await redirectTarget(() => startUpdate({ error: null }, new FormData()));

    expect(digest).toContain('/dashboard/update?err=no_update');
    expect(startMock).not.toHaveBeenCalled();
  });

  it('redirects back with the orchestrator failure code', async () => {
    grant();
    startMock.mockResolvedValue({ ok: false, code: 'backup_failed' });
    await primeRelease('9.9.9');

    const digest = await redirectTarget(() => startUpdate({ error: null }, new FormData()));

    expect(digest).toContain('/dashboard/update?err=backup_failed');
  });

  it('hands off to the orchestrator with the released version', async () => {
    grant();
    startMock.mockResolvedValue({ ok: true });
    await primeRelease('9.9.9');

    const digest = await redirectTarget(() => startUpdate({ error: null }, new FormData()));

    expect(startMock).toHaveBeenCalledWith('9.9.9');
    expect(digest).toContain('/dashboard/update');
    expect(digest).not.toContain('?');
  });
});
