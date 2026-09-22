import {
  adminRequired,
  authenticateRequest,
  methodFallback,
  projectNotFound,
} from '../../../../../lib/api';
import { getServices } from '../../../../../lib/services';

export const dynamic = 'force-dynamic';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const auth = await authenticateRequest(request, slug);
  if (!auth.ok) return auth.response;
  const { ctx } = auth;
  if (!ctx.project) return projectNotFound(slug);
  if (ctx.scope !== '*') return adminRequired();
  const deps = getServices();
  return Response.json({
    ok: true,
    counters: deps.usageCounters.snapshot(),
    recall: deps.usageCounters.recallSnapshot(),
  });
}

export const POST = methodFallback;
export const PUT = methodFallback;
export const PATCH = methodFallback;
export const DELETE = methodFallback;
export const OPTIONS = methodFallback;
