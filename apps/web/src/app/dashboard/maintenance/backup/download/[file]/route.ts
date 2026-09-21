import type { NextRequest } from 'next/server';

import { backupDownloadDenial, resolveBackupDownload, streamBackup } from '../../../data';

/**
 * `GET /dashboard/maintenance/backup/download/:file` — any snapshot in
 * `backups/` by name, including the pre-update snapshot the self-update flow
 * takes before every upgrade. `maintenance.ts`'s `/backup/download/:file` route.
 *
 * The filename is the only untrusted input, and `resolveBackupDownload` refuses
 * anything outside `BACKUP_FILENAME_RE` — the exact producer-generated shape, so
 * no `/` and no `..` reaches `join`. A name that passes the shape but is not on
 * disk is a 404, never a second stat-and-serve path.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ file: string }> },
): Promise<Response> {
  const denied = backupDownloadDenial(request);
  if (denied !== null) return denied;

  const { file } = await params;
  const resolved = resolveBackupDownload(file);
  if (!resolved.ok) return new Response(resolved.message, { status: resolved.status });
  return streamBackup(resolved.backup);
}
