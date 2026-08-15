#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const packageDir = join(repoRoot, 'apps/plugin/mcp-bridge');
const expected = [
  'README.md',
  'bridge.mjs',
  'cli.mjs',
  'package.json',
  'rembric-dotenv.mjs',
  'slug.mjs',
];

function fail(message) {
  process.stderr.write(`[mcp-bridge-package] ${message}\n`);
  process.exit(1);
}

if (process.argv[2] !== 'assert-pack') {
  fail(`unknown command ${process.argv[2] ?? '(none)'} — expected assert-pack`);
}

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: packageDir,
  encoding: 'utf8',
});
let packed;
try {
  const manifest = JSON.parse(output)[0];
  packed = manifest.files.map((file) => file.path).sort();
} catch {
  fail('npm pack returned invalid JSON');
}
const problems = [
  ...expected.filter((file) => !packed.includes(file)).map((file) => `missing: ${file}`),
  ...packed.filter((file) => !expected.includes(file)).map((file) => `unexpected: ${file}`),
];
if (problems.length > 0) fail(`tarball contents differ:\n  - ${problems.join('\n  - ')}`);
process.stdout.write('[mcp-bridge-package] tarball contents match the expected list\n');
