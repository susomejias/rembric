import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const bridgePath = join(here, '..', 'bin', 'rembric-bridge.mjs');

/**
 * The bridge unconditionally spawns `npx mcp-remote ...` as its final step
 * (stdio: 'inherit'). To test the version-handshake warning in isolation
 * without a real network dependency or a genuine MCP session, we shadow
 * `npx` on PATH with a stub that exits immediately — the bridge's own
 * stderr diagnostics (including the version warning) still flow through
 * since 'inherit' means the stub shares the bridge's (our) pipes.
 */
function writeFakeNpx(dir: string): void {
  const script = join(dir, 'npx');
  // Sleep briefly to mirror mcp-remote's real (much slower) cold start, so
  // the fire-and-forget /healthz probe has its normal window to land its
  // warning before the bridge exits — exactly the production ordering.
  writeFileSync(script, '#!/usr/bin/env bash\nsleep 0.5\nexit 0\n');
  chmodSync(script, 0o755);
}

function runBridge(opts: {
  serverUrl: string;
  token?: string;
}): Promise<{ stderr: string; code: number | null }> {
  const stubDir = mkdtempSync(join(tmpdir(), 'rembric-bridge-stub-'));
  writeFakeNpx(stubDir);
  const projectDir = mkdtempSync(join(tmpdir(), 'rembric-bridge-project-'));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [bridgePath], {
      env: {
        ...process.env,
        PATH: `${stubDir}:${process.env.PATH}`,
        REMBRIC_SERVER_URL: opts.serverUrl,
        REMBRIC_API_TOKEN: opts.token ?? 'test-token',
        CLAUDE_PROJECT_DIR: projectDir,
      },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      rmSync(stubDir, { recursive: true, force: true });
      rmSync(projectDir, { recursive: true, force: true });
      resolve({ stderr, code });
    });
  });
}

describe('rembric-bridge version handshake', () => {
  let server: Server;
  let serverUrl: string;
  let responseVersion: string | null;
  let healthzShouldFail: boolean;

  beforeEach(async () => {
    responseVersion = '0.24.0';
    healthzShouldFail = false;
    server = createServer((req, res) => {
      if (req.url === '/healthz') {
        if (healthzShouldFail) {
          req.socket.destroy();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, version: responseVersion }));
        return;
      }
      res.writeHead(404);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('no server address');
    serverUrl = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('warns to stderr when the server version is older than MIN_SERVER_VERSION', async () => {
    responseVersion = '0.10.0';
    const { stderr, code } = await runBridge({ serverUrl });
    expect(stderr).toContain('server version 0.10.0 is older than this plugin expects');
    expect(code).toBe(0);
  }, 15_000);

  it('is silent when the server version meets MIN_SERVER_VERSION', async () => {
    responseVersion = '0.24.0';
    const { stderr } = await runBridge({ serverUrl });
    expect(stderr).not.toContain('is older than this plugin expects');
  }, 15_000);

  it('is silent when the server version exceeds MIN_SERVER_VERSION', async () => {
    responseVersion = '1.0.0';
    const { stderr } = await runBridge({ serverUrl });
    expect(stderr).not.toContain('is older than this plugin expects');
  }, 15_000);

  it('is silent and does not block the connection when /healthz is unreachable', async () => {
    healthzShouldFail = true;
    const { stderr, code } = await runBridge({ serverUrl });
    expect(stderr).not.toContain('is older than this plugin expects');
    // The bridge still proceeds to spawn (our stubbed) mcp-remote and exits cleanly.
    expect(code).toBe(0);
  }, 15_000);
});
