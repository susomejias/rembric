import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const manifests = [
  join(root, 'apps/plugin/.claude-plugin/mcp.json'),
  join(root, 'apps/plugin/.codex-plugin/mcp.json'),
];

function updateWithReleasePlease(directory: string): string[] {
  execFileSync('npm', ['pack', '--silent', 'release-please@17.6.0'], {
    cwd: directory,
    stdio: 'ignore',
  });
  execFileSync(
    'npm',
    ['install', '--silent', '--ignore-scripts', '--no-package-lock', './release-please-17.6.0.tgz'],
    { cwd: directory, stdio: 'ignore' },
  );

  const genericJson = pathToFileURL(
    join(directory, 'node_modules/release-please/build/src/updaters/generic-json.js'),
  ).href;
  const version = pathToFileURL(
    join(directory, 'node_modules/release-please/build/src/version.js'),
  ).href;
  const script = `
    import { readFileSync } from 'node:fs';
    import { GenericJson } from ${JSON.stringify(genericJson)};
    import { Version } from ${JSON.stringify(version)};
    const updater = new GenericJson('$.mcpServers.rembric.args[1]', Version.parse('0.29.0'));
    const values = process.argv.slice(1).map((file) =>
      JSON.parse(updater.updateContent(readFileSync(file, 'utf8'))).mcpServers.rembric.args[1]
    );
    process.stdout.write(JSON.stringify(values));
  `;
  return JSON.parse(
    execFileSync(process.execPath, ['--input-type=module', '--eval', script, ...manifests], {
      encoding: 'utf8',
    }),
  ) as string[];
}

describe('release-please JSONPath pin updates', () => {
  it('17.6.0 GenericJson preserves the package prefix and advances both manifest pins', () => {
    const directory = mkdtempSync(join(tmpdir(), 'rembric-release-please-'));
    try {
      expect(updateWithReleasePlease(directory)).toEqual([
        '@rembric/mcp-bridge@0.29.0',
        '@rembric/mcp-bridge@0.29.0',
      ]);
      expect(
        manifests.map(
          (manifest) => JSON.parse(readFileSync(manifest, 'utf8')).mcpServers.rembric.args[1],
        ),
      ).toEqual(['@rembric/mcp-bridge@0.29.0', '@rembric/mcp-bridge@0.29.0']);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 120_000);
});
