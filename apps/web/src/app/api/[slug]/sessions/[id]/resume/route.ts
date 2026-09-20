import { DomainError, isAuthorized } from '@rembric/core';

import {
  authenticateRequest,
  domainErr,
  forbidden,
  invalidInput,
  methodFallback,
  projectNotFound,
  readJson,
  rejectIfDeleted,
  send,
} from '../../../../../../lib/api';
import { getServices } from '../../../../../../lib/services';
import { parseSessionResume } from '../../../../../../lib/validation';

export const dynamic = 'force-dynamic';

/** `POST /api/:slug/sessions/:id/resume` — mirrors `api-router.ts`'s resume handler. */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ slug: string; id: string }> },
): Promise<Response> {
  const { slug, id: sessionId } = await params;
  const auth = await authenticateRequest(request, slug);
  if (!auth.ok) return auth.response;
  const { ctx } = auth;
  const { project } = ctx;
  if (!project) return projectNotFound(slug);
  if (!isAuthorized(ctx, 'write', { scope: 'project', projectId: project.id })) {
    return forbidden();
  }
  const deps = getServices();
  const blocked = rejectIfDeleted(deps.agentSessions, sessionId, ctx.token.id, project.id);
  if (blocked) return send(blocked.status, blocked.body);
  const parsed = parseSessionResume((await readJson(request)) ?? {});
  if (!parsed.ok) return invalidInput(parsed.message);
  try {
    // Re-read rather than reuse the boundary check, which returns null on
    // success: `previousEndedAt` is the only report of a value the update
    // discards and the server does not retain.
    const before = deps.agentSessions.getById(sessionId);
    if (!before) {
      throw new DomainError('session_not_found', `session '${sessionId}' not found`);
    }
    const resumed = deps.agentSessions.resume(sessionId, { tokenId: ctx.token.id });
    return Response.json({
      ok: true,
      sessionId: resumed.id,
      status: resumed.status,
      startedAt: resumed.startedAt.toISOString(),
      resumedAt: (resumed.lastActivityAt ?? resumed.startedAt).toISOString(),
      previousStatus: before.status,
      previousEndedAt: before.endedAt?.toISOString() ?? null,
      title: resumed.title,
    });
  } catch (err) {
    return domainErr(err);
  }
}

export const GET = methodFallback;
export const PUT = methodFallback;
export const PATCH = methodFallback;
export const DELETE = methodFallback;
export const OPTIONS = methodFallback;
