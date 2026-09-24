import { SelfUpdateOrchestrator } from '@rembric/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getSelfUpdate, isUpdateRunning, updatePreviewPhase } from './self-update-service';
import { getUpdates } from './update-service';

import { REMBRIC_VERSION } from '@/lib/version';

const PREVIEW_VERSION_ENV = 'REMBRIC_UPDATE_PREVIEW_VERSION';
const PREVIEW_PHASE_ENV = 'REMBRIC_UPDATE_PREVIEW_PHASE';
const RUNNING_PHASES = ['backup', 'pull', 'launch', 'restarting'] as const;
const IDLE = { targetVersion: null, error: null, pull: null, startedAt: null } as const;

function resetSingletons(): void {
  const globals = globalThis as Record<string, unknown>;
  delete globals['__rembricUpdates'];
  delete globals['__rembricSelfUpdate'];
}

function clearEnv(): void {
  delete process.env[PREVIEW_VERSION_ENV];
  delete process.env[PREVIEW_PHASE_ENV];
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

describe('update preview seam', () => {
  it('serves a fake offer while the real check stays off', async () => {
    process.env['REMBRIC_UPDATE_CHECK'] = 'off';
    process.env[PREVIEW_VERSION_ENV] = '9.9.9';

    const updates = getUpdates();

    expect(updates.enabled).toBe(true);
    expect(updates.peek()?.latestVersion).toBe('9.9.9');
    expect(updates.peek()?.currentVersion).toBe(REMBRIC_VERSION);
    expect(updates.lastCheckedAt).toBeNull();
    await expect(updates.checkNow()).resolves.toEqual({ outcome: 'none', info: null });
  });

  it('leaves the real checker in place without a preview version', async () => {
    process.env['REMBRIC_UPDATE_CHECK'] = 'off';

    const updates = getUpdates();

    expect(updates.enabled).toBe(false);
    expect(updates.peek()).toBeNull();
    await expect(updates.checkNow()).resolves.toEqual({ outcome: 'none', info: null });
  });

  it('does not cache the preview stand-in on the global singleton', () => {
    process.env[PREVIEW_VERSION_ENV] = '9.9.9';
    const preview = getUpdates();
    expect(preview.peek()?.latestVersion).toBe('9.9.9');

    clearEnv();

    expect(getUpdates().enabled).toBe(true);
    expect(getUpdates().peek()).toBeNull();
  });
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

  it('serves a stand-in that needs no Docker socket under preview', async () => {
    process.env[PREVIEW_VERSION_ENV] = '9.9.9';
    process.env[PREVIEW_PHASE_ENV] = 'pull';

    const updater = getSelfUpdate();
    const status = updater.status();

    expect(updater).not.toBeInstanceOf(SelfUpdateOrchestrator);
    expect(status).toMatchObject({
      phase: 'pull',
      targetVersion: '9.9.9',
      error: null,
      pull: { done: 3, total: 9 },
    });
    expect(typeof status.startedAt).toBe('number');
    await expect(updater.capability()).resolves.toMatchObject({
      state: 'available',
      containerId: 'preview',
      imageRepo: 'ghcr.io/susomejias/rembric',
    });
    await expect(updater.start('9.9.9')).resolves.toEqual({ ok: false, code: 'not_available' });
  });

  it('stays idle under preview when no phase is set', () => {
    process.env[PREVIEW_VERSION_ENV] = '9.9.9';

    expect(getSelfUpdate().status()).toMatchObject({
      phase: 'idle',
      targetVersion: null,
      pull: null,
    });
  });

  it('ignores a preview phase without a preview version', () => {
    process.env[PREVIEW_PHASE_ENV] = 'pull';

    expect(updatePreviewPhase()).toBe('pull');
    expect(getSelfUpdate()).toBeInstanceOf(SelfUpdateOrchestrator);
    expect(getSelfUpdate().status().phase).toBe('idle');
  });

  it('accepts only the four running phases as a preview phase', () => {
    for (const phase of RUNNING_PHASES) {
      process.env[PREVIEW_PHASE_ENV] = phase;
      expect(updatePreviewPhase()).toBe(phase);
      expect(isUpdateRunning({ ...IDLE, phase })).toBe(true);
    }

    for (const phase of ['idle', 'failed', 'nope', '']) {
      process.env[PREVIEW_PHASE_ENV] = phase;
      expect(updatePreviewPhase()).toBeNull();
    }

    expect(isUpdateRunning({ ...IDLE, phase: 'idle' })).toBe(false);
    expect(isUpdateRunning({ ...IDLE, phase: 'failed' })).toBe(false);
  });
});
