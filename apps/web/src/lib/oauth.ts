import { isIP } from 'node:net';
import { Readable } from 'node:stream';

import type { OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { SUPPORTED_OAUTH_SCOPES } from '@rembric/core';

import { areqKey } from '../app/dashboard/oauth-consent/session';

import { createOAuthProvider } from './oauth-provider';
import { getServices } from './services';

type AuthRouter = ReturnType<typeof mcpAuthRouter>;

const OAUTH_EXACT_PATHS = new Set(['/authorize', '/token', '/register', '/revoke']);

const CLIENT_IDENTITY_UNKNOWN = '0.0.0.0';

export function isOAuthPath(pathname: string): boolean {
  return OAUTH_EXACT_PATHS.has(pathname) || pathname.startsWith('/.well-known/oauth-');
}

export function oauthIssuer(): string | null {
  const raw = process.env['REMBRIC_PUBLIC_URL'];
  if (raw === undefined || raw.length === 0) return null;
  return raw.endsWith('/') ? raw.slice(0, -1) : raw;
}

const globalForOAuth = globalThis as typeof globalThis & {
  __rembricOAuthProvider?: OAuthServerProvider | null;
  __rembricOAuthRouter?: AuthRouter | null;
};

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
    console.error('[oauth] refusing to serve a misconfigured authorization server', err);
    return null;
  }
}

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

  if (!finished) return notFoundResponse(pathname);

  const { status, headers, payload } = res.result();
  const bodyless = method === 'HEAD' || status === 204 || status === 205 || status === 304;
  const init = bodyless || payload === null ? null : new Uint8Array(payload);
  return new Response(init, { status, headers });
}

function notFoundResponse(path: string): Response {
  return Response.json({ ok: false, code: 'not_found', path }, { status: 404 });
}

function asError(err: unknown): Error {
  return err instanceof Error ? err : new Error('oauth router called next() with a non-Error');
}

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

type AppSetting = boolean | number | string | undefined;

function createRequestShim(request: Request, body: Buffer | null): RequestShim {
  const { path, query } = splitUrl(request.url);
  const ip = rateLimitIdentity(request);

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
    socket: { readable: true, writable: true },
    connection: { readable: true, writable: true },
    complete: true,
    query,
    app: {
      get: (name: string) => (name === 'trust proxy' ? 1 : undefined),
      enabled: () => false,
      set: () => {},
    },
  });
}

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

type CallableRouter = (req: RequestShim, res: ResponseShim, next: (err?: unknown) => void) => void;

function callRouter(
  router: AuthRouter,
  req: RequestShim,
  res: ResponseShim,
  next: (err?: unknown) => void,
): void {
  // SAFETY: the shim satisfies every member the router's middleware and handlers touch (driven end to end in test/oauth-surface.test.ts); TS cannot express it structurally.
  (router as unknown as CallableRouter)(req, res, next);
}
