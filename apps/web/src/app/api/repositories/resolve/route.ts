import {
  EXPLICIT_SELECTION_SOURCES,
  REPOSITORY_FINGERPRINT_RE,
  SLUG_REGEX,
  type RepositoryResolution,
} from '@rembric/core';
import { z } from 'zod';

import {
  authenticateRequest,
  domainErr,
  invalidInput,
  methodFallback,
  readJson,
} from '../../../../lib/api';
import { applyMcpRateLimit } from '../../../../lib/rate-limit';
import { getServices } from '../../../../lib/services';

export const dynamic = 'force-dynamic';

const resolveBody = z
  .object({
    fingerprint: z.string().regex(REPOSITORY_FINGERPRINT_RE).nullable(),
    remotes: z.array(z.string().max(512)).max(8),
    rootName: z
      .string()
      .max(255)
      .regex(/^[^/\\]*$/)
      .nullable()
      .optional(),
    explicit: z
      .object({
        slug: z.string().regex(SLUG_REGEX),
        source: z.enum(EXPLICIT_SELECTION_SOURCES),
      })
      .strict()
      .nullable()
      .optional(),
  })
  .strict();

export async function POST(request: Request): Promise<Response> {
  const auth = await authenticateRequest(request, undefined);
  if (!auth.ok) return auth.response;
  const { ctx } = auth;

  let limited: Response | null;
  try {
    limited = await applyMcpRateLimit(ctx.token.id, ctx.token.name);
  } catch (err) {
    return domainErr(err);
  }
  if (limited !== null) return limited;

  const read = await readJson(request);
  if (!read.ok) return read.response;
  const parsed = resolveBody.safeParse(read.body);
  if (!parsed.success) {
    return invalidInput(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    );
  }

  let resolution: RepositoryResolution;
  try {
    resolution = getServices().repositoryBindings.resolve(
      { tokenId: ctx.token.id, scope: ctx.scope, memberProjectIds: ctx.memberProjectIds },
      parsed.data,
    );
  } catch (err) {
    return domainErr(err);
  }

  if (resolution.outcome === 'ambiguous') {
    return Response.json(
      {
        ok: false,
        code: 'repository_ambiguous',
        message:
          'this repository is bound to several projects this token can read; select one with a .rembric file (PROJECT_SLUG=<slug>) or REMBRIC_PROJECT_SLUG',
        slugs: resolution.slugs,
      },
      { status: 409 },
    );
  }
  return Response.json({ ok: true, ...resolution });
}

export const GET = methodFallback;
export const PUT = methodFallback;
export const PATCH = methodFallback;
export const DELETE = methodFallback;
export const OPTIONS = methodFallback;
