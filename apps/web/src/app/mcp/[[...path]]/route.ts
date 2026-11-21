import {
  hostHeaderValidationResponse,
  originValidationResponse,
} from '@modelcontextprotocol/server';
import { runWithContext } from '@rembric/core';

import { clientIdentity } from '../../../lib/client-identity';
import {
  readDeclaredSessionHeader,
  readRepoFingerprintHeader,
  verifyMcpBearerToken,
} from '../../../lib/mcp-auth';
import { getMcpSurface } from '../../../lib/mcp-server';
import { applyMcpRateLimit } from '../../../lib/rate-limit';
import { getServices } from '../../../lib/services';

export const dynamic = 'force-dynamic';

type RouteContext = { params: Promise<{ path?: string[] }> };

async function handle(request: Request, context: RouteContext): Promise<Response> {
  const rebinding = dnsRebindingRefusal(request);
  if (rebinding !== undefined) return rebinding;

  const { path } = await context.params;
  const slug = path?.[0] ?? null;

  if (slug !== null && !isValidSlug(slug)) {
    return Response.json(
      {
        ok: false,
        code: 'invalid_project_slug',
        message: `project slug '${slug}' must match /^[a-zA-Z0-9_.-]+$/`,
      },
      { status: 400 },
    );
  }

  const fingerprint = readRepoFingerprintHeader(request.headers);
  if (!fingerprint.ok) return fingerprint.response;

  const auth = await verifyMcpBearerToken({
    authorization: request.headers.get('authorization'),
    slug,
    identity: clientIdentity(request),
    services: getServices(),
    repository: fingerprint.repository,
    declaredSessionId: readDeclaredSessionHeader(request.headers),
  });
  if (!auth.ok) return auth.response;

  let rateLimitResponse: Response | null;
  try {
    rateLimitResponse = await applyMcpRateLimit(
      auth.requestContext.token.id,
      auth.requestContext.token.name,
    );
  } catch (err) {
    console.error('[mcp] rate limiter failed', err);
    return Response.json(
      { ok: false, code: 'internal_error', message: 'An unexpected error occurred.' },
      { status: 500 },
    );
  }
  if (rateLimitResponse !== null) return rateLimitResponse;

  const { authInfo, requestContext } = auth;

  return runWithContext(requestContext, () => getMcpSurface().fetch(request, { authInfo }));
}

function dnsRebindingRefusal(request: Request): Response | undefined {
  const hosts = allowedHostnames('REMBRIC_MCP_ALLOWED_HOSTS');
  const origins = allowedHostnames('REMBRIC_MCP_ALLOWED_ORIGINS');
  return (
    (hosts && hostHeaderValidationResponse(request, hosts)) ??
    (origins && originValidationResponse(request, origins))
  );
}

function allowedHostnames(name: string): string[] | undefined {
  const entries = (process.env[name] ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return entries.length > 0 ? entries.map(hostnameOf) : undefined;
}

function hostnameOf(entry: string): string {
  for (const candidate of [entry, `http://${entry}`]) {
    const hostname = URL.canParse(candidate) ? new URL(candidate).hostname : '';
    if (hostname.length > 0) return hostname;
  }
  return entry;
}

export const GET = handle;
export const POST = handle;
export const DELETE = handle;

const SLUG_RE = /^[a-zA-Z0-9_.-]+$/;
function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 128 && SLUG_RE.test(slug);
}
