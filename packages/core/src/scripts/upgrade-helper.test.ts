import { describe, expect, it } from 'vitest';

import type { ContainerInspect } from '../services/self-update/engine-api.js';

import {
  deriveCreatePayload,
  parseHealthTimeoutMs,
  runUpgrade,
  type EngineLike,
  type UpgradeOutcome,
} from './upgrade-helper.js';

const SHORT_ID = 'abcdef012345';

// vitest types stringMatching() as any; the matcher is consumed only by toEqual.
const matching = (re: RegExp): string => expect.stringMatching(re) as string;

function containerInspect(overrides: Partial<ContainerInspect> = {}): ContainerInspect {
  return {
    Id: `${SHORT_ID}6789abcdef0123456789abcdef0123456789abcdef0123456789`,
    Name: '/rembric',
    State: { Running: true, Health: { Status: 'healthy' } },
    Config: {
      Image: 'ghcr.io/susomejias/rembric:0.28.8',
      Env: ['A=1', 'B=2'],
      Labels: { 'com.docker.compose.project': 'rembric' },
      ExposedPorts: { '8787/tcp': {} },
      Entrypoint: ['/nodejs/bin/node', '/app/apps/web/server.js'],
      Cmd: ['--serve'],
      User: '10001:10001',
      WorkingDir: '/app',
      Healthcheck: { Test: ['CMD', 'true'] },
    },
    HostConfig: { RestartPolicy: { Name: 'unless-stopped' } },
    NetworkSettings: {
      Networks: {
        rembric_default: { Aliases: [SHORT_ID, 'rembric'] },
        bridge: { Aliases: [SHORT_ID] },
      },
    },
    ...overrides,
  };
}

describe('deriveCreatePayload', () => {
  it('does not copy Entrypoint, Cmd or Healthcheck, so the new image defaults win', () => {
    const { payload } = deriveCreatePayload(containerInspect(), 'ghcr.io/rembric:new');
    expect(payload).not.toHaveProperty('Entrypoint');
    expect(payload).not.toHaveProperty('Cmd');
    expect(payload).not.toHaveProperty('Healthcheck');
    expect(payload['Image']).toBe('ghcr.io/rembric:new');
  });

  it('retains Env, Labels, ExposedPorts, User, WorkingDir, HostConfig and NetworkingConfig', () => {
    const old = containerInspect();
    const { payload } = deriveCreatePayload(old, 'img:new');
    expect(payload['Env']).toEqual(['A=1', 'B=2']);
    expect(payload['Labels']).toEqual({ 'com.docker.compose.project': 'rembric' });
    expect(payload['ExposedPorts']).toEqual({ '8787/tcp': {} });
    expect(payload['User']).toBe('10001:10001');
    expect(payload['WorkingDir']).toBe('/app');
    expect(payload['HostConfig']).toBe(old.HostConfig);
    expect(payload['NetworkingConfig']).toEqual({
      EndpointsConfig: { rembric_default: { Aliases: ['rembric'] }, bridge: {} },
    });
  });

  it('drops the old container short-id alias but keeps the network identity', () => {
    const { payload } = deriveCreatePayload(containerInspect(), 'img:new');
    const endpoints = (payload['NetworkingConfig'] as { EndpointsConfig: Record<string, unknown> })
      .EndpointsConfig;
    expect(endpoints['rembric_default']).toEqual({ Aliases: ['rembric'] });
    expect(endpoints['bridge']).toEqual({});
  });

  it('strips the leading slash from the container name', () => {
    const { name } = deriveCreatePayload(containerInspect(), 'img:new');
    expect(name).toBe('rembric');
  });

  it('omits empty User and WorkingDir rather than sending empty strings', () => {
    const old = containerInspect({
      Config: { ...containerInspect().Config, User: '', WorkingDir: '' },
    });
    const { payload } = deriveCreatePayload(old, 'img:new');
    expect(payload['User']).toBeUndefined();
    expect(payload['WorkingDir']).toBeUndefined();
  });
});

