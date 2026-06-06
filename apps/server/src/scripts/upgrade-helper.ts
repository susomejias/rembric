/**
 * Ephemeral upgrader — entrypoint of the one-shot container the
 * orchestrator launches from the freshly pulled image. Performs the swap
 * the running server cannot survive:
 *
 *   inspect old → stop → rename away → create+start replacement under the
 *   original name → wait healthy → remove old (or roll back).
 *
 * On failure the exited upgrader container is left in place so its logs
 * remain inspectable (`docker logs rembric-upgrader-*`).
 */

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

/**
 * Clone the old container's creation config, swapping only the image.
 * Compose labels ride along so `docker compose` keeps recognizing the
 * replacement as its own service container.
 */
export function deriveCreatePayload(
  old: ContainerInspect,
  targetImage: string,
): { name: string; payload: Record<string, unknown> } {
  const name = old.Name.replace(/^\//, '');
  const networks = old.NetworkSettings?.Networks ?? {};
  const endpoints: Record<string, unknown> = {};
  for (const [netName, net] of Object.entries(networks)) {
    // Aliases include the old container's short id — drop it; the daemon
    // re-adds the new container's own id alias automatically.
    const aliases = (net.Aliases ?? []).filter((a) => !old.Id.startsWith(a));
    endpoints[netName] = aliases.length > 0 ? { Aliases: aliases } : {};
  }
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
  // Entrypoint/Cmd are deliberately NOT copied: the new image's defaults
  // must win (an entrypoint rename between versions would otherwise brick).
  return { name, payload };
}

export interface UpgradeOptions {
  oldId: string;
  targetImage: string;
  healthTimeoutMs?: number;
  pollIntervalMs?: number;
  /** Continuous-Running window that counts as healthy when the image has no HEALTHCHECK. */
  noHealthcheckGraceMs?: number;
  /** Pre-update snapshot path, named in recovery messages. */
  backupPath?: string;
  log?: (line: string) => void;
}

export type UpgradeOutcome = 'ok' | 'rolled-back' | 'rolled-back-unhealthy';

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
        // No HEALTHCHECK in the image: continuous Running for the grace
        // window counts as healthy.
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
        /* nothing left to remove */
      }
    }
    try {
      await engine.renameContainer(old.Id, name);
      await engine.startContainer(old.Id);
    } catch (rollbackErr) {
      // Double fault: the rollback itself failed. Never die silently —
      // print the exact manual recovery so the operator can restore.
      log(
        `ROLLBACK FAILED: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`,
      );
      log(
        `MANUAL RECOVERY: docker rename ${parkedName} ${name} && docker start ${name}  (data volume is untouched)`,
      );
      throw rollbackErr;
    }
    // The failed version may have migrated the database forward before
    // dying; the restored old code could then refuse to boot. Verify, and
    // if it never recovers, name the exact snapshot to restore.
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
  });
  if (outcome === 'ok') {
    // Best-effort self-removal: the daemon force-kills this container as
    // the call lands, which is exactly the intent. Failure is harmless —
    // it just leaves an exited helper behind.
    try {
      await engine.removeContainer(hostname(), true);
    } catch {
      /* see above */
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
