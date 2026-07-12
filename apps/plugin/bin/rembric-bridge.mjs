#!/usr/bin/env node
// rembric-bridge — minimal stdio↔HTTP MCP bridge for the Rembric plugin.
//
// Reads `.rembric` (dotenv-style KEY=VALUE) from a resolution chain of
// CLAUDE_PROJECT_DIR > PWD > process.cwd() and path-scopes the MCP URL
// to `/mcp/<slug>` so the Rembric server pins the correct project on
// connect — eliminating
// the need for an agent-side `project.use` call and avoiding the
// path-less roots-discovery codepath entirely.
//
// The bridge does NOT auto-derive a slug from manifest files or git. The
// user is explicit: drop a `.rembric` file in the project root
// containing `PROJECT_SLUG=<slug>` (gitignored or committed, your
// choice).
//
// If `.rembric` is missing, unparseable, or PROJECT_SLUG is invalid the
// bridge falls back to path-less `/mcp` and writes a diagnostic to
// stderr. The session still works; the agent will operate in global
// scope (or whatever `project.use` it chooses to make) but the plugin
// does not break.
//
// All MCP wire-protocol handling is delegated to `npx -y mcp-remote`.
// This bridge is a thin URL-building entrypoint.

import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

import { SLUG_RE, parseDotenv } from './rembric-dotenv.mjs';

let projectDir;
let projectDirSource;
if (process.env.CLAUDE_PROJECT_DIR) {
  projectDir = process.env.CLAUDE_PROJECT_DIR;
  projectDirSource = 'CLAUDE_PROJECT_DIR';
} else if (process.env.PWD) {
  projectDir = process.env.PWD;
  projectDirSource = 'PWD';
} else {
  projectDir = process.cwd();
  projectDirSource = 'process.cwd()';
}
const baseUrl = process.env.REMBRIC_SERVER_URL;
const token = process.env.REMBRIC_API_TOKEN;

if (!baseUrl || !token) {
  process.stderr.write(
    '[rembric-bridge] Missing REMBRIC_SERVER_URL or REMBRIC_API_TOKEN. ' +
      'Configure the plugin via `/plugin manage`.\n',
  );
  process.exit(1);
}

const configFile = path.join(projectDir, '.rembric');

let scopedPath = '/mcp';
if (existsSync(configFile)) {
  const cfg = parseDotenv(readFileSync(configFile, 'utf8'));
  const slug = cfg.PROJECT_SLUG;
  if (slug && SLUG_RE.test(slug)) {
    scopedPath = `/mcp/${slug}`;
  } else if (slug) {
    process.stderr.write(
      `[rembric-bridge] PROJECT_SLUG="${slug}" in ${configFile} does not match ${SLUG_RE.source}; ` +
        'falling back to path-less /mcp.\n',
    );
  } else {
    process.stderr.write(
      `[rembric-bridge] ${configFile} present but no PROJECT_SLUG defined; ` +
        'falling back to path-less /mcp.\n',
    );
  }
} else {
  process.stderr.write(
    `[rembric-bridge] No .rembric in ${projectDir}; using path-less /mcp. ` +
      'Create one with `PROJECT_SLUG=<slug>` to pin scope automatically.\n',
  );
}

const url = `${baseUrl.replace(/\/+$/, '')}${scopedPath}`;
process.stderr.write(
  `[rembric-bridge] projectDir=${projectDir} (from ${projectDirSource}) url=${url}\n`,
);

// Advisory floor: warn (never block) below this; bump with plugin releases.
const MIN_SERVER_VERSION = '0.24.0';

function parseSemver(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(v ?? '');
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function isOlderThan(version, floor) {
  const a = parseSemver(version);
  const b = parseSemver(floor);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

async function checkServerVersion() {
  try {
    const res = await fetch(`${baseUrl.replace(/\/+$/, '')}/healthz`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return;
    const body = await res.json();
    if (body?.version && isOlderThan(body.version, MIN_SERVER_VERSION)) {
      process.stderr.write(
        `[rembric-bridge] server version ${body.version} is older than this plugin expects ` +
          `(${MIN_SERVER_VERSION}+); some features may not work. Update via the dashboard's ` +
          'one-click update or see docs/updates.md.\n',
      );
    }
  } catch {
    // Advisory only — an unreachable /healthz must never block the connection.
  }
}
// Fire-and-forget: runs concurrently with the mcp-remote spawn, delaying neither connect nor shutdown.
void checkServerVersion();

// Exact pin, never `@latest`: a floating tag re-resolves on every session
// start (network dependency, non-reproducible) and a broken upstream release
// would instantly hit all users. Bump deliberately with plugin releases.
const MCP_REMOTE_VERSION = '0.1.38';

// `mcp-remote` requires HTTPS by default and rejects plain HTTP (except
// for localhost). Rembric is commonly deployed on a LAN VPS reached over
// HTTP (e.g. http://192.168.x.y:8787), so we pass `--allow-http`
// unconditionally. For HTTPS deployments the flag is a no-op.
const child = spawn(
  'npx',
  [
    '-y',
    `mcp-remote@${MCP_REMOTE_VERSION}`,
    url,
    '--allow-http',
    '--header',
    `Authorization:Bearer ${token}`,
  ],
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
