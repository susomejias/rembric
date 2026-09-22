import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SENTINEL_VERSION = '0.0.0';
const RELEASE_MANIFEST = join('apps', 'web', 'package.json');
const VERSION_PATTERN = /^v?\d+\.\d+\.\d+$/;
const ROOT_SEARCH_DEPTH = 4;

export const REMBRIC_VERSION = resolveVersion();

function resolveVersion(): string {
  const manifestVersion = readReleaseManifestVersion();
  if (manifestVersion !== null) return manifestVersion;

  const pin = process.env['REMBRIC_VERSION']?.trim();
  if (pin !== undefined && VERSION_PATTERN.test(pin)) return pin.replace(/^v/, '');

  return SENTINEL_VERSION;
}

function readReleaseManifestVersion(): string | null {
  const root = findRepositoryRoot();
  if (root === null) return null;

  try {
    const pkg = JSON.parse(readFileSync(join(root, RELEASE_MANIFEST), 'utf8')) as {
      version?: unknown;
    };
    return typeof pkg.version === 'string' && pkg.version.length > 0 ? pkg.version : null;
  } catch {
    return null;
  }
}

function findRepositoryRoot(): string | null {
  let dir = process.cwd();

  for (let depth = 0; depth < ROOT_SEARCH_DEPTH; depth++) {
    if (existsSync(join(dir, RELEASE_MANIFEST))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }

  return null;
}
