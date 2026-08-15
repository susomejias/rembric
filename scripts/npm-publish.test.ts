import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { isPublished, publishPackage } from './npm-publish.mjs';

const workflow = readFileSync(
  new URL('../.github/workflows/release-please.yml', import.meta.url),
  'utf8',
);

let tempDirs: string[] = [];
afterEach(() => {
  for (const directory of tempDirs) rmSync(directory, { recursive: true, force: true });
  tempDirs = [];
});

function fakeNpm(responses: string[]): { command: string; calls: string } {
  const directory = mkdtempSync(join(tmpdir(), 'rembric-npm-publish-'));
  tempDirs.push(directory);
  const calls = join(directory, 'calls');
  const responseFile = join(directory, 'responses');
  writeFileSync(responseFile, `${responses.join('\n')}\n`);
  const command = join(directory, 'npm');
  writeFileSync(
    command,
    `#!/bin/sh
printf '%s\n' "$*" >> '${calls}'
IFS= read -r response < '${responseFile}' || response=''
tail -n +2 '${responseFile}' > '${responseFile}.next'
mv '${responseFile}.next' '${responseFile}'
if [ "$1" = publish ]; then exit 0; fi
case "$response" in
  OK:*) printf '%s' "\${response#OK:}"; exit 0 ;;
  E404:*) printf '%s' "\${response#E404:}" >&2; exit 1 ;;
  FAIL:*) printf '%s' "\${response#FAIL:}" >&2; exit 1 ;;
esac
exit 1
`,
  );
  chmodSync(command, 0o755);
  return { command, calls };
}

function packageFixture(): string {
  const directory = mkdtempSync(join(tmpdir(), 'rembric-package-'));
  tempDirs.push(directory);
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: '@rembric/example', version: '1.2.3' }),
  );
  return directory;
}

describe('npm publish retry safety', () => {
  it('skips a package when the exact version already exists', () => {
    const packageDir = packageFixture();
    const npm = fakeNpm([
      'OK:"1.2.3"',
      'OK:{"provenance":{"predicateType":"https://slsa.dev/provenance/v1"}}',
    ]);

    expect(publishPackage(packageDir, npm.command)).toBe(false);
    expect(readFileSync(npm.calls, 'utf8')).toBe(
      'view @rembric/example@1.2.3 version --json\n' +
        'view @rembric/example@1.2.3 dist.attestations --json\n',
    );
  });

  it('fails closed when an existing package has no provenance attestation', () => {
    const packageDir = packageFixture();
    const npm = fakeNpm(['OK:"1.2.3"', 'OK:']);

    expect(() => publishPackage(packageDir, npm.command)).toThrow(
      'published @rembric/example@1.2.3 has no npm provenance attestation',
    );
  });

  it('publishes a missing package after an exact-version 404', () => {
    const packageDir = packageFixture();
    const npm = fakeNpm(['E404: E404 Not Found', 'OK:"1.2.3"']);

    expect(publishPackage(packageDir, npm.command)).toBe(true);
    expect(readFileSync(npm.calls, 'utf8')).toBe(
      'view @rembric/example@1.2.3 version --json\npublish --provenance --access public\n',
    );
  });

  it('fails closed when the registry check is not a not-found response', () => {
    const npm = fakeNpm(['FAIL:network unavailable']);

    expect(() => isPublished('@rembric/example', '1.2.3', npm.command)).toThrow(
      'could not determine whether @rembric/example@1.2.3 is published',
    );
  });
});

describe('release workflow publish ordering', () => {
  it('asserts both tarballs before either idempotent publish step', () => {
    const piAssert = workflow.indexOf('node scripts/pi-package.mjs assert-pack');
    const bridgeAssert = workflow.indexOf('node scripts/mcp-bridge-package.mjs assert-pack');
    const piPublish = workflow.indexOf('node scripts/npm-publish.mjs apps/plugin/.pi-plugin');
    const bridgePublish = workflow.indexOf('node scripts/npm-publish.mjs apps/plugin/mcp-bridge');

    expect(piAssert).toBeGreaterThan(-1);
    expect(bridgeAssert).toBeGreaterThan(piAssert);
    expect(piPublish).toBeGreaterThan(bridgeAssert);
    expect(bridgePublish).toBeGreaterThan(piPublish);
  });

  it('keeps trusted publishing requirements in the workflow and helper', () => {
    expect(workflow).toContain('id-token: write');
    expect(workflow).not.toContain('NPM_TOKEN');
    expect(readFileSync(new URL('./npm-publish.mjs', import.meta.url), 'utf8')).toContain(
      "'--provenance'",
    );
  });
});
