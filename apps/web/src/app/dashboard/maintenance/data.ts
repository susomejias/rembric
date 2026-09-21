import { createReadStream, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import { BACKUP_PREFIX as PRE_UPDATE_BACKUP_PREFIX } from '@rembric/core';
import { createDiagnostics, type DbDiagnostics } from '@rembric/db';

// Relative, not the `@/` alias the dashboard pages use: this module is reached
// by `apps/web` tests (the download routes' contract lives in it) and the test
// project has no `@` alias. The `src/app/api/**` handlers import the same way.
import { getServices } from '../../../lib/services';
import { getSession, type SessionCookieSource } from '../../../lib/session';

/**
 * The maintenance view's read layer — every fs/PRAGMA read
 * `apps/server/src/dashboard/maintenance.ts` performed before rendering — plus
 * the on-demand snapshot writer and the two download handlers it streamed.
 * Ported rather than imported because `apps/server` is not a dependency of this
 * workspace.
 *
 * The three purges live in the page's Server Actions; the snapshot and the
 * downloads live here because both are pure fs work over `backupsDir()`, with
 * no service graph beyond `Services.prompts` (the count the page renders).
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

/** The same row with the path on disk — what the two download handlers stream from. */
export interface BackupFile extends Backup {
  path: string;
}

/**
 * The outcome of resolving a download request. `invalid` is the
 * `BACKUP_FILENAME_RE` refusal (the path-traversal gate) and `missing` the
 * `statSync` miss; both keep the caller's message and status in one place.
 */
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

function listAllBackupsDesc(dir: string): BackupFile[] {
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    // No `backups/` yet is the normal first-run state, not an error.
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

/** On-demand filenames newest-first — the `on-demand-<ms>` name sorts chronologically. */
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

/** The newest on-demand snapshot, or `null` when none exists — the `/download` target. */
export function latestOnDemandBackup(): BackupFile | null {
  return listAllBackupsDesc(backupsDir()).find((b) => b.kind === 'on-demand') ?? null;
}

/**
 * Snapshot the live DB via `VACUUM INTO` and prune older on-demand backups —
 * `maintenance.ts::createOnDemandBackup`. Retention is best-effort: a file that
 * cannot be unlinked never fails the backup that was already written.
 */
export function createOnDemandBackup(): BackupFile {
  const dir = backupsDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = `${ON_DEMAND_BACKUP_PREFIX}${Date.now()}.sqlite`;
  const path = join(dir, file);
  createDiagnostics(getServices().db).vacuumInto(path);

  for (const older of listOnDemandBackupsDesc(dir).slice(ON_DEMAND_BACKUP_KEEP)) {
    try {
      unlinkSync(join(dir, older));
    } catch {
      // Retention is best-effort; never fail the backup over it.
    }
  }

  const stat = statSync(path);
  return { file, path, createdAt: stat.mtime, sizeBytes: stat.size, kind: 'on-demand' };
}

/**
 * Resolve one download request. `file === null` is the latest-on-demand route
 * (`POST`-written snapshots only). `BACKUP_FILENAME_RE` is the ONLY gate on the
 * by-name route: it pins the exact producer-generated shape — no `/`, no `..` —
 * so a filename taken straight from the URL has no path-traversal surface.
 */
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

/**
 * The admin gate both download handlers run first — `requireAdmin` from the
 * retired router, minus the Hono context: a missing session is the login
 * redirect `dashboard-router.ts` answered with, and a non-admin session the 403
 * its forbidden page carried. `null` means admitted.
 */
export function backupDownloadDenial(request: {
  url: string;
  cookies: SessionCookieSource;
}): Response | null {
  const session = getSession(request.cookies);
  if (session === null) return Response.redirect(new URL('/dashboard/login', request.url), 302);
  if (session.scope !== '*') {
    return new Response('This view requires an admin-scoped token.', { status: 403 });
  }
  return null;
}

/**
 * Stream a snapshot as an attachment. Streamed, never `readFileSync`: the file
 * scales with the whole memory corpus, so a full read would spike memory on
 * large installs — `maintenance.ts::streamBackup`.
 */
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
