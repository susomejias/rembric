import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = (
  JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  }
).scripts['test:hermes-plugin']!;

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function checkoutWithSuite(testBody: string): string {
  const root = mkdtempSync(join(tmpdir(), 'rembric-hermes-script-'));
  scratch.push(root);
  const tests = join(root, 'apps', 'plugin', '.hermes-plugin', 'tests');
  mkdirSync(tests, { recursive: true });
  writeFileSync(
    join(tests, 'test_probe.py'),
    `import unittest\n\n\nclass Probe(unittest.TestCase):\n    def test_probe(self):\n        ${testBody}\n`,
  );
  return root;
}

function run(cwd: string, path = process.env['PATH'] ?? '') {
  const res = spawnSync('/bin/sh', ['-c', script], {
    cwd,
    encoding: 'utf8',
    env: { PATH: path, HOME: cwd },
  });
  return { code: res.status, out: `${res.stdout}${res.stderr}` };
}

describe('pnpm run test:hermes-plugin', () => {
  it('fails when a Hermes test fails', () => {
    const { code, out } = run(checkoutWithSuite('self.fail("boom")'));
    expect(out).toContain('FAILED');
    expect(code).not.toBe(0);
  });

  it('control: passes when the Hermes tests pass', () => {
    const { code, out } = run(checkoutWithSuite('self.assertTrue(True)'));
    expect(out).toContain('OK');
    expect(code).toBe(0);
  });

  it('skips, and passes, where python3 is not installed', () => {
    const emptyBin = mkdtempSync(join(tmpdir(), 'rembric-hermes-nopython-'));
    scratch.push(emptyBin);
    const { code, out } = run(checkoutWithSuite('self.fail("must not run")'), emptyBin);
    expect(out).toContain('[skip] python3 not available');
    expect(code).toBe(0);
  });
});
