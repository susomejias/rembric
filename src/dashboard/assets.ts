import { readFileSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Context, MiddlewareHandler } from 'hono';

/**
 * Static asset middleware for `/dashboard/assets/*`.
 *
 * Reads files relative to `src/dashboard/public/` (after build,
 * `dist/dashboard/public/`). Paths are joined and then verified to live
 * under the configured root — any attempt to escape (e.g.
 * `/dashboard/assets/../../etc/passwd`) returns 404.
 *
 * Files are read on each request rather than cached in memory: the asset
 * volume is small (HTMX + Pico) and reading from disk lets operators
 * drop in updated vendored copies without restarting the server.
 */

const PUBLIC_ROOT = resolveDashboardPublicDir();

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

export function createAssetsMiddleware(): MiddlewareHandler {
  // eslint-disable-next-line @typescript-eslint/require-await
  return async (c: Context) => {
    // c.req.param('*') captures the wildcard segment from `/assets/*`.
    const relRaw = c.req.param('path') ?? c.req.path.replace(/^.*\/assets\//, '');
    if (!relRaw) return c.text('Not found', 404);

    // Normalize and reject path-escapes.
    const target = resolve(join(PUBLIC_ROOT, 'assets', normalize(relRaw)));
    if (!target.startsWith(resolve(PUBLIC_ROOT) + '/')) {
      return c.text('Not found', 404);
    }

    try {
      const stat = statSync(target);
      if (!stat.isFile()) return c.text('Not found', 404);
    } catch {
      return c.text('Not found', 404);
    }

    const body = readFileSync(target);
    const ext = extname(target).toLowerCase();
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream';

    // Long-lived but revalidate-able: assets are vendored, name-stable, and
    // small enough that we don't bother with content hashing yet.
    c.header('Content-Type', mime);
    c.header('Cache-Control', 'public, max-age=3600');
    return c.body(body);
  };
}

/** Exposed so tests can reach into the resolved root. */
export function dashboardPublicDir(): string {
  return PUBLIC_ROOT;
}

function resolveDashboardPublicDir(): string {
  // ESM-compatible __dirname; works both pre-build (TS-via-tsx) and after
  // build (compiled to dist/dashboard/assets.js next to dist/dashboard/public).
  const here = fileURLToPath(new URL('.', import.meta.url));
  return resolve(here, 'public');
}