describe('parseHealthTimeoutMs', () => {
  const noop = (): void => {};

  it('returns undefined when absent or empty', () => {
    expect(parseHealthTimeoutMs(undefined, noop)).toBeUndefined();
    expect(parseHealthTimeoutMs('', noop)).toBeUndefined();
  });

  it('accepts a positive integer', () => {
    expect(parseHealthTimeoutMs('600000', noop)).toBe(600000);
  });

  it('degrades a malformed value to the default with the documented log line', () => {
    const lines: string[] = [];
    for (const raw of ['abc', '-5', '0', '12.5']) {
      lines.length = 0;
      expect(parseHealthTimeoutMs(raw, (l) => lines.push(l))).toBeUndefined();
      expect(lines).toEqual([
        `ignoring malformed REMBRIC_UPGRADE_HEALTH_TIMEOUT_MS="${raw}" — using the 150s default`,
      ]);
    }
  });
});

interface FakeEngineCalls {
  stopped: string[];
  renamed: Array<{ id: string; name: string }>;
  created: Array<{ name: string; payload: unknown }>;
  started: string[];
  removed: Array<{ id: string; force: boolean }>;
  inspected: string[];
}

function fakeEngine(config: {
  old: ContainerInspect;
  newId?: string;
  newStates?: Array<ContainerInspect['State'] | undefined>;
  restoredStates?: Array<ContainerInspect['State'] | undefined>;
}): { engine: EngineLike; calls: FakeEngineCalls; newId: string } {
  const newId = config.newId ?? 'new-container-id';
  const calls: FakeEngineCalls = {
    stopped: [],
    renamed: [],
    created: [],
    started: [],
    removed: [],
    inspected: [],
  };
  let sawInitialOldInspect = false;
  let newInspections = 0;
  let restoredInspections = 0;

  const engine: EngineLike = {
    inspectContainer: (idOrName: string) => {
      calls.inspected.push(idOrName);
      if (idOrName === config.old.Id) {
        if (!sawInitialOldInspect) {
          sawInitialOldInspect = true;
          return Promise.resolve(config.old);
        }
        const states = config.restoredStates ?? [{ Running: true, Health: { Status: 'healthy' } }];
        const state = states[Math.min(restoredInspections, states.length - 1)];
        restoredInspections++;
        return Promise.resolve({ ...config.old, State: state });
      }
      if (idOrName === newId) {
        const states = config.newStates ?? [{ Running: false }];
        const state = states[Math.min(newInspections, states.length - 1)];
        newInspections++;
        return Promise.resolve({ ...config.old, Id: newId, State: state });
      }
      return Promise.reject(new Error(`unexpected inspect: ${idOrName}`));
    },
    createContainer: (name: string, payload: unknown) => {
      calls.created.push({ name, payload });
      return Promise.resolve({ Id: newId });
    },
    startContainer: (id: string) => {
      calls.started.push(id);
      return Promise.resolve();
    },
    stopContainer: (id: string) => {
      calls.stopped.push(id);
      return Promise.resolve();
    },
    renameContainer: (id: string, name: string) => {
      calls.renamed.push({ id, name });
      return Promise.resolve();
    },
    removeContainer: (id: string, force?: boolean) => {
      calls.removed.push({ id, force: force ?? false });
      return Promise.resolve();
    },
  };
  return { engine, calls, newId };
}

function collectLogs(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line: string) => lines.push(line), lines };
}

async function upgrade(
  engine: EngineLike,
  old: ContainerInspect,
  extra: { noHealthcheckGraceMs?: number; backupPath?: string; lines?: string[] } = {},
): Promise<UpgradeOutcome> {
  return runUpgrade(engine, {
    oldId: old.Id,
    targetImage: 'ghcr.io/rembric:new',
    healthTimeoutMs: 200,
    pollIntervalMs: 1,
    noHealthcheckGraceMs: extra.noHealthcheckGraceMs,
    backupPath: extra.backupPath,
    log: extra.lines ? (l) => extra.lines!.push(l) : () => {},
  });
}

