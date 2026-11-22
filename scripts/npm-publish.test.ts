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

const PROVENANCE = 'OK:{"provenance":{"predicateType":"https://slsa.dev/provenance/v1"}}';

function instantWait(bound: { timeoutMs?: number; intervalMs?: number } = {}): {
  timeoutMs: number;
  intervalMs: number;
  sleeps: number[];
  now: () => number;
  sleep: (ms: number) => Promise<void>;
} {
  let clock = 0;
  const sleeps: number[] = [];
  return {
    timeoutMs: bound.timeoutMs ?? 1000,
    intervalMs: bound.intervalMs ?? 10,
    sleeps,
    now: () => clock,
    sleep: (ms) => {
      sleeps.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  };
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
  it('skips a package when the exact version already exists', async () => {
    const packageDir = packageFixture();
    const npm = fakeNpm([
      'OK:"1.2.3"',
      'OK:{"provenance":{"predicateType":"https://slsa.dev/provenance/v1"}}',
    ]);

    await expect(publishPackage(packageDir, npm.command)).resolves.toBe(false);
    expect(readFileSync(npm.calls, 'utf8')).toBe(
      'view @rembric/example@1.2.3 version --json\n' +
        'view @rembric/example@1.2.3 dist.attestations --json\n',
    );
  });

  it('fails closed when an existing package has no provenance attestation', async () => {
    const packageDir = packageFixture();
    const npm = fakeNpm(['OK:"1.2.3"', 'OK:']);

    await expect(publishPackage(packageDir, npm.command)).rejects.toThrow(
      'published @rembric/example@1.2.3 has no npm provenance attestation',
    );
  });

  it('publishes a missing package after an exact-version 404', async () => {
    const packageDir = packageFixture();
    const npm = fakeNpm(['E404: E404 Not Found', 'PUBLISHED', 'OK:"1.2.3"', PROVENANCE]);

    await expect(publishPackage(packageDir, npm.command, instantWait())).resolves.toBe(true);
    expect(readFileSync(npm.calls, 'utf8')).toBe(
      'view @rembric/example@1.2.3 version --json\n' +
        'publish --provenance --access public\n' +
        'view @rembric/example@1.2.3 version --json\n' +
        'view @rembric/example@1.2.3 dist.attestations --json\n',
    );
  });

  it('fails closed when the registry check is not a not-found response', () => {
    const npm = fakeNpm(['FAIL:network unavailable']);

    expect(() => isPublished('@rembric/example', '1.2.3', npm.command)).toThrow(
      'could not determine whether @rembric/example@1.2.3 is published',
    );
  });
});

describe('npm publish waits until the registry serves the version', () => {
  it('keeps checking while npm has accepted the publish but does not serve it yet', async () => {
    const packageDir = packageFixture();
    const npm = fakeNpm([
      'E404: E404 Not Found',
      'PUBLISHED',
      'E404: E404 Not Found',
      'OK:"1.2.3"',
      PROVENANCE,
    ]);
    const wait = instantWait();

    await expect(publishPackage(packageDir, npm.command, wait)).resolves.toBe(true);
    expect(wait.sleeps).toEqual([wait.intervalMs]);
  });

  it('retries while the version is served before its provenance attestation', async () => {
    const packageDir = packageFixture();
    const npm = fakeNpm([
      'E404: E404 Not Found',
      'PUBLISHED',
      'OK:"1.2.3"',
      'OK:',
      'OK:"1.2.3"',
      PROVENANCE,
    ]);
    const wait = instantWait();

    await expect(publishPackage(packageDir, npm.command, wait)).resolves.toBe(true);
    expect(wait.sleeps).toHaveLength(1);
  });

  it('fails visibly when the registry never serves the version within the bound', async () => {
    const packageDir = packageFixture();
    const npm = fakeNpm([
      'E404: E404 Not Found',
      'PUBLISHED',
      ...Array.from({ length: 10 }, () => 'E404: E404 Not Found'),
    ]);
    const wait = instantWait({ timeoutMs: 30, intervalMs: 10 });

    await expect(publishPackage(packageDir, npm.command, wait)).rejects.toThrow(
      'npm accepted @rembric/example@1.2.3 but the registry did not serve it within 30 ms',
    );
    expect(wait.sleeps).toEqual([10, 10, 10]);
  });
});

describe('release workflow publish ordering', () => {
  it('keeps trusted publishing requirements in the workflow and helper', () => {
    expect(workflow).toContain('id-token: write');
    expect(workflow).not.toContain('NPM_TOKEN');
    expect(readFileSync(new URL('./npm-publish.mjs', import.meta.url), 'utf8')).toContain(
      "'--provenance'",
    );
  });
});
