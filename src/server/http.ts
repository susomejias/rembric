import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { getRequestListener } from '@hono/node-server';
import { Hono, type Context } from 'hono';

import type { DbHandle } from '../db/client.js';
import { type McpTransportManager } from '../mcp/index.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import type { ProjectsService } from '../services/projects.js';
import type { TokensService } from '../services/tokens.js';
import { REMBRIC_VERSION } from '../version.js';

import { createApiRouter } from './api-router.js';
import { AuthError, authenticate } from './auth.js';
import { createDashboardRouter, type DashboardDeps } from './dashboard-router.js';
import type { RateLimiter } from './rate-limit.js';
import { runWithContext } from './request-context.js';

/**
 * HTTP layer.
 *
 * Two surfaces share one TCP port:
 *   - `/mcp(*)` is handled directly by the MCP SDK's StreamableHTTP
 *     transport, with raw IncomingMessage / ServerResponse threaded through.
 *   - everything else (`/dashboard*`, `/healthz`, etc.) is served by a
 *     Hono app via `@hono/node-server`'s getRequestListener.
 *
 * Splitting this way keeps Hono out of the MCP request path (where its
 * Response-object model fights against the transport's streaming writes)
 * while still letting the dashboard use Hono's routing and middleware.
 */

export interface CreateHttpServerOptions {
  host: string;
  port: number;
  mcp: McpTransportManager;
  tokens: TokensService;
  projects: ProjectsService;
  dashboard: DashboardDeps;
  agentSessions: AgentSessionsService;
  /** Database handle; used by `/healthz` to ping with `SELECT 1`. */
  db: DbHandle;
  /** Optional per-token rate limiter applied before MCP transport handoff. */
  rateLimiter?: RateLimiter | null;
  /**
   * Triggers a consolidation pass on demand. Wired by the bootstrapper
   * to the in-process ConsolidationRunner; exposed over HTTP via
   * `POST /admin/consolidation/run` (also the dashboard button at
   * `/dashboard/consolidation`).
   */
  triggerConsolidation?: (opts: { orphansOnly?: boolean }) => Promise<unknown>;
}

export interface HttpServerHandle {
  server: Server;
  /** Resolves when the listener has stopped. */
  close: () => Promise<void>;
  /** Effective URL the server is listening on. */
  url: string;
}