describe('runUpgrade with a fake engine', () => {
  it('swaps a healthy replacement and removes the old container', async () => {
    const old = containerInspect();
    const { engine, calls, newId } = fakeEngine({
      old,
      newStates: [{ Running: true, Health: { Status: 'healthy' } }],
    });
    const { log, lines } = collectLogs();

    const outcome = await runUpgrade(engine, {
      oldId: old.Id,
      targetImage: 'ghcr.io/rembric:new',
      healthTimeoutMs: 200,
      pollIntervalMs: 1,
      log,
    });

    expect(outcome).toBe('ok');
    expect(calls.stopped).toEqual([old.Id]);
    expect(calls.renamed).toEqual([{ id: old.Id, name: matching(/^rembric-old-\d+$/) }]);
    expect(calls.created).toHaveLength(1);
    expect(calls.created[0]?.name).toBe('rembric');
    expect(calls.started).toEqual([newId]);
    expect(calls.removed).toEqual([{ id: old.Id, force: true }]);
    expect(lines).toContain('upgrade complete: rembric is now running ghcr.io/rembric:new');
  });

  it('treats continuous Running with no HEALTHCHECK as healthy after the grace window', async () => {
    const old = containerInspect();
    const { engine, calls } = fakeEngine({ old, newStates: [{ Running: true }] });
    const outcome = await upgrade(engine, old, { noHealthcheckGraceMs: 0 });
    expect(outcome).toBe('ok');
    expect(calls.renamed).toEqual([{ id: old.Id, name: matching(/^rembric-old-/) }]);
  });

  it('rolls back to the old container when the replacement never becomes healthy', async () => {
    const old = containerInspect();
    const { engine, calls, newId } = fakeEngine({
      old,
      newStates: [{ Running: false }],
      restoredStates: [{ Running: true, Health: { Status: 'healthy' } }],
    });
    const { log, lines } = collectLogs();

    const outcome = await runUpgrade(engine, {
      oldId: old.Id,
      targetImage: 'ghcr.io/rembric:new',
      healthTimeoutMs: 200,
      pollIntervalMs: 1,
      log,
    });

    expect(outcome).toBe('rolled-back');
    expect(calls.removed).toEqual([{ id: newId, force: true }]);
    expect(calls.renamed).toEqual([
      { id: old.Id, name: matching(/^rembric-old-/) },
      { id: old.Id, name: 'rembric' },
    ]);
    expect(calls.started).toEqual([newId, old.Id]);
    expect(calls.removed.some((r) => r.id === old.Id)).toBe(false);
    expect(lines).toContain('rollback complete: rembric is back on the previous version');
    expect(lines.some((l) => l.startsWith('upgrade failed:'))).toBe(true);
  });

  it('names the pre-update snapshot when the restored old container never recovers', async () => {
    const old = containerInspect();
    const { engine, calls, newId } = fakeEngine({
      old,
      newStates: [{ Running: false }],
      restoredStates: [{ Running: false }],
    });
    const { log, lines } = collectLogs();

    const outcome = await runUpgrade(engine, {
      oldId: old.Id,
      targetImage: 'ghcr.io/rembric:new',
      healthTimeoutMs: 200,
      pollIntervalMs: 1,
      backupPath: '/data/backups/pre-update-v0.28.10-42.sqlite',
      log,
    });

    expect(outcome).toBe('rolled-back-unhealthy');
    expect(calls.started).toEqual([newId, old.Id]);
    expect(lines.some((l) => l.includes('DID NOT BECOME HEALTHY'))).toBe(true);
    expect(
      lines.some((l) =>
        l.includes('restore the pre-update snapshot (/data/backups/pre-update-v0.28.10-42.sqlite)'),
      ),
    ).toBe(true);
  });
});
