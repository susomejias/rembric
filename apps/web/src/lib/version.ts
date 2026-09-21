import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

// Declared before `REMBRIC_VERSION` on purpose. Its initializer runs at module
// evaluation and reaches these bindings; a `const` declared after it would still
// be in its temporal dead zone then and throw (`ReferenceError: Cannot access
// 'ROOT_SEARCH_DEPTH' before initialization`).
const SENTINEL_VERSION = '0.0.0';
const RELEASE_MANIFEST = join('apps', 'web', 'package.json');
const VERSION_PATTERN = /^v?\d+\.\d+\.\d+$/;
/**
 * Three steps reach the repository root from the app directory
 * (`<root>/apps/web` → `<root>/apps` → `<root>`); four leaves one level of slack
 * for a nested install without letting the walk leave the deployment.
 */
const ROOT_SEARCH_DEPTH = 4;

/**
 * The running release identity — read from `apps/web`'s manifest at module
 * load, never written down here.
 *
 * `apps/web/package.json` IS the server release identity: release-please owns the
 * `server` component anchored on `apps/web`, tags it `server-v<version>`, and
 * bumps this one field. Spelling the release out in this file would make the
 * brand lie from the next release onwards — the version it prints is the version
 * that is running.
 *
 * The file is read rather than imported because it is the app's own manifest,
 * outside the module graph, and its path is computed at runtime — which is also
 * why `apps/web/Dockerfile` copies it into the standalone tree explicitly. The
 * repository root is found by walking up from the working directory, which is
 * the app directory in both layouts (`<root>/apps/web` in a checkout,
 * `/app/apps/web` in the standalone image), so no absolute path is baked in.
 *
 * `node:fs` makes this module server-only: the rail's brand is a client
 * component and takes the resolved string as a prop (`dashboard/layout.tsx`).
 * Importing it from a client module would pull a Node builtin into the browser
 * bundle.
 *
 * `REMBRIC_VERSION` is the one fallback: in a pinned deployment it is the compose
 * version pin (`docker-compose.yml` resolves the image tag from it and
 * `env_file` passes it inside), so it names the running image when the manifest
 * is not on disk. It is only trusted when it parses as a version.
 *
 * `'0.0.0'` is the sentinel a package.json still carrying its bootstrap version
 * falls to. It cannot be mistaken for a release, which is the point: an
 * unresolved identity must not read as a plausible one.
 */
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
