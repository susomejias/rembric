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
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

export function readRembricSlug(directory) {
  const file = join(directory, '.rembric');
  if (!existsSync(file)) return null;
  try {
    const slug = parseDotenv(readFileSync(file, 'utf8')).PROJECT_SLUG;
    return slug && SLUG_RE.test(slug) ? slug : null;
  } catch {
    return null;
  }
}
