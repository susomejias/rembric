import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { findFreePort } from '../test/net.js';

const webRoot = fileURLToPath(new URL('../../', import.meta.url));
const nextBin = join(webRoot, 'node_modules', 'next', 'dist', 'bin', 'next');

export interface BootWebServerOptions {
  adminToken?: string;
  env?: Record<string, string | undefined>;
  startupTimeoutMs?: number;
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
    } catch {}
    await delay(200);
  }

  await close();
  throw new Error(
    `next start did not answer /healthz within ${startupTimeoutMs}ms\n--- server output ---\n${logLines.join('')}`,
  );
}

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

function assertProductionBuild(): void {
  const buildId = join(webRoot, '.next', 'BUILD_ID');
  if (existsSync(buildId)) return;
  throw new Error(
    `apps/web has no production build (${buildId} is missing). ` +
      'Run `pnpm --filter @rembric/web build` before this suite; the boot harness never runs ' +
      '`next build` inside vitest.',
  );
}
