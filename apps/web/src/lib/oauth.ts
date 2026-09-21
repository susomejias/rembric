import { isIP } from 'node:net';
import { Readable } from 'node:stream';

import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { SUPPORTED_OAUTH_SCOPES } from '@rembric/core';

import { areqKey } from '../app/dashboard/oauth-consent/session';

import { createOAuthProvider } from './oauth-provider';
import { getServices } from './services';

/**
 * The OAuth 2.1 authorization-server surface, at the paths `apps/server` serves
 * it on — `/authorize`, `/token`, `/register`, `/revoke` and
 * `/.well-known/oauth-*` — so an MCP client completes the dance against this
 * app alone.
 *
 * The protocol surface is the SDK's vetted `mcpAuthRouter` (the same 1.x router
 * `apps/server/src/server/http.ts:188` mounts), not a re-implementation: PKCE
 * validation, redirect/state handling, dynamic client registration, RFC 8414 /
 * RFC 9728 metadata, error shapes and per-endpoint rate limiting all stay inside
 * the SDK. This module owns only what Next changes about the request shape.
 *
 * ## Why there is an adapter here
 *
 * `mcpAuthRouter` hands back an Express router — the SDK's auth surface has no
 * Web-standard variant. `apps/server` mounts it on a real Express app; this app
 * serves it from a route handler, so every request has to be presented to the
 * router as the Node-shaped `req`/`res` pair its middlewares expect
 * (`express.json`/`urlencoded` read a stream, `cors` and `express-rate-limit`
 * write headers and end the response). The shims below implement exactly that
 * surface and translate the result back into a `Response`. They are the only
 * Express-shaped code in this app, and each detail they have to get right is
 * documented where it is set.
 *
 * The issuer is `REMBRIC_PUBLIC_URL` (trailing slash stripped, as
 * `apps/server/src/config.ts:235` does): it is the externally reachable origin
 * every absolute metadata URL is built from, and the SDK refuses anything but
 * https or a loopback host.
 */

type AuthRouter = ReturnType<typeof mcpAuthRouter>;

/** Mirrors `apps/server/src/server/http.ts::isOAuthPath`. */
const OAUTH_EXACT_PATHS = new Set(['/authorize', '/token', '/register', '/revoke']);

/**
 * The bucket every address-less caller shares. `0.0.0.0` is a real, valid IP,
 * which matters: `express-rate-limit` validates the value it is handed and logs
 * an error for anything that is not an address.
 */
const CLIENT_IDENTITY_UNKNOWN = '0.0.0.0';

export function isOAuthPath(pathname: string): boolean {
  return OAUTH_EXACT_PATHS.has(pathname) || pathname.startsWith('/.well-known/oauth-');
}

/**
 * `config.ts`'s `stripTrailingSlash(REMBRIC_PUBLIC_URL)`. The provider builds
 * the consent URL by concatenation (so it needs no trailing slash) while the
 * SDK derives metadata by `new URL(path, issuer)` (which normalises one in).
 */
