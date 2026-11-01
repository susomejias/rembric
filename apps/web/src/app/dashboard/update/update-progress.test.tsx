import type * as React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { STATUS_MAX_MISSES, statusFailureMode, UpdateProgress } from './update-progress';

const effect = vi.hoisted(() => ({ run: undefined as React.EffectCallback | undefined }));

vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof React>()),
  useEffect: (run: React.EffectCallback) => {
    effect.run = run;
  },
}));

const VERSION = '0.28.12';
let cleanup: ReturnType<React.EffectCallback>;

afterEach(() => {
  cleanup?.();
  cleanup = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function replay(phases: string[], version = '0.28.13') {
  vi.useFakeTimers();
  const replace = vi.fn();
  vi.stubGlobal('window', { location: { replace } });
  const fetch = vi.fn((url: string) =>
    Promise.resolve(
      Response.json(
        url.endsWith('/status')
          ? { phase: phases.shift() ?? 'idle', error: null, pull: null, targetVersion: null }
          : { version },
      ),
    ),
  );
  vi.stubGlobal('fetch', fetch);
  render();
  cleanup = effect.run?.();
  await vi.advanceTimersByTimeAsync(15_000);
  return { replace, fetch };
}

function stepStates(html: string): Record<string, string> {
  const states: Record<string, string> = {};
  const re = /data-step="([^"]+)" data-state="([^"]+)"/g;
  let match: RegExpExecArray | null = re.exec(html);
  while (match !== null) {
    states[match[1] ?? ''] = match[2] ?? '';
    match = re.exec(html);
  }
  return states;
}

function render(): string {
  return renderToStaticMarkup(<UpdateProgress initialVersion={VERSION} />);
}

describe('UpdateProgress', () => {
  it('renders the four hand-off steps in order, all idle before the first poll', () => {
    const html = render();

    expect(stepStates(html)).toEqual({
      backup: 'idle',
      pull: 'idle',
      restart: 'idle',
      verify: 'idle',
    });
    expect(html).not.toContain('data-pull-progress');
    expect(html).not.toContain('Update failed');
  });

  it('reloads when it observes the restarting phase and the new version answers', async () => {
    const { replace } = await replay(['pull', 'launch', 'restarting']);
    expect(replace).toHaveBeenCalledWith('/dashboard');
  });

  it.each([{ phases: [] }, { phases: ['pull'] }, { phases: ['pull', 'launch'] }])(
    'reloads when the server restarts between status polls ($phases)',
    async ({ phases }) => {
      const { replace } = await replay(phases);
      expect(replace).toHaveBeenCalledWith('/dashboard');
    },
  );

  it('stops verification instead of reporting success when idle returns the old version', async () => {
    const { replace, fetch } = await replay(['launch'], VERSION);
    expect(replace).not.toHaveBeenCalled();
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/version'))).toHaveLength(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops on an explicit update failure without checking the version', async () => {
    const { replace, fetch } = await replay(['pull', 'failed']);
    expect(replace).not.toHaveBeenCalled();
    expect(fetch.mock.calls.some(([url]) => url.endsWith('/version'))).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tolerates transient status-probe failures before switching to version probing', () => {
    for (let misses = 1; misses < STATUS_MAX_MISSES; misses += 1) {
      expect(statusFailureMode(misses)).toBe('retry');
    }
    expect(statusFailureMode(STATUS_MAX_MISSES)).toBe('verify');
    expect(statusFailureMode(STATUS_MAX_MISSES + 10)).toBe('verify');
  });
});
