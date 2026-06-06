/**
 * Self-update orchestrator — the server-side half of the one-click flow.
 *
 * Runs everything that can run while this process is still alive:
 * backup → pull → launch the ephemeral upgrader container. The container
 * swap itself happens in the upgrader (see `scripts/upgrade-helper.ts`),
 * which outlives this process by design.
 */

import { mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

import { type CapabilityDetector, type SelfUpdateCapability } from './capability.js';
import {
  DEFAULT_DOCKER_SOCKET,
  type DockerEngineApi,
  type PullProgressEvent,
} from './engine-api.js';

export type UpdatePhase = 'idle' | 'backup' | 'pull' | 'launch' | 'restarting' | 'failed';

export interface UpdateStatus {
  phase: UpdatePhase;
  targetVersion: string | null;
  error: string | null;
  /** Pull progress: layers completed / layers seen. */
  pull: { done: number; total: number } | null;
  startedAt: number | null;
}

export type StartResult =
  | { ok: true }
  | { ok: false; code: 'not_available' | 'already_running' | 'backup_failed' };

const BACKUP_PREFIX = 'pre-update-';
const BACKUP_KEEP = 3;

export interface BackupDeps {
  /** Runs `VACUUM INTO` to the given absolute path (throws on failure). */
  vacuumInto: (destPath: string) => void;
  backupsDir: string;
  now?: () => number;
}

/**
 * Consistent pre-update snapshot, mandatory and gating: any throw here
 * aborts the update before a single container is touched. Keeps the
 * `BACKUP_KEEP` most recent pre-update files. Returns the snapshot path
 * so the upgrader can name it in recovery instructions.
 */
export function createPreUpdateBackup(deps: BackupDeps): (targetVersion: string) => string {
  const now = deps.now ?? Date.now;
  return (targetVersion: string) => {
    mkdirSync(deps.backupsDir, { recursive: true, mode: 0o700 });
    const file = join(deps.backupsDir, `${BACKUP_PREFIX}v${targetVersion}-${now()}.sqlite`);
    deps.vacuumInto(file);
    const old = readdirSync(deps.backupsDir)
      .filter((f) => f.startsWith(BACKUP_PREFIX) && f.endsWith('.sqlite'))
      .sort()
      .reverse()
      .slice(BACKUP_KEEP);
    for (const f of old) {
      try {
        unlinkSync(join(deps.backupsDir, f));
      } catch {
        /* retention is best-effort; never fail the update over it */
      }
    }
    return file;
  };
}

export interface OrchestratorDeps {
  capability: CapabilityDetector;
  engineFactory: (
    socketPath: string,
  ) => Pick<DockerEngineApi, 'pullImage' | 'createContainer' | 'startContainer'>;
  /** Takes the pre-update snapshot; returns its path (named in recovery hints). */
  backup: (targetVersion: string) => string;
  socketPath?: string;
  /** Entrypoint of the upgrader inside the new image. */
  helperEntrypoint?: string[];
  now?: () => number;
  log?: (line: string) => void;
}

export class SelfUpdateOrchestrator {
  private readonly deps: OrchestratorDeps;
  private readonly socketPath: string;
  private readonly now: () => number;
  private readonly log: (line: string) => void;

  private current: UpdateStatus = {
    phase: 'idle',
    targetVersion: null,
    error: null,
    pull: null,
    startedAt: null,
  };
  private running = false;

  constructor(deps: OrchestratorDeps) {
    this.deps = deps;
    this.socketPath = deps.socketPath ?? DEFAULT_DOCKER_SOCKET;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? ((line) => console.error(line));
  }

  status(): UpdateStatus {
    return { ...this.current, pull: this.current.pull ? { ...this.current.pull } : null };
  }

  capability(): Promise<SelfUpdateCapability> {
    return this.deps.capability.detectCached();
  }

  /**
   * Kick off a one-click update. Refuses with no side effects unless the
   * capability state is `available`. Returns as soon as the upgrader
   * container is launched — from there the swap is out of our hands.
   */
  async start(targetVersion: string): Promise<StartResult> {
    if (this.running) return { ok: false, code: 'already_running' };
    const cap = await this.deps.capability.detect();
    if (cap.state !== 'available' || !cap.containerId || !cap.imageRepo) {
      return { ok: false, code: 'not_available' };
    }
    this.running = true;
    this.current = {
      phase: 'backup',
      targetVersion,
      error: null,
      pull: null,
      startedAt: this.now(),
    };

    let backupPath: string;
    try {
      backupPath = this.deps.backup(targetVersion);
    } catch (err) {
      this.fail(`backup failed: ${err instanceof Error ? err.message : String(err)}`);
      return { ok: false, code: 'backup_failed' };
    }

    // Pull + launch run detached: the dashboard polls `status()`.
    void this.pullAndLaunch(cap, targetVersion, backupPath).catch((err: unknown) => {
      this.fail(err instanceof Error ? err.message : String(err));
    });
    return { ok: true };
  }

  private async pullAndLaunch(
    cap: SelfUpdateCapability,
    targetVersion: string,
    backupPath: string,
  ): Promise<void> {
    const repo = cap.imageRepo as string;
    const tag = cap.imageTag ?? 'latest';
    const engine = this.deps.engineFactory(this.socketPath);

    this.current.phase = 'pull';
    const layers = new Map<string, boolean>();
    await engine.pullImage(repo, tag, (ev: PullProgressEvent) => {
      if (!ev.id) return;
      const done = ev.status === 'Pull complete' || ev.status === 'Already exists';
      layers.set(ev.id, done || (layers.get(ev.id) ?? false));
      this.current.pull = {
        done: [...layers.values()].filter(Boolean).length,
        total: layers.size,
      };
    });

    this.current.phase = 'launch';
    const imageRef = `${repo}:${tag}`;
    const name = `rembric-upgrader-${this.now()}`;
    const created = await engine.createContainer(name, {
      Image: imageRef,
      Entrypoint: this.deps.helperEntrypoint ?? ['node', '/app/dist/scripts/upgrade-helper.js'],
      // Root inside the one-shot upgrader sidesteps host docker-GID
      // mismatches; it only ever talks to the socket it is handed.
      User: 'root',
      Env: [
        `REMBRIC_UPGRADE_TARGET_CONTAINER=${cap.containerId}`,
        `REMBRIC_UPGRADE_IMAGE=${imageRef}`,
        `REMBRIC_UPGRADE_VERSION=${targetVersion}`,
        // Path as seen from the host-side data volume; only used in
        // operator-facing recovery messages, never opened by the helper.
        `REMBRIC_UPGRADE_BACKUP=${backupPath}`,
      ],
      Labels: { 'rembric.upgrader': '1' },
      HostConfig: {
        Binds: [`${this.socketPath}:/var/run/docker.sock`],
        AutoRemove: false,
      },
    });
    await engine.startContainer(created.Id);
    this.log(`  ↑ self-update to v${targetVersion} handed off to upgrader ${name}`);
    this.current.phase = 'restarting';
    // `running` stays true: this process is now waiting to be replaced.
  }

  private fail(message: string): void {
    this.current.phase = 'failed';
    this.current.error = message;
    this.running = false;
  }
}