export function oauthIssuer(): string | null {
  const raw = process.env['REMBRIC_PUBLIC_URL'];
  if (raw === undefined || raw.length === 0) return null;
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

/**
 * Cached on `globalThis`, like every other service this app builds: Next
 * re-evaluates modules on an HMR edit, and a second router would be a second
 * rate-limit store over the same endpoints. The `null` is cached too, so a
 * disabled or misconfigured authorization server is not re-decided per request.
 */
const globalForOAuth = globalThis as typeof globalThis & {
  __rembricOAuthProvider?: OAuthServerProvider | null;
  __rembricOAuthRouter?: AuthRouter | null;
};

/** The provider the router is built over, exposed so the round trip can be verified directly. */
export function getOAuthProvider(): OAuthServerProvider | null {
  const cached = globalForOAuth.__rembricOAuthProvider;
  if (cached !== undefined) return cached;

  const built = buildOAuthProvider();
  globalForOAuth.__rembricOAuthProvider = built;
  return built;
}

function buildOAuthProvider(): OAuthServerProvider | null {
  const { oauth, projects } = getServices();
  const issuer = oauthIssuer();
  // `areqKey()` is the consent screen's own derivation, imported rather than
  // repeated here: the blob this provider signs is verified by that page, so a
  // second copy of the derivation would be a silent break in the hand-off.
  const key = areqKey();
  if (oauth === null || issuer === null || key === null) return null;
  return createOAuthProvider({ oauth, projects, issuer, areqKey: key });
}

export function getOAuthRouter(): AuthRouter | null {
  const cached = globalForOAuth.__rembricOAuthRouter;
  if (cached !== undefined) return cached;

  const provider = getOAuthProvider();
  const issuer = oauthIssuer();
  const built = buildOAuthRouter(provider, issuer);
  globalForOAuth.__rembricOAuthRouter = built;
  return built;
}

function buildOAuthRouter(
  provider: OAuthServerProvider | null,
  issuer: string | null,
): AuthRouter | null {
  if (provider === null || issuer === null) return null;
  try {
    return mcpAuthRouter({
      provider,
      issuerUrl: new URL(issuer),
      scopesSupported: [...SUPPORTED_OAUTH_SCOPES],
      resourceName: 'Rembric',
    });
  } catch (err) {
    // A REMBRIC_PUBLIC_URL the SDK rejects (non-https on a public host, a
    // query string, a fragment) is a deployment fault, not a request fault:
    // fail closed and say so once, rather than answering 500 per request.
    console.error('[oauth] refusing to serve a misconfigured authorization server', err);
    return null;
  }
}

/**
 * Serve one authorization-server request. Returns the same JSON 404 body
 * `apps/server`'s `notFound` answers with when OAuth is disabled — the feature
 * is enabled iff `REMBRIC_PUBLIC_URL` is set, exactly as it is there.
 */
export async function handleOAuthRequest(request: Request, pathname: string): Promise<Response> {
  const router = getOAuthRouter();
  if (router === null) return notFoundResponse(pathname);

  const method = request.method.toUpperCase();
  const body =
    method === 'GET' || method === 'HEAD' ? null : Buffer.from(await request.arrayBuffer());

  const req = createRequestShim(request, body);
  const res = createResponseShim();

  let finished: boolean;
  try {
    finished = await new Promise<boolean>((resolve, reject) => {
      res.onEnd = () => resolve(true);
      callRouter(router, req, res, (err) =>
        err === undefined ? resolve(false) : reject(asError(err)),
      );
    });
  } catch (err) {
    console.error('[oauth] authorization-server request failed', err);
    return Response.json({ ok: false, code: 'internal_error' }, { status: 500 });
  }

  // The router calls `next()` only for a path under `/.well-known/oauth-` that
  // no metadata route claims.
  if (!finished) return notFoundResponse(pathname);

  const { status, headers, payload } = res.result();
  const bodyless = method === 'HEAD' || status === 204 || status === 205 || status === 304;
  // A fresh view, because a `Buffer`'s bytes may sit inside a pooled
  // `ArrayBuffer` and `BodyInit` takes the view, not the pool.
  const init = bodyless || payload === null ? null : new Uint8Array(payload);
  return new Response(init, { status, headers });
}

function notFoundResponse(path: string): Response {
  return Response.json({ ok: false, code: 'not_found', path }, { status: 404 });
}

/** Express hands `next(err)` over as `unknown`; a rejection reason must be an `Error`. */
function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error('oauth router called next() with a non-Error');
}

/** The Express request surface vetted by the SDK's middlewares, rebuilt from a `Request`. */
interface RequestShim extends Readable {
  method: string;
  url: string;
  originalUrl: string;
  headers: Record<string, string>;
  httpVersion: string;
  ip: string;
  socket: { readable: boolean; writable: boolean };
  connection: { readable: boolean; writable: boolean };
  complete: boolean;
  query: Record<string, string>;
  app: {
    get(name: string): AppSetting;
    enabled(name: string): boolean;
    set(name: string, value: AppSetting): void;
  };
}

/** Express app settings. `express-rate-limit` reads exactly one: `trust proxy`. */
type AppSetting = boolean | number | string | undefined;

