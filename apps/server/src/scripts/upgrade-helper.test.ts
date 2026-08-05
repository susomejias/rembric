import { describe, expect, it } from 'vitest';

import type { ContainerInspect } from '../services/self-update/engine-api.js';

import {
  deriveCreatePayload,
  parseHealthTimeoutMs,
  runUpgrade,
  type EngineLike,
} from './upgrade-helper.js';

function oldContainer(over: Partial<ContainerInspect> = {}): ContainerInspect {
  return {
    Id: 'abc123def456',
    Name: '/rembric',
    State: { Running: true },
    Config: {
      Image: 'ghcr.io/susomejias/rembric:latest',
      Env: ['REMBRIC_PORT=8787', 'REMBRIC_ADMIN_TOKEN=<token>'],
      Labels: { 'com.docker.compose.project': 'rembric', 'com.docker.compose.service': 'rembric' },
      ExposedPorts: { '8787/tcp': {} },
      User: 'rembric',
    },
    HostConfig: {
      Binds: ['/srv/rembric/data:/data'],
      PortBindings: { '8787/tcp': [{ HostPort: '8787' }] },
      RestartPolicy: { Name: 'unless-stopped' },
    },
    NetworkSettings: {
      Networks: { rembric_default: { Aliases: ['rembric', 'abc123def456'.slice(0, 12)] } },
    },
    ...over,
  };
}

describe('deriveCreatePayload', () => {
  it('preserves env, labels, ports, volumes, restart policy; swaps the image', () => {
    const { name, payload } = deriveCreatePayload(
      oldContainer(),
      'ghcr.io/susomejias/rembric:0.22.0',
    );
    expect(name).toBe('rembric');
    expect(payload['Image']).toBe('ghcr.io/susomejias/rembric:0.22.0');
    expect(payload['Env']).toContain('REMBRIC_PORT=8787');
    expect((payload['Labels'] as Record<string, string>)['com.docker.compose.project']).toBe(
      'rembric',
    );
    const hostConfig = payload['HostConfig'] as Record<string, unknown>;
    expect((hostConfig['Binds'] as string[])[0]).toBe('/srv/rembric/data:/data');
    expect((hostConfig['RestartPolicy'] as { Name: string }).Name).toBe('unless-stopped');
  });

  it('does not pin the old Entrypoint/Cmd (new image defaults win)', () => {
    const { payload } = deriveCreatePayload(oldContainer(), 'img:new');
    expect('Entrypoint' in payload).toBe(false);
    expect('Cmd' in payload).toBe(false);
  });

  it('drops the old container-id network alias, keeps real ones', () => {
    const { payload } = deriveCreatePayload(oldContainer(), 'img:new');
    const networking = payload['NetworkingConfig'] as {
      EndpointsConfig: Record<string, { Aliases?: string[] }>;
    };
    expect(networking.EndpointsConfig['rembric_default']?.Aliases).toEqual(['rembric']);
  });
});

describe('parseHealthTimeoutMs', () => {
  it('returns the parsed override', () => {
    expect(parseHealthTimeoutMs('600000', () => {})).toBe(600_000);
  });

  it('unset means no override and no noise', () => {
    const lines: string[] = [];
    expect(parseHealthTimeoutMs(undefined, (l) => lines.push(l))).toBeUndefined();
    expect(parseHealthTimeoutMs('', (l) => lines.push(l))).toBeUndefined();
    expect(lines).toEqual([]);
  });

  it.each(['abc', '-5', '0', '1.5', '150000ms'])(
    'a malformed value (%j) falls back to the default and says so',
    (raw) => {
      const lines: string[] = [];
      expect(parseHealthTimeoutMs(raw, (l) => lines.push(l))).toBeUndefined();
      expect(lines.length).toBe(1);
      expect(lines[0]).toContain('REMBRIC_UPGRADE_HEALTH_TIMEOUT_MS');
      expect(lines[0]).toContain(raw);
    },
  );
});

interface Calls {
  log: string[];
  ops: string[];
}

function fakeEngine(opts: {
  healthSequence?: Array<string | undefined>;
  failCreate?: boolean;
  failStartNew?: boolean;
  /** Old container never comes back up after the rollback restart. */
  oldDeadAfterRollback?: boolean;
}): { engine: EngineLike; calls: Calls; names: Map<string, string> } {
  const calls: Calls = { log: [], ops: [] };
  const names = new Map<string, string>([['abc123def456', 'rembric']]);
  let healthIdx = 0;
  let oldRestarted = false;
  const engine: EngineLike = {
    inspectContainer: (id) => {
      calls.ops.push(`inspect:${id}`);
      if (id === 'abc123def456' || id === names.get('abc123def456')) {
        if (opts.oldDeadAfterRollback && oldRestarted) {
          return Promise.resolve(
            oldContainer({ State: { Running: false, Health: { Status: 'unhealthy' } } }),
          );
        }
        return Promise.resolve(oldContainer());
      }
      if (id === 'new789') {
        const seq = opts.healthSequence ?? ['healthy'];
        const status = seq[Math.min(healthIdx++, seq.length - 1)];
        return Promise.resolve(
          oldContainer({
            Id: 'new789',
            Name: '/rembric',
            State: { Running: true, Health: status ? { Status: status } : undefined },
          }),
        );
      }
      return Promise.reject(new Error('no such container'));
    },
    createContainer: (name) => {
      calls.ops.push(`create:${name}`);
      if (opts.failCreate) return Promise.reject(new Error('image not found'));
      names.set('new789', name);
      return Promise.resolve({ Id: 'new789' });
    },
    startContainer: (id) => {
      calls.ops.push(`start:${id}`);
      if (id === 'new789' && opts.failStartNew) return Promise.reject(new Error('boom'));
      if (id === 'abc123def456') oldRestarted = true;
      return Promise.resolve();
    },
    stopContainer: (id) => {
      calls.ops.push(`stop:${id}`);
      return Promise.resolve();
    },
    renameContainer: (id, name) => {
      calls.ops.push(`rename:${id}→${name}`);
      names.set(id, name);
      return Promise.resolve();
    },
    removeContainer: (id, force) => {
      calls.ops.push(`remove:${id}${force ? ':force' : ''}`);
      return Promise.resolve();
    },
  };
  return { engine, calls, names };
}

