#!/usr/bin/env node
// Prepares `apps/plugin/.pi-plugin` for publish and asserts what it packs.
//
//   node scripts/pi-package.mjs materialize
//   node scripts/pi-package.mjs assert-pack
//
// `materialize` is idempotent: a second run finds the specifiers already
// repointed and rewrites the resources from their shared originals again.
//
// Both halves are explicit CI steps rather than lifecycle scripts: whether a
// `prepack` runs depends on the cwd of the publish command, because the project
// `.npmrc` resolves from the nearest `package.json` — so a materialisation
// hung off `prepack` would silently ship a tarball missing its shared modules.
// See openspec/specs/supply-chain-hygiene/spec.md.

import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { underscoreToolNames } from '../apps/plugin/bin/rembric-plugin-core.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
const pluginRoot = join(repoRoot, 'apps/plugin');
const pkgDir = join(pluginRoot, '.pi-plugin');

const indexPath = join(pkgDir, 'index.ts');
const COMMANDS = readdirSync(join(pluginRoot, 'commands'))
  .filter((f) => f.endsWith('.md'))
  .sort();

const RELATIVE_IMPORT = /from\s+'(\.[^']*)'/g;
// `index.ts` sits at the package root, so a specifier reaching `../bin/` in the
// repo has to reach `./bin/` once packed. Both forms are accepted here so
// assert-pack reads the same module set after materialize rewrote them.
const PACKABLE_IMPORT = /^\.{1,2}\/bin\/([\w.-]+\.mjs)$/;

function fail(message) {
  process.stderr.write(`[pi-package] ${message}\n`);
  process.exit(1);
}

// Read off index.ts rather than listed: a shared import a hand-written list
// missed would materialise, pack and publish cleanly, then fail to resolve on
// the consumer's machine. `import type` and a value import of the same module
// collapse to one entry.
function sharedModules() {
  const specifiers = [...readFileSync(indexPath, 'utf8').matchAll(RELATIVE_IMPORT)].map(
    (m) => m[1],
  );
  const stray = specifiers.filter((s) => !PACKABLE_IMPORT.test(s));
  if (stray.length > 0) {
    fail(
      `index.ts imports ${stray.join(', ')} — only '../bin/<module>.mjs' specifiers can be materialised, so this one would ship unresolvable`,
    );
  }
  const modules = [...new Set(specifiers.map((s) => PACKABLE_IMPORT.exec(s)[1]))].sort();
  if (modules.length === 0)
    fail('index.ts imports no shared module — the expected list would be empty');
  return modules;
}

function materialize() {
  const shared = sharedModules();
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  mkdirSync(join(pkgDir, 'commands'), { recursive: true });

  for (const mod of shared) {
    copyFileSync(join(pluginRoot, 'bin', mod), join(pkgDir, 'bin', mod));
  }

  // The shared templates name the tools the way the server publishes them, and
  // Pi ships them verbatim to the model through `pi.prompts` — but this client
  // registers the tools with each dot replaced, so a template telling the model
  // to call the dotted name names nothing in its registry. Rewritten in the
  // COPIES only: the shared originals stay exact for the four clients that
  // register the canonical names, and nothing is duplicated in git.
  let renamed = 0;
  for (const cmd of COMMANDS) {
    const source = readFileSync(join(pluginRoot, 'commands', cmd), 'utf8');
    const rewritten = underscoreToolNames(source);
    if (rewritten !== source) renamed += 1;
    writeFileSync(join(pkgDir, 'commands', cmd), rewritten);
  }

  const before = readFileSync(indexPath, 'utf8');
  let after = before;
  let rewrote = 0;
  let alreadyPacked = 0;
  for (const mod of shared) {
    const dev = `'../bin/${mod}'`;
    const packed = `'./bin/${mod}'`;
    if (after.includes(dev)) {
      after = after.split(dev).join(packed);
      rewrote += 1;
    } else if (after.includes(packed)) {
      // Re-running materialize is normal (a retried CI step, a local publish
      // rehearsal), and there is nothing left to rewrite. Distinguished from
      // drift rather than merged with it: real drift is a specifier this step
      // cannot materialise at all, which sharedModules() already refuses by
      // name — the two must not share one message.
      alreadyPacked += 1;
    } else {
      fail(
        `${mod} is imported under neither '../bin/' nor './bin/' — index.ts changed underneath this run`,
      );
    }
  }
  for (const mod of shared) {
    if (after.includes(`'../bin/${mod}'`)) fail(`'../bin/${mod}' survived the rewrite`);
    if (!after.includes(`'./bin/${mod}'`)) fail(`'./bin/${mod}' is absent after the rewrite`);
  }
  writeFileSync(indexPath, after);

  process.stdout.write(
    `[pi-package] materialised ${shared.length} shared modules and ${COMMANDS.length} commands; ` +
      `renamed tools in ${renamed} of ${COMMANDS.length} commands; ` +
      `rewrote ${rewrote} import specifiers (${alreadyPacked} already materialised)\n`,
  );
}

function expectedFiles() {
  return [
    // npm packs the manifest and the README whatever `files` says.
    'package.json',
    'README.md',
    'index.ts',
    ...sharedModules().map((m) => `bin/${m}`),
    ...COMMANDS.map((c) => `commands/${c}`),
  ].sort();
}

function assertPack() {
  // --ignore-scripts so the assertion cannot depend on lifecycle behaviour that
  // is itself cwd-dependent; the manifest declares none (invariants.test.ts).
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: pkgDir,
    encoding: 'utf8',
  });
  const packed = JSON.parse(out)[0]
    .files.map((f) => f.path)
    .sort();
  const expected = expectedFiles();

  const problems = [];
  for (const f of expected) {
    if (!packed.includes(f)) problems.push(`missing from the tarball: ${f}`);
  }
  for (const f of packed) {
    if (!expected.includes(f)) problems.push(`unexpected in the tarball: ${f}`);
  }

  process.stdout.write(`[pi-package] npm pack --dry-run listed ${packed.length} files:\n`);
  for (const f of packed) process.stdout.write(`  ${f}\n`);

  if (problems.length > 0) {
    fail(`tarball contents do not match the expected list:\n  - ${problems.join('\n  - ')}`);
  }
  process.stdout.write('[pi-package] tarball contents match the expected list\n');
}

const command = process.argv[2];
if (command === 'materialize') materialize();
else if (command === 'assert-pack') assertPack();
else fail(`unknown command ${command ?? '(none)'} — expected materialize or assert-pack`);