function createRequestShim(request: Request, body: Buffer | null): RequestShim {
  const { path, query } = splitUrl(request.url);
  const ip = rateLimitIdentity(request);

  // Lazy on purpose: `on-finished.isFinished(req)` — which body-parser consults
  // before parsing — reads `req.complete && !req.readable`, and a stream that
  // already delivered its bytes is not readable. Pushing the body only when the
  // parser reads keeps the request looking like one whose body is still to come.
  let delivered = false;
  const stream = new Readable({
    read() {
      if (delivered) return;
      delivered = true;
      if (body !== null) this.push(body);
      this.push(null);
    },
  });

  const headers: Record<string, string> = {};
  request.headers.forEach((value, name) => {
    headers[name] = value;
  });
  // Undici's `Request` keeps no `content-length`, and body-parser skips any
  // request without one (`type-is.hasBody`): without this the DCR, token and
  // revocation bodies would be silently dropped and every one of them would
  // fail as an empty request.
  if (body !== null && headers['content-length'] === undefined) {
    headers['content-length'] = String(body.byteLength);
  }

  return Object.assign(stream, {
    method: request.method,
    url: path,
    originalUrl: path,
    headers,
    httpVersion: '1.1',
    ip,
    // `readable`/`writable` are not decoration: `on-finished.isFinished` answers
    // true when the socket looks dead, which would skip body parsing the same
    // way an ended stream would. The address is deliberately absent — a route
    // handler cannot know it, and `req.ip` above carries the identity that was
    // resolved instead.
    socket: { readable: true, writable: true },
    connection: { readable: true, writable: true },
    complete: true,
    query,
    // `express-rate-limit`'s validators read `req.app.get('trust proxy')`. One
    // hop is the truth here: this app is fronted by a proxy (that is what
    // REMBRIC_PUBLIC_URL is), and `req.ip` above is the first forwarded hop.
    // The validators reject `false` alongside an `x-forwarded-for` header and
    // `true` outright, which leaves exactly this shape correct.
    app: {
      get: (name: string) => (name === 'trust proxy' ? 1 : undefined),
      enabled: () => false,
      set: () => {},
    },
  });
}

/**
 * `req.url` and the `req.query` Express would have parsed from it before the
 * router ran. The SDK's `authorize` handler reads `req.query` on GET (its POST
 * arm reads `req.body`), and the schemas only take scalar parameters, so the
 * flat parse is the whole contract.
 *
 * The `catch` is unreachable from a route handler (Next always hands over an
 * absolute URL); it exists so a malformed one degrades to a path the router
 * does not match instead of throwing a 500.
 */
function splitUrl(raw: string): { path: string; query: Record<string, string> } {
  try {
    const url = new URL(raw);
    const query: Record<string, string> = {};
    url.searchParams.forEach((value, name) => {
      query[name] = value;
    });
    return { path: `${url.pathname}${url.search}`, query };
  } catch {
    return { path: raw, query: {} };
  }
}

/**
 * The rate limiter's identity for a request, and the closest thing to a client
 * address a route handler can reach.
 *
 * `express-rate-limit`'s default key is Express's `req.ip`, which Express reads
 * from the socket — absent here, so the first `x-forwarded-for` hop takes its
 * place, the same substitution `lib/api.ts::networkIdentity` and the `/mcp` route
 * make for the pre-auth lockout. `0.0.0.0` is what a caller with no hop shares.
 *
 * Only a well-formed address is ever adopted. The header is caller-controlled,
 * and the library checks whatever it is handed as a real address: a non-address
 * would both log `ERR_ERL_INVALID_IP_ADDRESS` on every limiter creation and hand
 * that caller a private bucket to spend instead of the shared one.
 *
 * Exported for its own test because the library's key validation is a one-shot
 * per limiter instance (measured: the same malformed key is accepted silently
 * from the second request on), so a request-level assertion cannot observe this
 * value at all.
 */
export function rateLimitIdentity(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  if (forwarded) {
    const first = forwarded.split(',')[0]?.trim() ?? '';
    if (isIP(first) !== 0) return first;
  }
  return CLIENT_IDENTITY_UNKNOWN;
}

interface ResponseShim {
  statusCode: number;
  locals: Record<string, unknown>;
  ended: boolean;
  onEnd?: () => void;
  setHeader(name: string, value: string | string[]): void;
  getHeader(name: string): string | undefined;
  getHeaders(): Record<string, string>;
  hasHeader(name: string): boolean;
  removeHeader(name: string): void;
  writeHead(status: number, ...rest: unknown[]): ResponseShim;
  set(name: string | Record<string, string>, value?: string): ResponseShim;
  header(name: string | Record<string, string>, value?: string): ResponseShim;
  status(code: number): ResponseShim;
  json(payload: unknown): ResponseShim;
  send(payload: unknown): ResponseShim;
  redirect(statusOrUrl: number | string, url?: string): ResponseShim;
  end(chunk?: string | Uint8Array): ResponseShim;
  write(chunk: string | Uint8Array): boolean;
  flushHeaders(): void;
  on(): ResponseShim;
  once(): ResponseShim;
  emit(): boolean;
  result(): { status: number; headers: Record<string, string>; payload: Buffer | null };
}

