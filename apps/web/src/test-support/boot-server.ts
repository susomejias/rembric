import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { findFreePort } from '../test/net.js';

/**
 * Boot a REAL production Next server for tests that need HTTP semantics no
 * in-process route handler can give them: the plugin suites drive an external
 * process over `fetch`, so the endpoint has to be a listening socket.
 *
 * The build is a prerequisite, never a side effect: `vitest` must not run
 * `next build` (it is slow, writes `.next`, and races the build CI already
 * did). A missing `.next/BUILD_ID` fails loudly with the exact command instead.
 *
 * The server runs on a free loopback port with an isolated temporary
 * `REMBRIC_DATA_DIR` and freshly generated admin token / session secret, and is
 * considered ready only once `/healthz` answers 200 to a bearer probe — the same
 * readiness signal the container HEALTHCHECK uses. The boot itself migrates the
 * throwaway database, which is why callers open their own handle only after
 * `bootWebServer` resolves.
 */

const webRoot = fileURLToPath(new URL('../../', import.meta.url));
const nextBin = join(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next');

export interface BootWebServerOptions {
  /** Overridden by the caller so its `TokensService` and the server's agree. */
  adminToken?: string;
  /** Extra environment for the child; takes precedence over the parent's. */
  env?: Record<string, string | undefined>;
  /** How long `/healthz` may take to answer 200. */
  startupTimeoutMs?: number;
  /** How long a graceful shutdown may take before `SIGKILL`. */
  shutdownTimeoutMs?: number;
}

export interface BootedWebServer {
  baseUrl: string;
  adminToken: string;
  dataDir: string;
  close: () => Promise<void>;
}

export async function bootWebServer(options: BootWebServerOptions = {}): Promise<BootedWebServer> {
  assertProductionBuild();

  const adminToken = options.adminToken ?? randomBytes(32).toString('hex');
  const sessionSecret = randomBytes(32).toString('hex');
  const dataDir = mkdtempSync(join(tmpdir(), 'rembric-web-boot-'));
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;

  const child = spawn(process.execPath, [nextBin, 'start', '-H', '127.0.0.1', '-p', String(port)], {
    cwd: webRoot,
    env: {
      ...process.env,
      ...options.env,
      REMBRIC_DATA_DIR: dataDir,
      REMBRIC_ADMIN_TOKEN: adminToken,
      REMBRIC_SESSION_SECRET: sessionSecret,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const logLines: string[] = [];
  const capture = (chunk: Buffer): void => {
    logLines.push(chunk.toString());
    // Bound the buffer so a chatty server cannot grow it without limit.
    if (logLines.length > 200) logLines.splice(0, logLines.length - 200);
  };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);

  const close = async (): Promise<void> => {
    if (child.exitCode === null && child.signalCode === null) {
      await terminate(child, options.shutdownTimeoutMs ?? 10_000);
    }
    rmSync(dataDir, { recursive: true, force: true });
  };

  const startupTimeoutMs = options.startupTimeoutMs ?? 90_000;
  const deadline = Date.now() + startupTimeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      await close();
      throw new Error(
        `next start exited before /healthz answered\n--- server output ---\n${logLines.join('')}`,
      );
    }
    try {
      const res = await fetch(`${baseUrl}/healthz`, {
        headers: { authorization: `Bearer ${adminToken}` },
      });
      if (res.status === 200) return { baseUrl, adminToken, dataDir, close };
    } catch {
      // Connection refused until the listener is up; retry.
    }
    await delay(200);
  }

  await close();
  throw new Error(
    `next start did not answer /healthz within ${startupTimeoutMs}ms\n--- server output ---\n${logLines.join('')}`,
  );
}

/** `SIGTERM`, then `SIGKILL` if the process has not exited within the budget. */
async function terminate(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<void> {
  const aborter = new AbortController();
  const timer = setTimeout(() => aborter.abort(), timeoutMs);
  child.kill('SIGTERM');
  try {
    await once(child, 'exit', { signal: aborter.signal });
  } catch {
    child.kill('SIGKILL');
    await once(child, 'exit');
  } finally {
    clearTimeout(timer);
  }
}

/** Fails loudly rather than building inside a test runner. */
function assertProductionBuild(): void {
  const buildId = join(webRoot, '.next', 'BUILD_ID');
  if (existsSync(buildId)) return;
  throw new Error(
    `apps/web has no production build (${buildId} is missing). ` +
      'Run `pnpm --filter @rembric/web build` before this suite; the boot harness never runs ' +
      '`next build` inside vitest.',
  );
}
