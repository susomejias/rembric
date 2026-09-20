import { isAuthorized, truncateTitle } from '@rembric/core';

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
import { parseSessionTurn } from '../../../../../../lib/validation';

export const dynamic = 'force-dynamic';

/** `POST /api/:slug/sessions/:id/turn` — mirrors `api-router.ts`'s turn handler. */
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
  const parsed = parseSessionTurn(await readJson(request));
  if (!parsed.ok) return invalidInput(parsed.message);
  try {
    const result = deps.agentSessions.reportTurn(sessionId, {
      tokenId: ctx.token.id,
      usedTools: parsed.data.usedTools,
      title: parsed.data.title === undefined ? undefined : truncateTitle(parsed.data.title),
    });
    // `lines` MUST stay the last key: the hooks' no-jq fallback
    // (`apps/plugin/scripts/_api.sh::rembric_turn_report`) reads it with a
    // greedy `sed` that runs to the LAST `]` in the body, so any key added
    // after it would be emitted to the agent as extra nudge lines.
    return Response.json({ ok: true, sessionId: result.session.id, lines: result.lines });
  } catch (err) {
    return domainErr(err);
  }
}

export const GET = methodFallback;
export const PUT = methodFallback;
export const PATCH = methodFallback;
export const DELETE = methodFallback;
export const OPTIONS = methodFallback;
