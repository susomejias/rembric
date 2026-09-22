import { isAuthorized } from '@rembric/core';
import { projectScope } from '@rembric/db';

import {
  authenticateRequest,
  domainErr,
  forbidden,
  invalidInput,
  methodFallback,
  projectNotFound,
  readJson,
  snippet,
} from '../../../../../lib/api';
import { getServices } from '../../../../../lib/services';
import { parseMemoryRecall } from '../../../../../lib/validation';

export const dynamic = 'force-dynamic';

const RECALL_SNIPPET_CHARS = 240;

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
  if (!isAuthorized(ctx, 'read', { scope: 'project', projectId: project.id })) {
    return forbidden();
  }
  const parsed = parseMemoryRecall(await readJson(request));
  if (!parsed.ok) return invalidInput(parsed.message);
  const deps = getServices();
  const limit = Math.min(parsed.data.limit ?? 5, 5);
  try {
    const rows = await deps.memory.search(
      { query: parsed.data.query, limit },
      projectScope(project.id),
    );
    const memories = rows.map((m) => ({
      id: m.id,
      title: m.title,
      snippet: snippet(m.content, RECALL_SNIPPET_CHARS),
    }));
    const formatted =
      memories.length === 0
        ? ''
        : `<memory-context>\n${memories.map((m) => `- ${m.title}: ${m.snippet}`).join('\n')}\n</memory-context>`;
    return Response.json({ ok: true, memories, formatted });
  } catch (err) {
    return domainErr(err);
  }
}

export const GET = methodFallback;
export const PUT = methodFallback;
export const PATCH = methodFallback;
export const DELETE = methodFallback;
export const OPTIONS = methodFallback;
