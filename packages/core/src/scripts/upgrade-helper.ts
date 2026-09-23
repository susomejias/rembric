import { hostname } from 'node:os';

import {
  DockerEngineApi,
  type ContainerInspect,
  type PullProgressEvent,
} from '../services/self-update/engine-api.js';

export interface EngineLike {
  inspectContainer(idOrName: string): Promise<ContainerInspect>;
  createContainer(name: string, payload: unknown): Promise<{ Id: string }>;
  startContainer(id: string): Promise<void>;
  stopContainer(id: string, timeoutSec?: number): Promise<void>;
  renameContainer(id: string, name: string): Promise<void>;
  removeContainer(id: string, force?: boolean): Promise<void>;
  pullImage?(
    repo: string,
    tag: string,
    onProgress?: (ev: PullProgressEvent) => void,
  ): Promise<void>;
}

export function deriveCreatePayload(
  old: ContainerInspect,
  targetImage: string,
): { name: string; payload: Record<string, unknown> } {
  const name = old.Name.replace(/^\//, '');
  const networks = old.NetworkSettings?.Networks ?? {};
  const endpoints: Record<string, unknown> = {};
  for (const [netName, net] of Object.entries(networks)) {
    // The daemon re-adds the new container's own id alias; carrying the old id alias would be a stale alias.
    const aliases = (net.Aliases ?? []).filter((a) => !old.Id.startsWith(a));
    endpoints[netName] = aliases.length > 0 ? { Aliases: aliases } : {};
  }
  // Entrypoint/Cmd/Healthcheck are deliberately absent: the new image's defaults must win.
  const payload: Record<string, unknown> = {
    Image: targetImage,
    Env: old.Config.Env ?? [],
    Labels: old.Config.Labels ?? {},
    ExposedPorts: old.Config.ExposedPorts ?? {},
    User: old.Config.User || undefined,
    WorkingDir: old.Config.WorkingDir || undefined,
    HostConfig: old.HostConfig,
    NetworkingConfig: { EndpointsConfig: endpoints },
  };
  return { name, payload };
}

export interface UpgradeOptions {
  oldId: string;
  targetImage: string;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  noHealthcheckGraceMs?: number;
  backupPath?: string;
  log?: (line: string) => void;
}

export type UpgradeOutcome = 'ok' | 'rolled-back' | 'rolled-back-unhealthy';

export function parseHealthTimeoutMs(
  raw: string | undefined,
  log: (line: string) => void,
): number | undefined {
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    log(`ignoring malformed REMBRIC_UPGRADE_HEALTH_TIMEOUT_MS="${raw}" — using the 150s default`);
    return undefined;
  }
  return n;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

async function waitHealthy(
  engine: EngineLike,
  id: string,
  timeoutMs: number,
  pollMs: number,
  graceMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let runningSince = 0;
  while (Date.now() < deadline) {
    try {
      const c = await engine.inspectContainer(id);
      const health = c.State?.Health?.Status;
      if (health === 'healthy') return true;
      if (health === undefined && c.State?.Running) {
        // No HEALTHCHECK in the image: continuous Running for the grace window counts as healthy.
        if (runningSince === 0) runningSince = Date.now();
        if (Date.now() - runningSince >= graceMs) return true;
      } else if (!c.State?.Running && health !== 'starting') {
        return false;
      }
    } catch {
      return false;
    }
    await sleep(pollMs);
  }
  return false;
}

export async function runUpgrade(
  engine: EngineLike,
  opts: UpgradeOptions,
): Promise<UpgradeOutcome> {
  const log = opts.log ?? ((line: string) => console.error(line));
  const healthTimeoutMs = opts.healthTimeoutMs ?? 150_000;
  const pollMs = opts.pollIntervalMs ?? 2_000;
  const graceMs = opts.noHealthcheckGraceMs ?? 10_000;

  const old = await engine.inspectContainer(opts.oldId);
  const { name, payload } = deriveCreatePayload(old, opts.targetImage);
  const parkedName = `${name}-old-${Date.now()}`;

  log(`upgrading ${name} (${old.Id.slice(0, 12)}) to ${opts.targetImage}`);
  await engine.stopContainer(old.Id);
  await engine.renameContainer(old.Id, parkedName);

  let newId: string | null = null;
  try {
    const created = await engine.createContainer(name, payload);
    newId = created.Id;
    await engine.startContainer(newId);
    const healthy = await waitHealthy(engine, newId, healthTimeoutMs, pollMs, graceMs);
    if (!healthy) throw new Error('replacement container did not become healthy in time');
  } catch (err) {
    log(`upgrade failed: ${err instanceof Error ? err.message : String(err)} — rolling back`);
    if (newId) {
      try {
        await engine.removeContainer(newId, true);
      } catch {
        // Nothing left to remove.
      }
    }
    try {
      await engine.renameContainer(old.Id, name);
      await engine.startContainer(old.Id);
    } catch (rollbackErr) {
      log(
        `ROLLBACK FAILED: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
      );
      log(
        `MANUAL RECOVERY: docker rename ${parkedName} ${name} && docker start ${name}  (data volume is untouched)`,
      );
      throw rollbackErr;
    }
    // The failed version may have migrated the database forward; the restored old code could then refuse to boot.
    const oldRecovered = await waitHealthy(engine, old.Id, healthTimeoutMs, pollMs, graceMs);
    if (!oldRecovered) {
      log(
        `ROLLED BACK BUT ${name} DID NOT BECOME HEALTHY — the failed update may have migrated the database forward.`,
      );
      log(
        `MANUAL RECOVERY: docker stop ${name}, restore the pre-update snapshot${opts.backupPath ? ` (${opts.backupPath})` : ''} over data.db in the data volume (remove data.db-wal / data.db-shm), then docker start ${name}. Writes that landed during the failed update window will be lost — that is why this step is yours, not automatic.`,
      );
      return 'rolled-back-unhealthy';
    }
    log(`rollback complete: ${name} is back on the previous version`);
    return 'rolled-back';
  }

  await engine.removeContainer(old.Id, true);
  log(`upgrade complete: ${name} is now running ${opts.targetImage}`);
  return 'ok';
}

async function main(): Promise<void> {
  const oldId = process.env['REMBRIC_UPGRADE_TARGET_CONTAINER'];
  const targetImage = process.env['REMBRIC_UPGRADE_IMAGE'];
  if (!oldId || !targetImage) {
    console.error(
      'upgrade-helper: REMBRIC_UPGRADE_TARGET_CONTAINER and REMBRIC_UPGRADE_IMAGE are required',
    );
    process.exit(2);
  }
  const engine = new DockerEngineApi();
  const outcome = await runUpgrade(engine, {
    oldId,
    targetImage,
    backupPath: process.env['REMBRIC_UPGRADE_BACKUP'],
    healthTimeoutMs: parseHealthTimeoutMs(
      process.env['REMBRIC_UPGRADE_HEALTH_TIMEOUT_MS'],
      (line) => console.error(line),
    ),
  });
  if (outcome === 'ok') {
    // Best-effort self-removal: the daemon force-kills this container as the call lands.
    try {
      await engine.removeContainer(hostname(), true);
    } catch {
      // An exited helper left behind is harmless.
    }
    process.exit(0);
  }
  process.exit(1);
}

const invokedDirectly = process.argv[1]?.endsWith('upgrade-helper.js') === true;
if (invokedDirectly) {
  main().catch((err: unknown) => {
    console.error(`upgrade-helper: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