/**
 * The Express response surface the SDK's handlers and middlewares write through
 * (`res.status(...).json(...)`, `res.set(...)`, `res.redirect(...)`, the
 * `res.end()` of a CORS preflight), collected into a `Response`.
 */
function createResponseShim(): ResponseShim {
  const headers = new Map<string, string>();
  const chunks: Buffer[] = [];
  let payload: Buffer | null = null;

  const put = (name: string, value: string | string[] | number): void => {
    headers.set(name.toLowerCase(), Array.isArray(value) ? value.join(', ') : String(value));
  };

  const res: ResponseShim = {
    statusCode: 200,
    locals: {},
    ended: false,

    setHeader(name, value) {
      put(name, value);
    },
    getHeader(name) {
      return headers.get(name.toLowerCase());
    },
    getHeaders() {
      return Object.fromEntries(headers);
    },
    hasHeader(name) {
      return headers.has(name.toLowerCase());
    },
    removeHeader(name) {
      headers.delete(name.toLowerCase());
    },
    writeHead(status, ...rest) {
      // Read through `res.statusCode`, not a captured variable: `cors` sets the
      // property directly for a preflight, and a preflight answered 200 instead
      // of 204 is a different response to a web-based MCP client.
      res.statusCode = status;
      for (const arg of rest) {
        if (typeof arg === 'object' && arg !== null) {
          for (const [name, value] of Object.entries(arg as Record<string, string>))
            put(name, value);
        }
      }
      return res;
    },
    set(name, value) {
      if (typeof name === 'object') {
        for (const [key, item] of Object.entries(name)) put(key, item);
      } else if (value !== undefined) {
        put(name, value);
      }
      return res;
    },
    header(name, value) {
      return res.set(name, value);
    },
    status(code) {
      res.statusCode = code;
      return res;
    },
    json(value) {
      put('content-type', 'application/json; charset=utf-8');
      payload = Buffer.from(JSON.stringify(value));
      return res.end();
    },
    send(value) {
      if (typeof value === 'string') put('content-type', 'text/html; charset=utf-8');
      payload = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value));
      return res.end();
    },
    redirect(statusOrUrl, url) {
      const status = typeof statusOrUrl === 'number' ? statusOrUrl : 302;
      const target = typeof statusOrUrl === 'number' ? url : statusOrUrl;
      res.statusCode = status;
      if (target !== undefined) put('location', target);
      return res.end();
    },
    end(chunk) {
      if (chunk !== undefined) chunks.push(Buffer.from(chunk));
      if (payload === null) payload = chunks.length > 0 ? Buffer.concat(chunks) : null;
      if (!res.ended) {
        res.ended = true;
        res.onEnd?.();
      }
      return res;
    },
    write(chunk) {
      chunks.push(Buffer.from(chunk));
      return true;
    },
    flushHeaders() {},
    on() {
      return res;
    },
    once() {
      return res;
    },
    emit() {
      return false;
    },
    result() {
      return { status: res.statusCode, headers: Object.fromEntries(headers), payload };
    },
  };

  return res;
}

/**
 * The router is an Express `RequestHandler`: it reads the shim through the
 * surface above and never inspects the objects as anything else. One cast, at
 * the single boundary where the two request models meet.
 */
type CallableRouter = (req: RequestShim, res: ResponseShim, next: (err?: unknown) => void) => void;

function callRouter(
  router: AuthRouter,
  req: RequestShim,
  res: ResponseShim,
  next: (err?: unknown) => void,
): void {
  // SAFETY: the shim implements every member the router's middlewares and
  // handlers touch (verified by driving all five endpoints end to end in
  // `test/oauth-surface.test.ts`); TypeScript cannot express that the Express
  // classes are satisfied structurally.
  (router as unknown as CallableRouter)(req, res, next);
}
