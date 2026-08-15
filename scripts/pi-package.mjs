#!/usr/bin/env node
// Prepares `apps/plugin/.pi-plugin` for publish (`materialize`, idempotent) and
// asserts what it packs (`assert-pack`). Both are explicit CI steps and never
// lifecycle scripts — see openspec/specs/supply-chain-hygiene/spec.md.

import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
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
// Source modules live either under `bin/` or the published bridge package; all
// become `./bin/` siblings in the Pi tarball after materialisation.
const PACKABLE_IMPORT = /^(?:\.\.\/(bin|mcp-bridge)|\.\/(bin))\/([\w.-]+\.mjs)$/;

function fail(message) {
  process.stderr.write(`[pi-package] ${message}\n`);
  process.exit(1);
}

// Read off index.ts rather than listed, so a shared import cannot be missed and
// ship unresolvable. `import type` and a value import collapse to one entry.
function sharedModules() {
  const specifiers = [...readFileSync(indexPath, 'utf8').matchAll(RELATIVE_IMPORT)].map(
    (match) => match[1],
  );
  const parsed = specifiers.map((specifier) => ({
    specifier,
    match: PACKABLE_IMPORT.exec(specifier),
  }));
  const stray = parsed.filter(({ match }) => match === null).map(({ specifier }) => specifier);
  if (stray.length > 0) {
    fail(
      `index.ts imports ${stray.join(', ')} — only '../bin/' or '../mcp-bridge/' modules can be materialised`,
    );
  }
  const modules = [
    ...new Map(
      parsed.map(({ specifier, match }) => [
        match[3],
        {
          specifier,
          sourceDir:
            match[1] ??
            (existsSync(join(pluginRoot, match[2], match[3])) ? match[2] : 'mcp-bridge'),
          name: match[3],
        },
      ]),
    ).values(),
  ];
  if (modules.length === 0)
    fail('index.ts imports no shared module — the expected list would be empty');
  return modules;
}

function materialize() {
  const shared = sharedModules();
  mkdirSync(join(pkgDir, 'bin'), { recursive: true });
  mkdirSync(join(pkgDir, 'commands'), { recursive: true });

  for (const mod of shared) {
    copyFileSync(join(pluginRoot, mod.sourceDir, mod.name), join(pkgDir, 'bin', mod.name));
  }

  // Rewritten in the COPIES only: the tracked originals must stay canonical for
  // the four clients that register the dotted names.
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
    const dev = `'${mod.specifier}'`;
    const packed = `'./bin/${mod.name}'`;
    if (mod.specifier.startsWith('../') && after.includes(dev)) {
      after = after.split(dev).join(packed);
      rewrote += 1;
    } else if (after.includes(packed)) {
      // Re-running materialize is normal and is not drift; drift is a specifier
      // this step cannot materialise, which sharedModules() refuses by name.
      alreadyPacked += 1;
    } else {
      fail(
        `${mod.specifier} is absent before materialisation — index.ts changed underneath this run`,
      );
    }
  }
  for (const mod of shared) {
    if (mod.specifier.startsWith('../') && after.includes(`'${mod.specifier}'`))
      fail(`'${mod.specifier}' survived the rewrite`);
    if (!after.includes(`'./bin/${mod.name}'`))
      fail(`'./bin/${mod.name}' is absent after the rewrite`);
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
    ...sharedModules().map((module) => `bin/${module.name}`),
    ...COMMANDS.map((c) => `commands/${c}`),
  ].sort();
}

function assertPack() {
  // --ignore-scripts so the assertion cannot depend on cwd-dependent lifecycle
  // behaviour; the manifest declares none (invariants.test.ts).
  const out = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: pkgDir,
    encoding: 'utf8',
  });
  let packed;
  try {
    packed = JSON.parse(out)[0]
      .files.map((file) => file.path)
      .sort();
  } catch {
    fail('npm pack returned invalid JSON');
  }
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
