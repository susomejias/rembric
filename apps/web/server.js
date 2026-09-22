#!/usr/bin/env node
/**
 * The standalone image's entrypoint / launcher.
 *
 * The Next-generated standalone server (`next-server.js`, renamed during the
 * image assembly so this launcher can occupy the documented `apps/web/server.js`
 * path) reads its listen port from `PORT` alone. Every Rembric surface names
 * `REMBRIC_PORT` instead: `docker-compose.yml` maps
 * `${REMBRIC_PORT}:${REMBRIC_PORT}`, the installer writes it to `.env`, and the
 * docs list it. An existing installation that set `REMBRIC_PORT=8799` therefore
 * published 8799 on the host while a `PORT=8787` baked into the image left the
 * server listening on 8787 — unreachable, and failing its healthcheck.
 *
 * This launcher resolves the legacy variable, validates it, publishes the result
 * as `PORT`, and only then loads the generated server. A bad value refuses
 * startup instead of silently binding the default, because a silent fallback is
 * the bug being repaired. Plain JS with no imports beyond Node builtins: it runs
 * before any build output and the runtime image is distroless (no shell).
 */
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The historical default, from `.env.example`, the docs and the installer. */
export const DEFAULT_PORT = 8787;

const HEALTHCHECK_FLAG = '--healthcheck';
const NEXT_SERVER_FILE = 'next-server.js';

/**
 * Validate one configured port. Non-integers and out-of-range values throw: a
 * container that cannot listen where its Compose mapping points must fail loudly
 * at boot rather than accept traffic nowhere.
 */
export function parseListenPort(value, name) {
  const raw = String(value).trim();
  const port = Number(raw);
  if (!/^\d+$/.test(raw) || port < 1 || port > 65535) {
    throw new Error(
      `${name} must be an integer between 1 and 65535, received ${JSON.stringify(value)}`,
    );
  }
  return port;
}

/**
 * `REMBRIC_PORT` wins over the generated server's `PORT`, which defaults to
 * 8787. An empty or whitespace-only value counts as unset; a non-empty invalid
 * value throws rather than falling through to the next source.
 */
export function resolveListenPort(env) {
  const rembric = env.REMBRIC_PORT;
  if (rembric !== undefined && rembric !== null && String(rembric).trim() !== '') {
    return parseListenPort(rembric, 'REMBRIC_PORT');
  }
  const port = env.PORT;
  if (port !== undefined && port !== null && String(port).trim() !== '') {
    return parseListenPort(port, 'PORT');
  }
  return DEFAULT_PORT;
}

/** Resolve the port and publish it as `PORT` for the generated server. */
export function applyListenPort(env) {
  const port = resolveListenPort(env);
  env.PORT = String(port);
  return port;
}

function describe(err) {
  return err instanceof Error ? err.message : String(err);
}

async function runHealthcheck(env) {
  const port = resolveListenPort(env);
  const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
    headers: { Authorization: `Bearer ${env.REMBRIC_ADMIN_TOKEN ?? ''}` },
  });
  return response.ok;
}

async function main() {
  if (process.argv.includes(HEALTHCHECK_FLAG)) {
    try {
      process.exit((await runHealthcheck(process.env)) ? 0 : 1);
    } catch (err) {
      console.error(`[launcher] healthcheck failed: ${describe(err)}`);
      process.exit(1);
    }
  }

  const port = applyListenPort(process.env);
  console.error(
    `[launcher] REMBRIC_PORT=${process.env.REMBRIC_PORT ?? '(unset)'} → listening on port ${port}`,
  );

  const serverPath = join(dirname(fileURLToPath(import.meta.url)), NEXT_SERVER_FILE);
  await import(pathToFileURL(serverPath).href);
}

// Only a direct exec is a launcher; importing this module (tests) stays a pure
// port derivation with no side effects.
const entry = process.argv[1];
if (entry !== undefined && pathToFileURL(entry).href === import.meta.url) {
  main().catch((err) => {
    console.error(`[launcher] ${describe(err)}`);
    process.exit(1);
  });
}
