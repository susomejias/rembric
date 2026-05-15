#!/usr/bin/env node
// rembric-bridge — minimal stdio↔HTTP MCP bridge for the Rembric plugin.
//
// Reads `.rembric-slug` from CLAUDE_PROJECT_DIR (falling back to cwd) and
// path-scopes the MCP URL to `/mcp/<slug>` so the Rembric server pins the
// correct project on connect — eliminating the need for an agent-side
// `project.use` call and avoiding the path-less roots-discovery codepath
// entirely.
//
// The bridge does NOT auto-derive a slug from manifest files or git. The
// user is explicit: drop a one-line `.rembric-slug` in the project root
// (gitignored or committed, your choice).
//
// If `.rembric-slug` is missing or invalid the bridge falls back to
// path-less `/mcp` and writes a diagnostic to stderr. The session still
// works; the agent will operate in global scope (or whatever
// `project.use` it chooses to make) but the plugin does not break.
//
// All MCP wire-protocol handling is delegated to `npx -y mcp-remote`.
// This bridge is a thin URL-building entrypoint.

import { existsSync, readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';

const projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const baseUrl = process.env.REMBRIC_SERVER_URL;
const token = process.env.REMBRIC_API_TOKEN;

if (!baseUrl || !token) {
  process.stderr.write(
    '[rembric-bridge] Missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN. ' +
      'Configure the plugin via `/plugin manage`.\n',
  );
  process.exit(1);
}

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;
const slugFile = path.join(projectDir, '.rembric-slug');

let scopedPath = '/mcp';
if (existsSync(slugFile)) {
  const raw = readFileSync(slugFile, 'utf8').split(/\r?\n/, 1)[0].trim();
  if (SLUG_RE.test(raw)) {
    scopedPath = `/mcp/${raw}`;
  } else {
    process.stderr.write(
      `[rembric-bridge] Slug "${raw}" in ${slugFile} does not match ${SLUG_RE.source}; ` +
        'falling back to path-less /mcp.\n',
    );
  }
} else {
  process.stderr.write(
    `[rembric-bridge] No .rembric-slug in ${projectDir}; using path-less /mcp. ` +
      'Create the file with the desired project slug to pin scope automatically.\n',
  );
}

const url = `${baseUrl.replace(/\/+$/, '')}${scopedPath}`;
process.stderr.write(`[rembric-bridge] cwd=${projectDir} url=${url}\n`);

// `mcp-remote` requires HTTPS by default and rejects plain HTTP (except
// for localhost). Rembric is commonly deployed on a LAN VPS reached over
// HTTP (e.g. http://192.168.x.y:8787), so we pass `--allow-http`
// unconditionally. For HTTPS deployments the flag is a no-op.
const child = spawn(
  'npx',
  ['-y', 'mcp-remote@latest', url, '--allow-http', '--header', `Authorization:Bearer ${token}`],
  { stdio: 'inherit' },
);

child.on('error', (err) => {
  process.stderr.write(`[rembric-bridge] failed to spawn npx: ${err.message}\n`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});
