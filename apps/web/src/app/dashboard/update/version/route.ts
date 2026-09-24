import type { NextRequest } from 'next/server';

import { resolveDashboardSession } from '@/lib/session';
import { REMBRIC_VERSION } from '@/lib/version';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(_request: NextRequest): Promise<Response> {
  const session = await resolveDashboardSession();
  if (session === null) return Response.json({ ok: false }, { status: 401 });
  return Response.json({ version: REMBRIC_VERSION });
}
