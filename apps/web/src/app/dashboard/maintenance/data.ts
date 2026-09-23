import { createReadStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { BACKUP_PREFIX as PRE_UPDATE_BACKUP_PREFIX } from '@rembric/core';
import { createDiagnostics, type DbDiagnostics } from '@rembric/db';

import { relativeRedirect } from '../../../lib/http-redirect';
import { getServices } from '../../../lib/services';
import { getSession, type SessionCookieSource } from '../../../lib/session';

const ON_DEMAND_BACKUP_PREFIX = 'on-demand-';

export const ON_DEMAND_BACKUP_KEEP = 3;

const BACKUP_FILENAME_RE = new RegExp(
  `^(?:${ON_DEMAND_BACKUP_PREFIX}|${PRE_UPDATE_BACKUP_PREFIX})[A-Za-z0-9._-]+\\.sqlite$`,
);

export interface Backup {
  file: string;
  createdAt: Date;
  sizeBytes: number;
  kind: 'on-demand' | 'pre-update';
}

export interface BackupFile extends Backup {
  path: string;
}

export type BackupDownload =
  | { ok: true; backup: BackupFile }
  | { ok: false; status: 400 | 404; message: string };

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

  const dir = backupsDir();
  const backups = listAllBackupsDesc(dir);

  return {
    emptySessions: services.agentSessions.countPurgeableEmpty(),
    archivedMemories: services.memory.countPurgeableDisconnectedArchived(),
    deletedPrompts: services.prompts.countPurgeableDeleted(),
    breakdown: readBreakdown(diagnostics, withBytes),
    backups,
    latestOnDemand: backups.find((b) => b.kind === 'on-demand') ?? null,
    backupsDir: dir,
  };
}

export function resolveDataDir(): string {
  return process.env['REMBRIC_DATA_DIR'] ?? join(homedir(), '.rembric');
}

function backupsDir(): string {
  return join(resolveDataDir(), 'backups');
}

function listAllBackupsDesc(dir: string): BackupFile[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => BACKUP_FILENAME_RE.test(f))
    .map((f): BackupFile => {
      const path = join(dir, f);
      const stat = statSync(path);
      return {
        file: f,
        path,
        createdAt: stat.mtime,
        sizeBytes: stat.size,
        kind: f.startsWith(PRE_UPDATE_BACKUP_PREFIX) ? 'pre-update' : 'on-demand',
      };
    })
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

function listOnDemandBackupsDesc(dir: string): string[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  return files
    .filter((f) => f.startsWith(ON_DEMAND_BACKUP_PREFIX) && f.endsWith('.sqlite'))
    .sort()
    .reverse();
}

export function latestOnDemandBackup(): BackupFile | null {
  return listAllBackupsDesc(backupsDir()).find((b) => b.kind === 'on-demand') ?? null;
}

export function createOnDemandBackup(): BackupFile {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = `${ON_DEMAND_BACKUP_PREFIX}${Date.now()}.sqlite`;
  const path = join(dir, file);
  createDiagnostics(getServices().db).vacuumInto(path);

  for (const older of listOnDemandBackupsDesc(dir).slice(ON_DEMAND_BACKUP_KEEP)) {
    try {
      unlinkSync(join(dir, older));
    } catch {}
  }
  const stat = statSync(path);
  return { file, path, createdAt: stat.mtime, sizeBytes: stat.size, kind: 'on-demand' };
}

export function resolveBackupDownload(file: string | null): BackupDownload {
  if (file === null) {
    const latest = latestOnDemandBackup();
    if (latest === null)
      return { ok: false, status: 404, message: 'No on-demand backup exists yet.' };
    return { ok: true, backup: latest };
  }
  if (!BACKUP_FILENAME_RE.test(file)) {
    return { ok: false, status: 400, message: 'Not a valid backup filename.' };
  }
  const path = join(backupsDir(), file);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(path);
  } catch {
    return { ok: false, status: 404, message: 'That backup no longer exists.' };
  }
  return {
    ok: true,
    backup: {
      file,
      path,
      createdAt: stat.mtime,
      sizeBytes: stat.size,
      kind: file.startsWith(PRE_UPDATE_BACKUP_PREFIX) ? 'pre-update' : 'on-demand',
    },
  };
}

export function backupDownloadDenial(request: { cookies: SessionCookieSource }): Response | null {
  const session = getSession(request.cookies);
  if (session === null) return relativeRedirect('/dashboard/login');
  if (session.scope !== '*') {
    return new Response('This view requires an admin-scoped token.', { status: 403 });
  }
  return null;
}

export function streamBackup(backup: BackupFile): Response {
  const body = Readable.toWeb(createReadStream(backup.path)) as ReadableStream<Uint8Array>;
  return new Response(body, {
    status: 200,
    headers: {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(backup.sizeBytes),
      'Content-Disposition': `attachment; filename="${backup.file}"`,
    },
  });
}

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
