import { readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { BACKUP_PREFIX as PRE_UPDATE_BACKUP_PREFIX, PromptsService } from '@rembric/core';
import { createDiagnostics, type DbDiagnostics } from '@rembric/db';

import { getServices } from '@/lib/services';

/**
 * The read layer of the maintenance view — every fs/PRAGMA read
 * `apps/server/src/dashboard/maintenance.ts` performed before rendering, and
 * nothing else. Ported rather than imported because `apps/server` is not a
 * dependency of this workspace.
 *
 * No mutation lives here on purpose: the three purges and the on-demand backup
 * are journaled writes whose boundary (admin scope + the mutation protection) is
 * a later slice, so this view renders their *state* and their disabled controls.
 */

/** On-demand snapshot prefix; the sweep shares the `backups/` directory. */
const ON_DEMAND_BACKUP_PREFIX = 'on-demand-';
/** On-demand snapshots kept by the writer — the number the card's copy states. */
export const ON_DEMAND_BACKUP_KEEP = 3;

/** Exact shape a downloadable backup filename must have — no path traversal. */
const BACKUP_FILENAME_RE = new RegExp(
  `^(?:${ON_DEMAND_BACKUP_PREFIX}|${PRE_UPDATE_BACKUP_PREFIX})[A-Za-z0-9._-]+\\.sqlite$`,
);

export interface Backup {
  file: string;
  createdAt: Date;
  sizeBytes: number;
  kind: 'on-demand' | 'pre-update';
}

export interface DbBreakdown {
  totalBytes: number;
  freelistBytes: number;
  perTable: { name: string; bytes: number; rowCount: number | null }[];
  source: 'dbstat' | 'row-counts';
}

export interface MaintenanceState {
  emptySessions: number;
  archivedMemories: number;
  deletedPrompts: number;
  breakdown: DbBreakdown;
  /** Every downloadable snapshot, newest first. */
  backups: Backup[];
  latestOnDemand: Backup | null;
  backupsDir: string;
}

const BREAKDOWN_TABLES = [
  'memory',
  'memory_vec',
  'memory_fts',
  'memory_relations',
  'sessions',
  'prompts',
  'confirmations',
  'consolidation_ops',
  'consolidation_runs',
  'tokens',
  'projects',
];

export function readMaintenanceState(withBytes: boolean): MaintenanceState {
  const services = getServices();
  const diagnostics = createDiagnostics(services.db);
  // `PromptsService` is not on the shared `Services` graph (only the `/api`
  // handlers this app serves so far need the others); it is stateless over
  // repositories, so building it here reads exactly the rows the retired view
  // read. Its permanent home is `lib/services.ts`.
  const prompts = new PromptsService(services.repos, services.db.db);

  const dir = backupsDir();
  const backups = listAllBackupsDesc(dir);

  return {
    emptySessions: services.agentSessions.countPurgeableEmpty(),
    archivedMemories: services.memory.countPurgeableDisconnectedArchived(),
    deletedPrompts: prompts.countPurgeableDeleted(),
    breakdown: readBreakdown(diagnostics, withBytes),
    backups,
    latestOnDemand: backups.find((b) => b.kind === 'on-demand') ?? null,
    backupsDir: dir,
  };
}

/**
 * Same resolution as `lib/db.ts` and `apps/server/src/config.ts`:
 * `REMBRIC_DATA_DIR`, default `~/.rembric`. Read per call, never at module
 * scope, so a build-time import can neither bake nor create a data directory.
 */
export function resolveDataDir(): string {
  return process.env['REMBRIC_DATA_DIR'] ?? join(homedir(), '.rembric');
}

function backupsDir(): string {
  return join(resolveDataDir(), 'backups');
}

function listAllBackupsDesc(dir: string): Backup[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    // No `backups/` yet is the normal first-run state, not an error.
    return [];
  }
  return files
    .filter((f) => BACKUP_FILENAME_RE.test(f))
    .map((f): Backup => {
      const stat = statSync(join(dir, f));
      return {
        file: f,
        createdAt: stat.mtime,
        sizeBytes: stat.size,
        kind: f.startsWith(PRE_UPDATE_BACKUP_PREFIX) ? 'pre-update' : 'on-demand',
      };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

/** `withBytes` runs `dbstat`, which walks every page — opt-in, not per render. */
function readBreakdown(diagnostics: DbDiagnostics, withBytes: boolean): DbBreakdown {
  const size = diagnostics.readDbSize();
  const perTable: DbBreakdown['perTable'] = [];
  let source: DbBreakdown['source'] = 'row-counts';

  const byName = withBytes ? diagnostics.readDbstatBytes() : null;
  if (byName && byName.size > 0) {
    source = 'dbstat';
    for (const t of BREAKDOWN_TABLES) {
      const bytes = byName.get(t);
      if (bytes == null) continue;
      perTable.push({ name: t, bytes, rowCount: diagnostics.countTableRows(t) });
    }
    perTable.sort((a, b) => b.bytes - a.bytes);
  }

  if (perTable.length === 0) {
    for (const t of BREAKDOWN_TABLES) {
      const rowCount = diagnostics.countTableRows(t);
      if (rowCount == null) continue;
      perTable.push({ name: t, bytes: 0, rowCount });
    }
    perTable.sort((a, b) => (b.rowCount ?? 0) - (a.rowCount ?? 0));
  }

  return {
    totalBytes: size.totalBytes,
    freelistBytes: size.freelistBytes,
    perTable,
    source,
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
