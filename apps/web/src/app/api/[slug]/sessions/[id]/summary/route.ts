import { isAuthorized, truncateSummary, truncateTitle } from '@rembric/core';

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
import { parseSessionSummary } from '../../../../../../lib/validation';

export const dynamic = 'force-dynamic';

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
  const parsed = parseSessionSummary(await readJson(request));
  if (!parsed.ok) return invalidInput(parsed.message);
  try {
    const { row: updated } = deps.agentSessions.writeSummary(sessionId, {
      tokenId: ctx.token.id,
      summary: truncateSummary(parsed.data.summary),
      title: parsed.data.title === undefined ? undefined : truncateTitle(parsed.data.title),
      final: parsed.data.final,
    });
    return Response.json({
      ok: true,
      sessionId: updated.id,
      summary: updated.summary,
      title: updated.title,
      summaryFinal: updated.summaryFinal,
      titleFinal: updated.titleFinal,
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
