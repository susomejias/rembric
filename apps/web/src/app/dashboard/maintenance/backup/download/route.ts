import type { NextRequest } from 'next/server';

import { backupDownloadDenial, resolveBackupDownload, streamBackup } from '../../data';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function GET(request: NextRequest): Response {
  const denied = backupDownloadDenial(request);
  if (denied !== null) return denied;

  const resolved = resolveBackupDownload(null);
  if (!resolved.ok) return new Response(resolved.message, { status: resolved.status });
  return streamBackup(resolved.backup);
}
