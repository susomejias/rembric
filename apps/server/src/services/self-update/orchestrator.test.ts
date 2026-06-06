import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { CapabilityDetector, SelfUpdateCapability } from './capability.js';
import type { PullProgressEvent } from './engine-api.js';
import { createPreUpdateBackup, SelfUpdateOrchestrator } from './orchestrator.js';

const AVAILABLE: SelfUpdateCapability = {
  state: 'available',
  reason: 'ok',
  containerId: 'abc123',
  imageRepo: 'ghcr.io/susomejias/rembric',
  imageTag: 'latest',
};

function fakeCapability(cap: SelfUpdateCapability): CapabilityDetector {
  return {
    detect: () => Promise.resolve(cap),
    detectCached: () => Promise.resolve(cap),
  } as unknown as CapabilityDetector;
}

interface EngineCalls {
  pulls: Array<{ repo: string; tag: string }>;
  created: Array<{ name: string; payload: Record<string, unknown> }>;
  started: string[];
}

function fakeEngine(calls: EngineCalls, opts: { failPull?: boolean } = {}) {
  return {
    pullImage: (repo: string, tag: string, onProgress?: (ev: PullProgressEvent) => void) => {
      calls.pulls.push({ repo, tag });
      if (opts.failPull) return Promise.reject(new Error('no space left on device'));
      onProgress?.({ status: 'Downloading', id: 'aaa' });
      onProgress?.({ status: 'Pull complete', id: 'aaa' });
      return Promise.resolve();
    },
    createContainer: (name: string, payload: unknown) => {
      calls.created.push({ name, payload: payload as Record<string, unknown> });
      return Promise.resolve({ Id: 'helper789' });
    },
    startContainer: (id: string) => {
      calls.started.push(id);
      return Promise.resolve();
    },
  };
}

async function settle(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0));
}

describe('createPreUpdateBackup', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rembric-backup-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the backups dir and vacuums into a timestamped file', () => {
    const written: string[] = [];
    const backupsDir = join(dir, 'backups');
    const backup = createPreUpdateBackup({
      vacuumInto: (p) => {
        written.push(p);
        writeFileSync(p, 'snapshot');
      },
      backupsDir,
      now: () => 1000,
    });
    backup('0.22.0');
    expect(existsSync(backupsDir)).toBe(true);
    expect(written[0]).toBe(join(backupsDir, 'pre-update-v0.22.0-1000.sqlite'));
  });

  it('propagates vacuum failures', () => {
    const backup = createPreUpdateBackup({
      vacuumInto: () => {
        throw new Error('disk full');
      },
      backupsDir: join(dir, 'backups'),
    });
    expect(() => backup('0.22.0')).toThrow('disk full');
  });

  it('keeps only the 3 most recent pre-update backups', () => {
    let t = 1000;
    const backupsDir = join(dir, 'backups');
    const backup = createPreUpdateBackup({
      vacuumInto: (p) => writeFileSync(p, 'x'),
      backupsDir,
      now: () => t++,
    });
    for (const v of ['0.22.0', '0.22.1', '0.22.2', '0.22.3']) backup(v);
    const left = readdirSync(backupsDir).sort();
    expect(left.length).toBe(3);
    expect(left.some((f) => f.includes('v0.22.0'))).toBe(false);
  });
});

describe('SelfUpdateOrchestrator', () => {
  function build(opts: { cap?: SelfUpdateCapability; failPull?: boolean; failBackup?: boolean }): {
    orch: SelfUpdateOrchestrator;
    calls: EngineCalls;
    backups: string[];
  } {
    const calls: EngineCalls = { pulls: [], created: [], started: [] };
    const backups: string[] = [];
    const orch = new SelfUpdateOrchestrator({
      capability: fakeCapability(opts.cap ?? AVAILABLE),
      engineFactory: () => fakeEngine(calls, { failPull: opts.failPull }),
      backup: (v) => {
        if (opts.failBackup) throw new Error('disk full');
        backups.push(v);
        return `/data/backups/pre-update-v${v}-42.sqlite`;
      },
      socketPath: '/tmp/test.sock',
      now: () => 42,
      log: () => {},
    });
    return { orch, calls, backups };
  }

  it('starts idle', () => {
    const { orch } = build({});
    expect(orch.status().phase).toBe('idle');
  });

  it('refuses with no side effects when capability is manual', async () => {
    const { orch, calls, backups } = build({ cap: { state: 'manual', reason: 'no-socket' } });
    const r = await orch.start('0.22.0');
    expect(r).toEqual({ ok: false, code: 'not_available' });
    expect(backups.length).toBe(0);
    expect(calls.pulls.length).toBe(0);
    expect(orch.status().phase).toBe('idle');
  });

  it('refuses when pinned', async () => {
    const { orch } = build({
      cap: { state: 'pinned', reason: 'pinned-tag', containerId: 'abc', imageRepo: 'r' },
    });
    expect((await orch.start('0.22.0')).ok).toBe(false);
  });

  it('backup failure aborts before any engine call', async () => {
    const { orch, calls } = build({ failBackup: true });
    const r = await orch.start('0.22.0');
    expect(r).toEqual({ ok: false, code: 'backup_failed' });
    expect(calls.pulls.length).toBe(0);
    expect(orch.status().phase).toBe('failed');
    expect(orch.status().error).toContain('disk full');
  });

  it('happy path: backup → pull → launch helper → restarting', async () => {
    const { orch, calls, backups } = build({});
    const r = await orch.start('0.22.0');
    expect(r).toEqual({ ok: true });
    await settle();
    expect(backups).toEqual(['0.22.0']);
    expect(calls.pulls).toEqual([{ repo: 'ghcr.io/susomejias/rembric', tag: 'latest' }]);
    expect(calls.created.length).toBe(1);
    const helper = calls.created[0];
    expect(helper?.name).toBe('rembric-upgrader-42');
    const env = helper?.payload['Env'] as string[];
    expect(env).toContain('REMBRIC_UPGRADE_TARGET_CONTAINER=abc123');
    expect(env).toContain('REMBRIC_UPGRADE_IMAGE=ghcr.io/susomejias/rembric:latest');
    const hostConfig = helper?.payload['HostConfig'] as { Binds: string[] };
    expect(hostConfig.Binds[0]).toBe('/tmp/test.sock:/var/run/docker.sock');
    expect(calls.started).toEqual(['helper789']);
    expect(orch.status().phase).toBe('restarting');
    expect(orch.status().pull).toEqual({ done: 1, total: 1 });
  });

  it('pull failure surfaces in status and unlocks re-runs', async () => {
    const { orch } = build({ failPull: true });
    expect((await orch.start('0.22.0')).ok).toBe(true);
    await settle();
    expect(orch.status().phase).toBe('failed');
    expect(orch.status().error).toContain('no space left');
    // failed runs unlock the orchestrator for another attempt
    expect((await orch.start('0.22.0')).ok).toBe(true);
  });

  it('rejects concurrent runs', async () => {
    const { orch } = build({});
    expect((await orch.start('0.22.0')).ok).toBe(true);
    expect(await orch.start('0.22.0')).toEqual({ ok: false, code: 'already_running' });
  });
});