const FAST = { healthTimeoutMs: 500, pollIntervalMs: 1, noHealthcheckGraceMs: 5, log: () => {} };

describe('runUpgrade', () => {
  it('happy path: stop → rename → create → start → healthy → remove old', async () => {
    const { engine, calls } = fakeEngine({ healthSequence: ['starting', 'healthy'] });
    const outcome = await runUpgrade(engine, {
      oldId: 'abc123def456',
      targetImage: 'img:0.22.0',
      ...FAST,
    });
    expect(outcome).toBe('ok');
    const ops = calls.ops.join(' ');
    expect(ops).toMatch(
      /stop:abc123def456.*rename:abc123def456→rembric-old-.*create:rembric.*start:new789.*remove:abc123def456:force/,
    );
  });

  it('rolls back when the replacement never becomes healthy', async () => {
    const { engine, calls } = fakeEngine({ healthSequence: ['starting'] });
    const outcome = await runUpgrade(engine, {
      oldId: 'abc123def456',
      targetImage: 'img:0.22.0',
      ...FAST,
      healthTimeoutMs: 20,
    });
    expect(outcome).toBe('rolled-back');
    const ops = calls.ops.join(' ');
    expect(ops).toContain('remove:new789:force');
    // rename-back then restart, followed by the post-rollback health probe
    expect(ops).toMatch(/rename:abc123def456→rembric .*start:abc123def456/);
  });

  it('rolls back when create fails (old container restored, nothing removed)', async () => {
    const { engine, calls } = fakeEngine({ failCreate: true });
    const outcome = await runUpgrade(engine, {
      oldId: 'abc123def456',
      targetImage: 'img:0.22.0',
      ...FAST,
    });
    expect(outcome).toBe('rolled-back');
    const ops = calls.ops.join(' ');
    expect(ops).not.toContain('remove:new789');
    expect(ops).toMatch(/rename:abc123def456→rembric .*start:abc123def456/);
  });

  it('old container failing to recover post-rollback names the backup to restore', async () => {
    const { engine } = fakeEngine({
      healthSequence: ['starting'],
      oldDeadAfterRollback: true,
    });
    const lines: string[] = [];
    const outcome = await runUpgrade(engine, {
      oldId: 'abc123def456',
      targetImage: 'img:0.22.0',
      ...FAST,
      healthTimeoutMs: 20,
      backupPath: '/data/backups/pre-update-v0.22.0-123.sqlite',
      log: (l) => lines.push(l),
    });
    expect(outcome).toBe('rolled-back-unhealthy');
    expect(lines.some((l) => l.includes('migrated the database forward'))).toBe(true);
    const recovery = lines.find((l) => l.startsWith('MANUAL RECOVERY'));
    expect(recovery).toContain('/data/backups/pre-update-v0.22.0-123.sqlite');
    expect(recovery).toContain('Writes that landed during the failed update window will be lost');
  });

  it('double fault: rollback failure logs manual recovery and rethrows', async () => {
    const { engine, calls } = fakeEngine({ failCreate: true });
    const lines: string[] = [];
    const original = engine.renameContainer.bind(engine);
    let renames = 0;
    engine.renameContainer = (id, name) => {
      // First rename (parking the old container) succeeds; the rename-back
      // during rollback fails.
      renames++;
      if (renames > 1) return Promise.reject(new Error('daemon hung'));
      return original(id, name);
    };
    await expect(
      runUpgrade(engine, {
        oldId: 'abc123def456',
        targetImage: 'img:0.22.0',
        ...FAST,
        log: (l) => lines.push(l),
      }),
    ).rejects.toThrow('daemon hung');
    expect(lines.some((l) => l.startsWith('ROLLBACK FAILED'))).toBe(true);
    const recovery = lines.find((l) => l.startsWith('MANUAL RECOVERY'));
    expect(recovery).toContain('docker rename rembric-old-');
    expect(recovery).toContain('docker start rembric');
    // The old container was never removed — the data and config are intact.
    expect(calls.ops.join(' ')).not.toContain('remove:abc123def456');
  });

  it('treats a healthcheck-less running replacement as healthy after the grace window', async () => {
    const { engine } = fakeEngine({ healthSequence: [undefined] });
    const outcome = await runUpgrade(engine, {
      oldId: 'abc123def456',
      targetImage: 'img:0.22.0',
      ...FAST,
      noHealthcheckGraceMs: 10,
    });
    expect(outcome).toBe('ok');
  });
});
