import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guards the `server` component's release anchor.
 *
 * release-please runs in manifest mode, where it matches each configured package to
 * its recorded version **by directory path**. The `server` component is anchored on
 * `apps/web` (the shipped app) while its channel — the `server-v*` tag and the
 * `publish-docker` trigger — stays put. Two files must therefore agree on the same
 * path, and the workflow's forwarded outputs must name paths that exist: a config key
 * with no manifest entry re-bootstraps the component at `0.0.0`, and a forwarded key
 * for a path that no longer exists silently breaks the Docker publish gate.
 *
 * Static, no network: it reads the three files and nothing else.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

type PackageConfig = { component?: string; 'package-name'?: string };

const config = JSON.parse(readFileSync(join(root, 'release-please-config.json'), 'utf8')) as {
  packages?: Record<string, PackageConfig>;
};
const manifest = JSON.parse(
  readFileSync(join(root, '.release-please-manifest.json'), 'utf8'),
) as Record<string, string>;

const packages = config.packages ?? {};

const packageVersion = (path: string): unknown =>
  (JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8')) as { version?: unknown })
    .version;

describe('release-please reanchor', () => {
  it('declares the same component paths in release-please-config.json and .release-please-manifest.json', () => {
    expect(Object.keys(packages).sort()).toEqual(Object.keys(manifest).sort());
  });

  it('anchors the server component on apps/web with the manifest version in its package.json', () => {
    const server = Object.entries(packages).find(([, entry]) => entry.component === 'server');
    if (server === undefined) throw new Error('no package declares component: server');
    const [serverPath, serverConfig] = server;

    expect(serverPath).toBe('apps/web');
    expect(serverConfig['package-name']).toBe('@rembric/web');

    // Every declared component, not just `server`: the manifest value is the version
    // release-please last wrote, so it must be what the path's package.json holds.
    for (const [path, version] of Object.entries(manifest)) {
      expect({ path, version: packageVersion(path) }).toEqual({ path, version });
    }
  });

  it('forwards per-path release-please outputs only for declared component paths', () => {
    const workflow = readFileSync(join(root, '.github/workflows/release-please.yml'), 'utf8');
    const forwarded = [...workflow.matchAll(/steps\.release\.outputs\['([^']+)'\]/g)].map(
      (match) => match[1],
    );

    // Non-empty first: a regex that matches nothing must not pass the check below.
    expect(forwarded.length).toBeGreaterThan(0);
    for (const key of forwarded) {
      if (key === undefined) continue;
      const path = key.split('--')[0];
      expect(Object.keys(manifest)).toContain(path);
    }
  });
});
