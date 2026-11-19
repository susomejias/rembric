import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * Guards the `server` component's release anchor.
 *
 * release-please runs in manifest mode, where it matches each configured package to
 * its recorded version **by directory path**, and attributes a commit to a component by
 * the paths it touches. The `server` component is anchored on the repository root so a
 * commit under `packages/*` releases it as one under `apps/web` does; its `exclude-paths`
 * keep out what never reaches the image, and `apps/web/package.json` stays the version
 * the running server reads. A config key with no manifest entry re-bootstraps the
 * component at `0.0.0`, and a forwarded output for the wrong path silently breaks the
 * Docker publish gate.
 *
 * Static, no network: it reads the three files and nothing else.
 */

const root = fileURLToPath(new URL('..', import.meta.url));

type PackageConfig = {
  component?: string;
  'package-name'?: string;
  'changelog-path'?: string;
  'exclude-paths'?: string[];
  'extra-files'?: { type?: string; path?: string; jsonpath?: string }[];
};

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

  it('anchors the server component on the repository root, with apps/web/package.json as its version carrier', () => {
    const server = Object.entries(packages).find(([, entry]) => entry.component === 'server');
    if (server === undefined) throw new Error('no package declares component: server');
    const [serverPath, serverConfig] = server;

    expect(serverPath).toBe('.');
    expect(serverConfig['package-name']).toBe('@rembric/web');
    expect(serverConfig['changelog-path']).toBe('apps/web/CHANGELOG.md');
    expect(serverConfig['extra-files']).toContainEqual({
      type: 'json',
      path: 'apps/web/package.json',
      jsonpath: '$.version',
    });
    expect(packageVersion('apps/web')).toBe(manifest['.']);

    // Every declared component, not just `server`: the manifest value is the version
    // release-please last wrote, so it must be what the path's package.json holds.
    for (const [path, version] of Object.entries(manifest)) {
      expect({ path, version: packageVersion(path) }).toEqual({ path, version });
    }
  });

  it('excludes the other component and only directories the image is not built from', () => {
    const excluded = packages['.']?.['exclude-paths'] ?? [];
    const others = Object.keys(packages).filter((path) => path !== '.');
    expect(others.length).toBeGreaterThan(0);
    for (const path of others) expect(excluded).toContain(path);

    const dockerfile = readFileSync(join(root, 'apps/web/Dockerfile'), 'utf8');
    const copied = [...dockerfile.matchAll(/^COPY (?!--from)(.+) \S+$/gm)]
      .flatMap((match) => (match[1] ?? '').split(/\s+/))
      .filter((source) => !source.startsWith('--'));
    expect(copied).toContain('packages/core');

    const covers = (dir: string, file: string): boolean =>
      file === dir || file.startsWith(`${dir}/`);
    for (const dir of excluded) {
      expect(existsSync(join(root, dir)), `${dir} does not exist`).toBe(true);
      const shipped = copied.filter(
        (source) => covers(dir, source) && source !== 'apps/plugin/package.json',
      );
      expect({ dir, shipped }).toEqual({ dir, shipped: [] });
    }
  });

  it('gates the Docker publish on the root component, whose outputs the action emits unprefixed', () => {
    const workflow = readFileSync(join(root, '.github/workflows/release-please.yml'), 'utf8');
    expect(workflow).toContain(
      'server_release_created: ${{ steps.release.outputs.release_created }}',
    );
    expect(workflow).toContain('server_tag_name: ${{ steps.release.outputs.tag_name }}');
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
