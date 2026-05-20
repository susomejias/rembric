// Shared dotenv + .rembric slug resolver for Rembric's JS/TS clients.
//
// Single source of truth for:
//   - `parseDotenv(content)` — parses dotenv-style `KEY=VALUE` lines
//     (comments via `#`, matched-quote stripping, trimming).
//   - `SLUG_RE` — the slug regex used by the Rembric server's path-scoping.
//   - `readRembricSlug(directory)` — reads `<directory>/.rembric`, extracts
//     `PROJECT_SLUG`, validates against `SLUG_RE`, returns the slug or null.
//
// Imported by:
//   - `apps/plugin/bin/rembric-bridge.mjs` (Claude Code, Codex CLI MCP transport)
//   - `apps/plugin/.opencode-plugin/plugin.ts` (opencode lifecycle handlers)
//
// Bash and Python clients (apps/plugin/scripts/_api.sh, apps/plugin/.hermes-plugin/
// __init__.py) keep their own dotenv parsers — cross-language sharing is
// not worth the wrapper-spawn overhead for a 20-line parser. The slug
// regex is documented in `openspec/specs/claude-code-plugin/spec.md` as
// the shared contract; all implementations MUST agree on it.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export function parseDotenv(content) {
  const out = {};
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

export function readRembricSlug(directory) {
  const file = join(directory, '.rembric');
  if (!existsSync(file)) return null;
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const cfg = parseDotenv(raw);
  const slug = cfg.PROJECT_SLUG;
  if (!slug) return null;
  return SLUG_RE.test(slug) ? slug : null;
}
