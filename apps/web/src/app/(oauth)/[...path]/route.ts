import { notFound } from 'next/navigation';

import { handleOAuthRequest, isOAuthPath } from '../../../lib/oauth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ path?: string[] }> };

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const { path } = await context.params;
  const pathname = `/${(path ?? []).join('/')}`;
  if (!isOAuthPath(pathname)) notFound();
  return handleOAuthRequest(request, pathname);
}

export const GET = handle;
export const POST = handle;
export const PUT = handle;
export const PATCH = handle;
export const DELETE = handle;
export const HEAD = handle;
export const OPTIONS = handle;
