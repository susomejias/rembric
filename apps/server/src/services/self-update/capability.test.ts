import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { CapabilityDetector, isPinnedTag, splitImageRef } from './capability.js';
import type { ContainerInspect } from './engine-api.js';

let dir: string;
let presentSocket: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'rembric-cap-'));
  presentSocket = join(dir, 'docker.sock');
  // existsSync is the only check before ping; a plain file stands in.
  writeFileSync(presentSocket, '');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function inspectOf(image: string): ContainerInspect {
  return { Id: 'abc123', Name: '/rembric', Config: { Image: image }, HostConfig: {} };
}

interface FakeEngineOpts {
  pingOk?: boolean;
  containers?: Record<string, ContainerInspect>;
}

function fakeEngine(opts: FakeEngineOpts) {
  return {
    ping: () => Promise.resolve(opts.pingOk ?? true),
    inspectContainer: (id: string) => {
      const c = opts.containers?.[id];
      if (!c) return Promise.reject(new Error('no such container'));
      return Promise.resolve(c);
    },
  };
}

function detector(
  engineOpts: FakeEngineOpts,
  over: Partial<ConstructorParameters<typeof CapabilityDetector>[0]> = {},
): CapabilityDetector {
  return new CapabilityDetector({
    socketPath: presentSocket,
    engineFactory: () => fakeEngine(engineOpts),
    env: {},
    hostnameFn: () => 'abc123',
    log: () => {},
    ...over,
  });
}

describe('splitImageRef / isPinnedTag', () => {
  it('splits repo and tag, defaulting to latest', () => {
    expect(splitImageRef('ghcr.io/susomejias/rembric:0.21.1')).toEqual({
      repo: 'ghcr.io/susomejias/rembric',
      tag: '0.21.1',
    });
    expect(splitImageRef('ghcr.io/susomejias/rembric')).toEqual({
      repo: 'ghcr.io/susomejias/rembric',
      tag: 'latest',
    });
    expect(splitImageRef('registry:5000/rembric')).toEqual({
      repo: 'registry:5000/rembric',
      tag: 'latest',
    });
  });

  it('recognizes pinned semver tags', () => {
    expect(isPinnedTag('0.21.1')).toBe(true);
    expect(isPinnedTag('v0.21.1')).toBe(true);
    expect(isPinnedTag('latest')).toBe(false);
    expect(isPinnedTag('')).toBe(false);
  });
});

describe('CapabilityDetector', () => {
  it('no socket → manual/no-socket without touching the engine', async () => {
    let engineBuilt = false;
    const d = new CapabilityDetector({
      socketPath: join(dir, 'absent.sock'),
      engineFactory: () => {
        engineBuilt = true;
        return fakeEngine({});
      },
      log: () => {},
    });
    expect(await d.detect()).toEqual({ state: 'manual', reason: 'no-socket' });
    expect(engineBuilt).toBe(false);
  });

  it('socket present but ping fails → manual/socket-unusable, logs once', async () => {
    const lines: string[] = [];
    const d = detector({ pingOk: false }, { log: (l) => lines.push(l) });
    expect((await d.detect()).reason).toBe('socket-unusable');
    expect((await d.detect()).reason).toBe('socket-unusable');
    expect(lines.length).toBe(1);
    expect(lines[0]).toContain('group_add');
  });

  it('self container not found → manual/self-not-found', async () => {
    const d = detector({ containers: {} });
    expect((await d.detect()).reason).toBe('self-not-found');
  });

  it('unpinned latest tag → available with repo/tag/id', async () => {
    const d = detector({
      containers: { abc123: inspectOf('ghcr.io/susomejias/rembric:latest') },
    });
    expect(await d.detect()).toEqual({
      state: 'available',
      reason: 'ok',
      containerId: 'abc123',
      imageRepo: 'ghcr.io/susomejias/rembric',
      imageTag: 'latest',
    });
  });

  it('pinned tag → pinned', async () => {
    const d = detector({
      containers: { abc123: inspectOf('ghcr.io/susomejias/rembric:0.21.1') },
    });
    const cap = await d.detect();
    expect(cap.state).toBe('pinned');
    expect(cap.imageTag).toBe('0.21.1');
  });

  it('latest tag but REMBRIC_VERSION env pin → pinned (env cross-check)', async () => {
    const d = detector(
      { containers: { abc123: inspectOf('ghcr.io/susomejias/rembric:latest') } },
      { env: { REMBRIC_VERSION: '0.21.1' } },
    );
    const cap = await d.detect();
    expect(cap.state).toBe('pinned');
    expect(cap.imageTag).toBe('0.21.1');
  });

  it('falls back to the container name when hostname inspect misses', async () => {
    const d = detector(
      { containers: { rembric: inspectOf('ghcr.io/susomejias/rembric:latest') } },
      { hostnameFn: () => 'not-a-container-id' },
    );
    expect((await d.detect()).state).toBe('available');
  });

  it('detectCached respects the TTL', async () => {
    let t = 0;
    let detects = 0;
    const d = detector(
      { containers: { abc123: inspectOf('ghcr.io/susomejias/rembric:latest') } },
      { cacheTtlMs: 1000, now: () => t },
    );
    const original = d.detect.bind(d);
    d.detect = () => {
      detects++;
      return original();
    };
    await d.detectCached();
    t = 500;
    await d.detectCached();
    expect(detects).toBe(1);
    t = 1500;
    await d.detectCached();
    expect(detects).toBe(2);
  });
});
