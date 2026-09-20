import { z } from 'zod';

import { ok } from './result.js';

// Must track the canonical installer entrypoint owned by the tui-installer
// capability (repo-root install.sh shim). Never fork the URL or flag set here.
const INSTALLER_URL = 'https://raw.githubusercontent.com/susomejias/rembric/main/install.sh';

export interface AboutReport {
  server: {
    version: string;
    where: string;
    update: string;
  };
  plugins: {
    note: string;
    status: string;
    interactive: string;
    update_all: string;
    subset: string;
  };
  docs: string;
}

export function buildAboutReport(version: string): AboutReport {
  return {
    server: {
      version,
      where:
        'This Rembric server, running wherever you deployed it (e.g. your VPS). This version is the only thing this tool can see.',
      update: 'On the server host: docker compose pull && docker compose up -d',
    },
    plugins: {
      note: "Client plugins are installed per machine — one per computer where you use Rembric. This server cannot see them or their versions. On each machine, run `status` first (read-only): it reports the server and each plugin's installed-vs-available version with a per-agent `action` (none|update|ahead|unknown). `update_all` updates every installed plugin that has an update available and skips the rest (not-installed, already up to date, or ahead) — safe to run without checking `status` first.",
      status: `curl -fsSL ${INSTALLER_URL} | sh -s -- --status --json`,
      interactive: `curl -fsSL ${INSTALLER_URL} | sh`,
      update_all: `curl -fsSL ${INSTALLER_URL} | sh -s -- --action=update`,
      subset: `curl -fsSL ${INSTALLER_URL} | sh -s -- --action=update --agent=claude,codex`,
    },
    docs: 'https://github.com/susomejias/rembric#updating',
  };
}

export const aboutOutput = {
  server: z.object({ version: z.string(), where: z.string(), update: z.string() }),
  plugins: z.object({
    note: z.string(),
    status: z.string(),
    interactive: z.string(),
    update_all: z.string(),
    subset: z.string(),
  }),
  docs: z.string(),
};

// Exempt from the per-tool authorization gate: it accesses no stored data
// (mcp-api spec — every other tool is classified read/write and gated).
//
// A factory rather than a bare handler: the version it reports is the
// application's (`CreateMcpServerOptions.version` — bootstrap injects
// `REMBRIC_VERSION`), because a self-relative `package.json` read from inside
// this package would silently report `0.0.0`.
export function createAboutHandler(version: string) {
  return function handleAbout(_args: Record<string, never>) {
    void _args;
    return ok(buildAboutReport(version));
  };
}
