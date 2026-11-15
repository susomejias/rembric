import {
  CAPTURE_TEXT_MAX_CODE_POINTS,
  captureKeyLearnings,
  isAuthorized,
  lastCodePoints,
  subagentLearningTags,
} from '@rembric/core';
import { projectScope } from '@rembric/db';

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
import { parseSessionLearnings } from '../../../../../../lib/validation';

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
  const scope = projectScope(project.id);
  if (!isAuthorized(ctx, 'write', { scope: 'project', projectId: project.id })) {
    return forbidden();
  }
  const deps = getServices();
  const blocked = rejectIfDeleted(deps.agentSessions, sessionId, ctx.token.id, project.id);
  if (blocked) return send(blocked.status, blocked.body);
  const read = await readJson(request);
  if (!read.ok) return read.response;
  const parsed = parseSessionLearnings(read.body);
  if (!parsed.ok) return invalidInput(parsed.message);
  try {
    const out = await captureKeyLearnings(
      { memory: deps.memory, ...deps.postSave },
      {
        text: lastCodePoints(parsed.data.report, CAPTURE_TEXT_MAX_CODE_POINTS),
        tags: subagentLearningTags(parsed.data.agentType),
        resolveSessionId: () => sessionId,
        source: { tokenName: ctx.token.name, agent: 'subagent' },
      },
      scope,
    );
    return Response.json({
      ok: true,
      saved: out.saved,
      skipped: out.skipped,
      ids: out.ids,
      candidatesDetected: out.candidatesDetected,
      ...(out.reason !== undefined ? { reason: out.reason } : {}),
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
