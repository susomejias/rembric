import { isAuthorized } from '@rembric/core';

import {
  authenticateRequest,
  domainErr,
  forbidden,
  invalidInput,
  methodFallback,
  projectNotFound,
  readJson,
} from '../../../../lib/api';
import { getServices } from '../../../../lib/services';
import { parseSessionPost } from '../../../../lib/validation';

// Every handler under this surface reads and writes the live database; a cached
// response would be a stale session row.
export const dynamic = 'force-dynamic';

/** `POST /api/:slug/sessions` — mirrors `api-router.ts`'s ensure handler. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<Response> {
  const { slug } = await params;
  const auth = await authenticateRequest(request, slug);
  if (!auth.ok) return auth.response;
  const { ctx } = auth;
  const { project } = ctx;
  if (!project) return projectNotFound(slug);
  if (!isAuthorized(ctx, 'write', { scope: 'project', projectId: project.id })) {
    return forbidden();
  }
  const parsed = parseSessionPost(await readJson(request));
  if (!parsed.ok) return invalidInput(parsed.message);
  const deps = getServices();
  try {
    const result = deps.agentSessions.ensure({
      id: parsed.data.id,
      tokenId: ctx.token.id,
      projectId: project.id,
      agent: parsed.data.agent ?? 'unknown',
      description: parsed.data.description ?? null,
      cwd: parsed.data.cwd ?? null,
    });
    deps.sweep(project.id);
    return Response.json({
      ok: true,
      sessionId: result.session.id,
      scope: 'project' as const,
      projectId: project.id,
      startedAt: result.session.startedAt.toISOString(),
      title: result.session.title,
      created: result.created,
    });
  } catch (err) {
    return domainErr(err);
  }
}

// api-router's `app.all('/*')` fallback: this path declares POST, so any other
// method answers the router's `not_found` body instead of Next's 405.
export const GET = methodFallback;
export const PUT = methodFallback;
export const PATCH = methodFallback;
export const DELETE = methodFallback;
export const OPTIONS = methodFallback;
