import { SelfUpdateOrchestrator } from '@rembric/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getSelfUpdate, isUpdateRunning } from './self-update-service';

const RUNNING_PHASES = ['backup', 'pull', 'launch', 'restarting'] as const;
const IDLE = { targetVersion: null, error: null, pull: null, startedAt: null } as const;

function resetSingletons(): void {
  const globals = globalThis as Record<string, unknown>;
  delete globals['__rembricUpdates'];
  delete globals['__rembricSelfUpdate'];
}

function clearEnv(): void {
  delete process.env['REMBRIC_UPDATE_CHECK'];
  delete process.env['REMBRIC_UPDATE_CHECK_URL'];
}

beforeEach(() => {
  clearEnv();
  resetSingletons();
});

afterEach(() => {
  clearEnv();
  resetSingletons();
});

describe('self-update service', () => {
  it('builds the real orchestrator, memoized on the global singleton', () => {
    const updater = getSelfUpdate();

    expect(updater).toBeInstanceOf(SelfUpdateOrchestrator);
    expect(updater.status()).toEqual({
      phase: 'idle',
      targetVersion: null,
      error: null,
      pull: null,
      startedAt: null,
    });
    expect(getSelfUpdate()).toBe(updater);
  });

  it('flags exactly the four running phases as an update in progress', () => {
    for (const phase of RUNNING_PHASES) {
      expect(isUpdateRunning({ ...IDLE, phase })).toBe(true);
    }

    expect(isUpdateRunning({ ...IDLE, phase: 'idle' })).toBe(false);
    expect(isUpdateRunning({ ...IDLE, phase: 'failed' })).toBe(false);
  });
});
