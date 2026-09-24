import { join } from 'node:path';

import {
  CapabilityDetector,
  createPreUpdateBackup,
  DockerEngineApi,
  SelfUpdateOrchestrator,
  type UpdatePhase,
  type UpdateStatus,
} from '@rembric/core';
import { createDiagnostics } from '@rembric/db';

import { resolveDataDir } from '../maintenance/data';

import { getServices } from '@/lib/services';

const globalForSelfUpdate = globalThis as typeof globalThis & {
  __rembricSelfUpdate?: SelfUpdateOrchestrator;
};

const RUNNING_PHASES: readonly UpdatePhase[] = ['backup', 'pull', 'launch', 'restarting'];

export function isUpdateRunning(status: UpdateStatus): boolean {
  return RUNNING_PHASES.some((phase) => phase === status.phase);
}

export function getSelfUpdate(): SelfUpdateOrchestrator {
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
