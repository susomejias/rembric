// Test-only helpers — DO NOT distribute. opencode iterates every export of a
// plugin file and invokes each as a Plugin function with ctx. To survive that
// load-time scan, the distributed plugin.ts MUST export ONLY `RembricPlugin`
// and inline the helpers as non-exported functions.
//
// This file mirrors those internal helpers verbatim so `plugin.test.ts` can
// exercise them in isolation. An invariant test
// (`src/test/invariants.test.ts::plugin opencode helpers parity`) reads both
// files and fails if the helper bodies drift between them.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SLUG_RE = /^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$/;

export function parseDotenv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
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

export function readRembricSlug(directory: string): string | null {
  const file = join(directory, '.rembric');
  if (!existsSync(file)) return null;
  let raw: string;
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
