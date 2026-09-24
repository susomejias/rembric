import { join } from 'node:path';

import {
  CapabilityDetector,
  createPreUpdateBackup,
  DockerEngineApi,
  SelfUpdateOrchestrator,
  type SelfUpdateCapability,
  type StartResult,
  type UpdatePhase,
  type UpdateStatus,
} from '@rembric/core';
import { createDiagnostics } from '@rembric/db';

import { resolveDataDir } from '../maintenance/data';

import { updatePreviewVersion } from './update-service';

import { getServices } from '@/lib/services';

export interface SelfUpdater {
  status(): UpdateStatus;
  capability(): Promise<SelfUpdateCapability>;
  start(targetVersion: string): Promise<StartResult>;
}

const globalForSelfUpdate = globalThis as typeof globalThis & {
  __rembricSelfUpdate?: SelfUpdateOrchestrator;
};

const PREVIEW_PHASE_ENV = 'REMBRIC_UPDATE_PREVIEW_PHASE';
const RUNNING_PHASES: readonly UpdatePhase[] = ['backup', 'pull', 'launch', 'restarting'];
const PREVIEW_PULL = { done: 3, total: 9 };

export function isUpdateRunning(status: UpdateStatus): boolean {
  return RUNNING_PHASES.some((phase) => phase === status.phase);
}

export function getSelfUpdate(): SelfUpdater {
  const preview = updatePreviewVersion();
  return preview === null ? realSelfUpdate() : previewSelfUpdater(preview);
}

export function updatePreviewPhase(): UpdatePhase | null {
  const value = process.env[PREVIEW_PHASE_ENV]?.trim();
  if (value === undefined || !isUpdatePhase(value)) return null;
  return value;
}

function isUpdatePhase(value: string): value is UpdatePhase {
  return RUNNING_PHASES.some((phase) => phase === value);
}

function realSelfUpdate(): SelfUpdateOrchestrator {
  const cached = globalForSelfUpdate.__rembricSelfUpdate;
  if (cached !== undefined) return cached;

  const built = new SelfUpdateOrchestrator({
    capability: new CapabilityDetector({ env: process.env }),
    engineFactory: (socketPath) => new DockerEngineApi(socketPath),
    backup: createPreUpdateBackup({
      vacuumInto: (dest) => createDiagnostics(getServices().db).vacuumInto(dest),
      backupsDir: join(resolveDataDir(), 'backups'),
    }),
    upgradeHealthTimeoutMs: process.env['REMBRIC_UPGRADE_HEALTH_TIMEOUT_MS'],
  });
  globalForSelfUpdate.__rembricSelfUpdate = built;
  return built;
}

function previewSelfUpdater(latestVersion: string): SelfUpdater {
  const phase = updatePreviewPhase() ?? 'idle';
  const running = phase !== 'idle';

  return {
    status: () => ({
      phase,
      targetVersion: running ? latestVersion : null,
      error: null,
      pull: phase === 'pull' ? { ...PREVIEW_PULL } : null,
      startedAt: running ? Date.now() : null,
    }),
    capability: () =>
      Promise.resolve({
        state: 'available',
        reason: 'ok',
        containerId: 'preview',
        imageRepo: 'ghcr.io/susomejias/rembric',
        imageTag: 'latest',
      }),
    start: () => Promise.resolve({ ok: false, code: 'not_available' }),
  };
}
