import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { getRequestListener } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import express from 'express';
import { Hono, type Context } from 'hono';

import type { DbDiagnostics } from '../db/diagnostics.js';
import { type McpTransportManager } from '../mcp/index.js';
import type { AgentSessionsService } from '../services/agent-sessions.js';
import type { OAuthService } from '../services/oauth.js';
import type { ProjectsService } from '../services/projects.js';
import type { TokensService } from '../services/tokens.js';
import { REMBRIC_VERSION } from '../version.js';

import { createApiRouter } from './api-router.js';
import { AuthError, authenticate } from './auth.js';
import { createDashboardRouter, type DashboardDeps } from './dashboard-router.js';
import { httpInternalError } from './error-response.js';
import type { AuthLockout, RateLimiter } from './rate-limit.js';
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
  /** DB diagnostics; used by `/healthz` to ping with `SELECT 1`. */
  diagnostics: DbDiagnostics;
  /** Optional per-token rate limiter applied before MCP transport handoff. */
  rateLimiter?: RateLimiter | null;
  /** Pre-auth failed-attempt lockout, keyed on network identity. */
  authLockout?: AuthLockout | null;
  /** Maximum raw request body size (bytes) for body-bearing methods. */
  maxBodyBytes?: number;
  /**
   * Triggers a consolidation sweep on demand (force — bypasses the
   * per-scope throttle). Wired by the bootstrapper to the in-process
   * ConsolidationRunner; exposed over HTTP via
   * `POST /admin/consolidation/run` (also the dashboard button at
   * `/dashboard/consolidation`).
   */
  triggerConsolidation?: () => Promise<unknown>;
  /** Fire-and-forget lazy sweep, invoked after a session is created. */
  sweep?: (projectId: string | null) => void;
  /**
   * OAuth 2.1 authorization server. When present, the SDK `mcpAuthRouter`
   * (a vetted Express router) is mounted for the OAuth endpoints and the
   * `/mcp` `401` advertises the protected-resource metadata.
   */
  oauth?: {
    provider: OAuthServerProvider;
    /** OAuth service for the `/mcp` access-token fallback in `authenticate()`. */
    service: OAuthService;
    /** Issuer / external base URL (no trailing slash). */
    issuer: string;
    scopesSupported?: string[];
  } | null;
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
    createHealthzHandler({
      tokens: opts.tokens,
      projects: opts.projects,
      diagnostics: opts.diagnostics,
      oauth: opts.oauth?.service ?? null,
      authLockout: opts.authLockout ?? null,
    }),
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
      memory: opts.dashboard.memory,
      tokens: opts.tokens,
      projects: opts.projects,
      sweep: opts.sweep,
      oauth: opts.oauth?.service ?? null,
      authLockout: opts.authLockout ?? null,
    }),
  );

  // Admin endpoints. Require an admin-scope bearer token. Only one for
  // now: trigger a consolidation pass. Kept off the MCP surface because
  // the operation is privileged and we don't want it advertised over
  // MCP tool listing.
  if (opts.triggerConsolidation) {
    const trigger = opts.triggerConsolidation;
    honoApp.post('/admin/consolidation/run', async (c) => {
      const identity = connIdentity(c);
      const lockout = opts.authLockout ?? null;
      const locked = lockout?.check(identity);
      if (locked?.locked) {
        c.header('Retry-After', String(locked.retryAfterSeconds));
        return c.json(
          { ok: false, code: 'rate_limited', message: 'too many failed attempts' },
          429,
        );
      }
      const authz = c.req.header('authorization');
      const adminCheck = await adminAuth(authz, opts.tokens);
      if (adminCheck !== null) {
        lockout?.recordFailure(identity);
        return c.json(
          { ok: false, code: adminCheck.code, message: adminCheck.message },
          adminCheck.status,
        );
      }
      lockout?.recordSuccess(identity);
      try {
        const result = await trigger();
        return c.json({ ok: true, result });
      } catch (err) {
        return c.json(httpInternalError(err, 'unhandled /admin/consolidation/run error'), 500);
      }
    });
  }

  honoApp.notFound((c) => c.json({ ok: false, code: 'not_found', path: c.req.path }, 404));

  const honoListener = getRequestListener(honoApp.fetch);

  // OAuth authorization server: the SDK's vetted Express router owns the
  // protocol surface (PKCE validation, redirect/state/CSRF, metadata, DCR,
  // rate limiting). Mounted only when OAuth is enabled. The router MUST be
  // installed at the application root.
  const oauthListener = opts.oauth
    ? (() => {
        const app = express();
        app.use(
          mcpAuthRouter({
            provider: opts.oauth.provider,
            issuerUrl: new URL(opts.oauth.issuer),
            scopesSupported: opts.oauth.scopesSupported,
            resourceName: 'Rembric',
          }),
        );
        return app;
      })()
    : null;

  const server = createNodeServer((req, res) => {
    const rawUrl = req.url ?? '/';
    const pathname = parsePathname(rawUrl);
    if (pathname === '/mcp' || pathname.startsWith('/mcp/')) {
      void handleMcpRequest(req, res, opts, pathname).catch((err: unknown) => {
        respondInternal(res, err);
      });
      return;
    }
    if (oauthListener && isOAuthPath(pathname)) {
      oauthListener(req, res);
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
  diagnostics: DbDiagnostics;
  /** OAuth access-token fallback, so /healthz auth matches /mcp. Null when OAuth is off. */
  oauth?: OAuthService | null;
  /** Pre-auth failed-attempt lockout, keyed on network identity. */
  authLockout?: AuthLockout | null;
}

export function createHealthzHandler(deps: HealthzDeps) {
  return async (c: Context) => {
    const identity = connIdentity(c);
    const locked = deps.authLockout?.check(identity);
    if (locked?.locked) {
      c.header('Retry-After', String(locked.retryAfterSeconds));
      return c.json(
        { ok: false, code: 'rate_limited' as const, message: 'too many failed attempts' },
        429,
      );
    }
    const authz = c.req.header('authorization');
    if (authz === undefined) {
      return c.json(
        { ok: false, code: 'missing_token' as const, message: 'missing Authorization header' },
        401,
      );
    }
    try {
      await authenticate({
        authorization: authz,
        pathSlug: undefined,
        tokens: deps.tokens,
        projects: deps.projects,
        oauth: deps.oauth ?? null,
      });
      deps.authLockout?.recordSuccess(identity);
      deps.diagnostics.ping();
      return c.json({ ok: true, version: REMBRIC_VERSION });
    } catch (err) {
      if (err instanceof AuthError) {
        deps.authLockout?.recordFailure(identity);
        return c.json({ ok: false, code: err.code, message: err.message }, err.status);
      }
      return c.json({ ok: false, code: 'db_unavailable' as const }, 503);
    }
  };
}

/** Best-effort client network identity for pre-auth lockout keying. */
export function connIdentity(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
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

  // 1. Pre-auth lockout, keyed on network identity, BEFORE the token-hash
  // scan so bogus bearers cannot exhaust CPU on the single Node thread.
  const identity = req.socket.remoteAddress ?? 'unknown';
  const lockout = opts.authLockout ?? null;
  const locked = lockout?.check(identity);
  if (locked?.locked) {
    res.setHeader('Retry-After', String(locked.retryAfterSeconds));
    respondJson(res, 429, {
      ok: false,
      code: 'rate_limited',
      message: 'too many failed authentication attempts',
      retryAfterSeconds: locked.retryAfterSeconds,
    });
    return;
  }

  // 1a. Auth.
  let ctx;
  try {
    ctx = await authenticate({
      authorization: headerString(req.headers.authorization),
      pathSlug: slug,
      tokens: opts.tokens,
      projects: opts.projects,
      oauth: opts.oauth?.service ?? null,
    });
    lockout?.recordSuccess(identity);
  } catch (err) {
    if (err instanceof AuthError) {
      lockout?.recordFailure(identity);
      // RFC 9728: advertise the protected-resource metadata so OAuth clients
      // can discover the authorization server. Additive — static-token
      // clients ignore the header. Only emitted when OAuth is enabled.
      if (opts.oauth && err.status === 401) {
        const metadataUrl = getOAuthProtectedResourceMetadataUrl(new URL(opts.oauth.issuer));
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"`);
      }
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
    try {
      body = await readJsonBody(req, opts.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    } catch (err) {
      if (err instanceof BodyTooLargeError) {
        // Flush the 413 first, then tear down the connection so we neither
        // buffer nor keep draining an abusive over-limit upload.
        res.setHeader('Connection', 'close');
        respondJson(res, 413, { ok: false, code: 'payload_too_large', message: err.message });
        req.destroy();
        return;
      }
      throw err;
    }
  }

  // 3. A request naming an mcp-session-id the manager does not hold is
  // refused before anything is constructed — the id was evicted (this
  // change's `sessions` eviction pass) or predates a restart. `initialize`
  // is exempt: it establishes a fresh session regardless of what stale id
  // it happens to carry. Mirrors the JSON-RPC shape the SDK transport
  // itself emits for a session id that does not match its own (mcp-api,
  // "A request naming an unknown MCP session MUST be refused with 404").
  const sessionId = headerString(req.headers['mcp-session-id']);
  const isInitializeRequest =
    typeof body === 'object' &&
    body !== null &&
    !Array.isArray(body) &&
    (body as { method?: unknown }).method === 'initialize';
  if (sessionId && !isInitializeRequest && !opts.mcp.has(sessionId)) {
    respondJson(res, 404, {
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: null,
    });
    return;
  }

  // 4. Look up or create the transport keyed by mcp-session-id. The
  // factory receives the URL path slug so the per-session McpServer
  // emits the right instructions variant.
  const transport = await opts.mcp.getOrCreate(sessionId, {
    requestedSlug: slug ?? null,
  });

  // 5. Hand off to the transport inside the per-request context.
  await runWithContext({ ...ctx, mcpSessionId: sessionId ?? null }, async () => {
    await transport.handleRequest(req, res, body);
  });
}

const DEFAULT_MAX_BODY_BYTES = 4 * 1024 * 1024;

class BodyTooLargeError extends Error {}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) {
      // Stop buffering but keep draining so the 413 response still flushes
      // to the client (destroying the socket here would surface as a
      // connection reset instead of a clean 413).
      throw new BodyTooLargeError(`request body exceeds the ${maxBytes}-byte limit`);
    }
    chunks.push(buf);
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

const OAUTH_EXACT_PATHS = new Set(['/authorize', '/token', '/register', '/revoke']);

/** Reserved OAuth authorization-server paths handled by the SDK router. */
function isOAuthPath(pathname: string): boolean {
  return OAUTH_EXACT_PATHS.has(pathname) || pathname.startsWith('/.well-known/oauth-');
}

function respondJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) return;
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function respondInternal(res: ServerResponse, err: unknown): void {
  respondJson(res, 500, httpInternalError(err, 'unhandled /mcp request error'));
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
async function adminAuth(
  authz: string | undefined,
  tokens: TokensService,
): Promise<AdminAuthFailure | null> {
  if (!authz) {
    return { status: 401, code: 'missing_token', message: 'missing Authorization header' };
  }
  if (authz.toLowerCase().slice(0, 7) !== 'bearer ') {
    return { status: 401, code: 'malformed_authorization', message: 'expected "Bearer <token>"' };
  }
  const plaintext = authz.slice(7).trim();
  try {
    const resolved = await tokens.authenticate(plaintext);
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
