import {
  createServer as createNodeServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import { getRequestListener } from '@hono/node-server';
import { Hono } from 'hono';

import { type McpTransportManager } from '../mcp/index.js';
import type { ProjectsService } from '../services/projects.js';
import type { TokensService } from '../services/tokens.js';

import { AuthError, authenticate } from './auth.js';
import { createDashboardRouter, type DashboardDeps } from './dashboard-router.js';
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

  honoApp.get('/healthz', (c) => c.json({ ok: true }));
  honoApp.get('/', (c) => c.redirect('/dashboard'));

  honoApp.route('/dashboard', createDashboardRouter(opts.dashboard));

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

async function handleMcpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: CreateHttpServerOptions,
  pathname: string,
): Promise<void> {
  // 0. Extract project slug from the URL path, if any. Path wins over header.
  const slug = extractProjectSlug(pathname);
  if (slug && !isValidSlug(slug)) {
    respondJson(res, 400, {
      ok: false,
      code: 'invalid_project_slug',
      message: `project slug '${slug}' must match /^[a-zA-Z0-9_.-]+$/`,
    });
    return;
  }
  const projectIdentifier = slug ?? headerString(req.headers['x-rembric-project']) ?? undefined;

  // 1. Auth.
  let ctx;
  try {
    ctx = authenticate({
      authorization: headerString(req.headers.authorization),
      projectIdentifier,
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

  // 2. Parse body (POST/DELETE may carry JSON; GET/HEAD don't).
  let body: unknown;
  if (req.method === 'POST' || req.method === 'DELETE') {
    body = await readJsonBody(req);
  }

  // 3. Look up or create the transport keyed by mcp-session-id.
  const sessionId = headerString(req.headers['mcp-session-id']);
  const transport = await opts.mcp.getOrCreate(sessionId);

  // 4. Hand off to the transport inside the per-request context.
  await runWithContext(ctx, async () => {
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
