import type { NextRequest } from 'next/server';

import { backupDownloadDenial, resolveBackupDownload, streamBackup } from '../../../data';

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
