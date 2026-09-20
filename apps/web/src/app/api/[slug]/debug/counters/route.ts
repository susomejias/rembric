import {
  adminRequired,
  authenticateRequest,
  methodFallback,
  projectNotFound,
} from '../../../../../lib/api';
import { getServices } from '../../../../../lib/services';

export const dynamic = 'force-dynamic';

/**
 * `GET /api/:slug/debug/counters` — mirrors `api-router.ts`'s admin-only debug
 * surface. The map is process-wide per token, so the body is NOT slug-scoped,
 * but the slug must still resolve so a typo behaves like everywhere else. A
 * non-admin token is refused before anything is read: the counter map names
 * tokens by id, which is itself privileged.
 */
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

// api-router's `app.all('/*')` fallback: this path declares GET, so any other
// method answers the router's `not_found` body instead of Next's 405.
export const POST = methodFallback;
export const PUT = methodFallback;
export const PATCH = methodFallback;
export const DELETE = methodFallback;
export const OPTIONS = methodFallback;
