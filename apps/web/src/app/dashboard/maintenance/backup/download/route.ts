import type { NextRequest } from 'next/server';

import { backupDownloadDenial, resolveBackupDownload, streamBackup } from '../../data';

/**
 * `GET /dashboard/maintenance/backup/download` — the latest on-demand snapshot,
 * streamed as an attachment. `maintenance.ts`'s unbounded `/backup/download`
 * route.
 *
 * Node runtime, and not by default: the body is a `node:fs` read stream and the
 * session check needs the SQLite handle. `middleware.ts` already refuses an
 * unauthenticated `/dashboard` request; the gate below adds main's second
 * condition — the token behind the session must be admin-scoped — because the
 * snapshot is the whole database.
 */

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest): Response {
  const denied = backupDownloadDenial(request);
  if (denied !== null) return denied;

  const resolved = resolveBackupDownload(null);
  if (!resolved.ok) return new Response(resolved.message, { status: resolved.status });
  return streamBackup(resolved.backup);
}