export async function startHttpServer(opts: CreateHttpServerOptions): Promise<HttpServerHandle> {
  const honoApp = new Hono();

  honoApp.get(
    '/healthz',
    createHealthzHandler({ tokens: opts.tokens, projects: opts.projects, db: opts.db }),
  );
  honoApp.get('/', (c) => c.redirect('/dashboard'));

  honoApp.route('/dashboard', createDashboardRouter(opts.dashboard));

  // HTTP session-lifecycle API. Used by the Claude Code / Codex plugin's
  // `command`-type hooks to create/summarize/end sessions without going
  // through MCP. Auth is identical to `/mcp` — same bearer token, same
  // `authenticate()` helper. See `api-router.ts` and the
  // `http-api` capability spec.
  honoApp.route(
    '/api',
    createApiRouter({
      agentSessions: opts.agentSessions,
      tokens: opts.tokens,
      projects: opts.projects,
    }),
  );

  // Admin endpoints. Require an admin-scope bearer token. Only one for
  // now: trigger a consolidation pass. Kept off the MCP surface because
  // the operation is privileged and we don't want it advertised over
  // MCP tool listing.
  if (opts.triggerConsolidation) {
    const trigger = opts.triggerConsolidation;
    honoApp.post('/admin/consolidation/run', async (c) => {
      const authz = c.req.header('authorization');
      const adminCheck = adminAuth(authz, opts.tokens);
      if (adminCheck !== null) {
        return c.json(
          { ok: false, code: adminCheck.code, message: adminCheck.message },
          adminCheck.status,
        );
      }
      try {
        const mode = c.req.query('mode');
        const orphansOnly = mode === 'orphans-only';
        const result = await trigger({ orphansOnly });
        return c.json({ ok: true, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ ok: false, code: 'internal_error', message }, 500);
      }
    });
  }

  honoApp.notFound((c) => c.json({ ok: false, code: 'not_found', path: c.req.path }, 404));

  const honoListener = getRequestListener(honoApp.fetch);

  const server = createNodeServer((req, res) => {
    const rawUrl = req.url ?? '/';
    const pathname = parsePathname(rawUrl);
    if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
      void handleMcpRequest(req, res, opts, pathname).catch((err: unknown) => {
        respondInternal(res, err);
      });
      return;
    }
    void honoListener(req, res);
  });

  await new Promise<void>((resolve) => {
    server.listen(opts.port, opts.host, () => resolve());
  });

  return {
    server,
    url: `http://${opts.host}:${opts.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        opts.mcp.close();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

export interface HealthzDeps {
  tokens: TokensService;
  projects: ProjectsService;
  db: DbHandle;
}

export function createHealthzHandler(deps: HealthzDeps) {
  return (c: Context) => {
    const authz = c.req.header('authorization');
    if (authz === undefined) {
      return c.json(
        { ok: false, code: 'missing_token' as const, message: 'missing Authorization header' },
        401,
      );
    }
    try {
      authenticate({
        authorization: authz,
        pathSlug: undefined,
        tokens: deps.tokens,
        projects: deps.projects,
      });
      deps.db.raw.prepare('SELECT 1').get();
      return c.json({ ok: true, version: REMBRIC_VERSION });
    } catch (err) {
      if (err instanceof AuthError) {
        return c.json({ ok: false, code: err.code, message: err.message }, err.status);
      }
      return c.json({ ok: false, code: 'db_unavailable' as const }, 503);
    }
  };
}

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: CreateHttpServerOptions,
  pathname: string,
): Promise<void> {
  // 0. Extract project slug from the URL path, if any. The header
  // `X-Rembric-Project` is intentionally ignored — scope is sourced only
  // from `/mcp/<slug>` or from explicit `project.use({slug})` tool calls.
  const slug = extractProjectSlug(pathname);
  if (slug && !isValidSlug(slug)) {
    respondJson(res, 400, {
      ok: false,
      code: 'invalid_project_slug',
      message: `project slug '${slug}' must match /^[a-zA-Z0-9_.-]+$/`,
    });
    return;
  }

  // 1. Auth.
  let ctx;
  try {
    ctx = authenticate({
      authorization: headerString(req.headers.authorization),
      pathSlug: slug,
      tokens: opts.tokens,
      projects: opts.projects,
    });
  } catch (err) {
    if (err instanceof AuthError) {
      respondJson(res, err.status, { ok: false, code: err.code, message: err.message });
      return;
    }
    throw err;
  }

  // 1b. Rate limit per token (after auth so we know the token id).
  if (opts.rateLimiter) {
    const decision = opts.rateLimiter.check(ctx.token.id);
    if (!decision.allowed) {
      res.setHeader('Retry-After', String(decision.retryAfterSeconds));
      respondJson(res, 429, {
        ok: false,
        code: 'rate_limited',
        message: `token '${ctx.token.name}' exceeded its rate limit; retry in ${decision.retryAfterSeconds}s`,
        retryAfterSeconds: decision.retryAfterSeconds,
      });
      return;
    }
  }

  // 2. Parse body (POST/DELETE may carry JSON; GET/HEAD don't).
  let body: unknown;
  if (req.method === 'POST' || req.method === 'DELETE') {
    body = await readJsonBody(req);
  }

  // 3. Look up or create the transport keyed by mcp-session-id. The
  // factory receives the URL path slug so the per-session McpServer
  // emits the right instructions variant.
  const sessionId = headerString(req.headers['mcp-session-id']);
  const transport = await opts.mcp.getOrCreate(sessionId, {
    requestedSlug: slug ?? null,
  });

  // 4. Hand off to the transport inside the per-request context.
  await runWithContext({ ...ctx, mcpSessionId: sessionId ?? null }, async () => {
    await transport.handleRequest(req, res, body);
  });
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (raw.length === 0) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function headerString(value: string | string[] | undefined): string | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

function parsePathname(url: string): string {
  const queryIdx = url.indexOf('?');
  const path = queryIdx === -1 ? url : url.slice(0, queryIdx);
  if (path.length > 1 && path.endsWith('/')) return path.slice(0, -1);
  return path;
}

/**
 * Extract the project slug from a `/mcp/<slug>` path. Returns `undefined`
 * for the bare `/mcp` endpoint or any path that doesn't have a slug
 * segment.
 */
function extractProjectSlug(pathname: string): string | undefined {
  if (pathname === '/mcp' || pathname === '/mcp/') return undefined;
  if (!pathname.startsWith('/mcp/')) return undefined;
  const rest = pathname.slice('/mcp/'.length);
  // Take everything up to the next path segment (in case the transport
  // ever surfaces sub-paths, we keep only the project portion).
  const firstSlash = rest.indexOf('/');
  return firstSlash === -1 ? rest : rest.slice(0, firstSlash);
}

const SLUG_RE = /^[a-zA-Z0-9_.-]+$/;
function isValidSlug(slug: string): boolean {
  return slug.length > 0 && slug.length <= 128 && SLUG_RE.test(slug);
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function respondInternal(res: ServerResponse, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  respondJson(res, 500, { ok: false, code: 'internal_error', message });
}

interface AdminAuthFailure {
  status: 401 | 403;
  code: string;
  message: string;
}

/**
 * Verify `Authorization: Bearer <admin-token>` for privileged HTTP
 * endpoints. Returns `null` on success, or a failure descriptor that
 * the caller renders as JSON.
 */
function adminAuth(authz: string | undefined, tokens: TokensService): AdminAuthFailure | null {
  if (!authz) {
    return { status: 401, code: 'missing_token', message: 'missing Authorization header' };
  }
  if (authz.toLowerCase().slice(0, 7) !== 'bearer ') {
    return { status: 401, code: 'malformed_authorization', message: 'expected "Bearer <token>"' };
  }
  const plaintext = authz.slice(7).trim();
  try {
    const resolved = tokens.authenticate(plaintext);
    if (resolved.scope !== '*') {
      return {
        status: 403,
        code: 'forbidden',
        message: 'admin endpoints require a token with scope=*',
      };
    }
    return null;
  } catch (err) {
    const message = err instanceof Error ? err.message : 'token not recognized';
    return { status: 401, code: 'token_invalid', message };
  }
}
