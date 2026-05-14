#!/usr/bin/env node
/**
 * Smoke test that simulates how a fresh consumer installs the package.
 *
 * 1. `npm pack` builds the tarball.
 * 2. Install it into a temporary directory.
 * 3. Run `npx rembric llm ping` against a local stub LLM endpoint.
 * 4. Assert the exit code is 0 and stdout contains `"ok": true`.
 *
 * Used by CI (task 12.4). Designed to be runnable locally with:
 *   pnpm build && node scripts/smoke-pack.mjs
 */

import { execFileSync, spawn } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');

function log(msg) {
  process.stderr.write(`smoke-pack: ${msg}\n`);
}

function die(code, msg) {
  log(`✗ ${msg}`);
  process.exit(code);
}

async function main() {
  if (!existsSync(join(repoRoot, 'dist'))) {
    die(2, 'dist/ missing — run `pnpm build` first');
  }

  // 1. Pack into a sandbox.
  const sandbox = mkdtempSync(join(tmpdir(), 'rembric-smoke-'));
  log(`sandbox: ${sandbox}`);

  let server;
  try {
    log('packing tarball …');
    const packOut = execFileSync('npm', ['pack', '--silent', '--pack-destination', sandbox], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    const tarball = packOut.split('\n').filter(Boolean).pop();
    if (!tarball) die(2, 'npm pack did not name a tarball');
    log(`tarball: ${tarball}`);

    // Bun's `npm pack` outputs the basename, which is relative to sandbox.
    const tarballPath = join(sandbox, tarball);
    if (!existsSync(tarballPath)) die(2, `tarball missing on disk: ${tarballPath}`);

    // 2. Install into a fresh project. We use npm here (not pnpm) because
    // CI runners always have npm available.
    log('installing into sandbox …');
    writeFileSync(
      join(sandbox, 'package.json'),
      JSON.stringify({ name: 'rembric-smoke', version: '0.0.0', private: true }, null, 2),
    );
    execFileSync('npm', ['install', '--silent', tarballPath], {
      cwd: sandbox,
      stdio: 'inherit',
    });

    // 3. Stand up a stub LLM endpoint so `rembric llm ping` has something
    // to talk to without needing real network access.
    server = createServer((req, res) => {
      // Catch-all for the few endpoints the LlmClient.ping touches.
      if (req.method === 'POST' && req.url?.startsWith('/v1/chat/completions')) {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            id: 'smoke',
            object: 'chat.completion',
            created: Date.now(),
            model: 'smoke-model',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' },
            ],
          }),
        );
        return;
      }
      if (req.method === 'GET' && req.url === '/v1/models') {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: [{ id: 'smoke-model' }] }));
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;
    log(`stub LLM on http://127.0.0.1:${port}/v1`);

    // 4. Invoke the installed CLI via `npx rembric llm ping`.
    log('running `npx rembric llm ping` …');
    const env = {
      ...process.env,
      OPENAI_BASE_URL: `http://127.0.0.1:${port}/v1`,
      OPENAI_API_KEY: 'sk-smoke',
      OPENAI_MODEL: 'smoke-model',
      REMBRIC_ADMIN_TOKEN: 'smoke-admin-token-with-enough-entropy',
      CONSOLIDATION_ENABLED: 'false',
      EMBEDDING_ENABLED: 'false',
    };
    const result = await new Promise((resolveProc) => {
      const child = spawn('npx', ['rembric', 'llm', 'ping'], {
        cwd: sandbox,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => (stdout += d.toString()));
      child.stderr.on('data', (d) => (stderr += d.toString()));
      child.on('close', (code) => resolveProc({ code, stdout, stderr }));
    });
    log(`stdout:\n${result.stdout}`);
    log(`stderr:\n${result.stderr}`);
    if (result.code !== 0) die(1, `rembric llm ping exited ${result.code}`);
    if (!result.stdout.includes('"ok": true')) die(1, 'rembric llm ping did not report ok:true');
    log('✓ smoke test passed');
  } finally {
    if (server) server.close();
    rmSync(sandbox, { recursive: true, force: true });
  }
}

main().catch((err) => {
  log(err.stack ?? String(err));
  process.exit(1);
});
