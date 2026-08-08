import { spawnSync } from 'node:child_process';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

// The JS twin of install.test.ts's "aborts loudly when the import rewrite
// no-ops". Both halves of the same mechanism repoint `../bin/` specifiers, and
// this one fails in the registry — with a tarball already published — rather
// than in the installing user's face.

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PI_INDEX = 'apps/plugin/.pi-plugin/index.ts';

// A tool name as the server publishes it. Pi registers each dot as an
// underscore, so a template shipped with the dotted form names nothing in the
// registry the model can see.
const DOTTED_TOOL_NAME = /\b(?:memory|project)\.[a-z]/;

let root: string;
let shared: string[];

// pi-package.mjs resolves everything from its own location, so a copy of the
// tree it reads drives it against a throwaway package: the real .pi-plugin is
// never materialised and the repo's index.ts is never rewritten.
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'rembric-pipack-'));
  mkdirSync(join(root, 'scripts'), { recursive: true });
  mkdirSync(join(root, 'apps', 'plugin'), { recursive: true });
  cpSync(join(REPO_ROOT, 'scripts', 'pi-package.mjs'), join(root, 'scripts', 'pi-package.mjs'));
  for (const rel of ['apps/plugin/bin', 'apps/plugin/commands', 'apps/plugin/.pi-plugin']) {
    cpSync(join(REPO_ROOT, rel), join(root, rel), { recursive: true });
  }
  shared = [
    ...new Set([...indexText().matchAll(/from\s+'\.\.\/bin\/([\w.-]+\.mjs)'/g)].map((m) => m[1])),
  ];
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function pkg(...parts: string[]): string {
  return join(root, 'apps', 'plugin', '.pi-plugin', ...parts);
}

function indexText(): string {
  return readFileSync(pkg('index.ts'), 'utf8');
}

function runPiPackage(command: string): { code: number; out: string } {
  const res = spawnSync(process.execPath, [join(root, 'scripts', 'pi-package.mjs'), command], {
    encoding: 'utf8',
  });
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
}

describe('materialize', () => {
  it('copies every shared module index.ts imports and repoints the specifiers', () => {
    expect(shared.length, `${PI_INDEX} imports no shared module`).toBeGreaterThan(0);
    const { code, out } = runPiPackage('materialize');
    expect(code).toBe(0);
    expect(out).toContain(`materialised ${shared.length} shared modules`);
    for (const mod of shared) {
      expect(readFileSync(pkg('bin', mod), 'utf8').length).toBeGreaterThan(0);
      expect(indexText()).toContain(`'./bin/${mod}'`);
      expect(indexText()).not.toContain(`'../bin/${mod}'`);
    }
  });

  it('picks up a shared import added without editing the script', () => {
    // The derivation is the whole point: a further `../bin/` import has to
    // travel with no list to keep in sync. rembric-bridge.mjs is a real module
    // the package does not ship today.
    writeFileSync(
      pkg('index.ts'),
      `import { probe } from '../bin/rembric-bridge.mjs';\n${indexText()}`,
    );
    const { code, out } = runPiPackage('materialize');
    expect(code).toBe(0);
    expect(out).toContain(`materialised ${shared.length + 1} shared modules`);
    expect(readFileSync(pkg('bin', 'rembric-bridge.mjs'), 'utf8').length).toBeGreaterThan(0);
    expect(runPiPackage('assert-pack').code).toBe(0);
  });

  it('refuses an index.ts with no shared import at all rather than expect nothing', () => {
    writeFileSync(pkg('index.ts'), 'export const RembricExtension = () => ({});\n');
    const { code, out } = runPiPackage('materialize');
    expect(code).toBe(1);
    expect(out).toContain('imports no shared module');
  });

  it('is idempotent — a second run succeeds and leaves the package byte-identical', () => {
    const first = runPiPackage('materialize');
    expect(first.code).toBe(0);
    expect(first.out).toContain(
      `rewrote ${shared.length} import specifiers (0 already materialised)`,
    );
    const packedIndex = indexText();

    const second = runPiPackage('materialize');
    expect(second.code).toBe(0);
    expect(second.out).toContain(
      `rewrote 0 import specifiers (${shared.length} already materialised)`,
    );
    expect(indexText()).toBe(packedIndex);
    expect(runPiPackage('assert-pack').code).toBe(0);
  });

  it('rewrites the tool names in the packaged command templates, not in the shared originals', () => {
    const originals = readdirSync(join(REPO_ROOT, 'apps', 'plugin', 'commands')).filter((f) =>
      f.endsWith('.md'),
    );
    // Control: the shared templates really do name the dotted tools, so the
    // assertion below is about a rewrite that had something to do.
    const dotted = originals.filter((f) =>
      DOTTED_TOOL_NAME.test(readFileSync(join(REPO_ROOT, 'apps', 'plugin', 'commands', f), 'utf8')),
    );
    expect(dotted.length).toBeGreaterThan(0);

    const { code, out } = runPiPackage('materialize');
    expect(code).toBe(0);
    expect(out).toContain(`renamed tools in ${dotted.length} of ${originals.length} commands`);

    for (const f of originals) {
      const copy = readFileSync(pkg('commands', f), 'utf8');
      expect(copy, `commands/${f} still names a dotted tool`).not.toMatch(DOTTED_TOOL_NAME);
      // The originals are the four other clients' source of truth and must not
      // have been touched in place.
      expect(readFileSync(join(REPO_ROOT, 'apps', 'plugin', 'commands', f), 'utf8')).toBe(
        readFileSync(join(root, 'apps', 'plugin', 'commands', f), 'utf8'),
      );
    }
    for (const f of dotted) {
      expect(readFileSync(pkg('commands', f), 'utf8')).toMatch(/\b(?:memory|project)_[a-z]/);
    }
  });

  it('aborts on a specifier it cannot materialise, leaving index.ts alone', () => {
    const drifted = shared[0];
    writeFileSync(
      pkg('index.ts'),
      indexText().replace(`'../bin/${drifted}'`, `'./lib/${drifted}'`),
    );
    const { code, out } = runPiPackage('materialize');
    expect(code).toBe(1);
    expect(out).toContain(`./lib/${drifted}`);
    expect(out).not.toMatch(/materialised \d+ shared modules/); // no partial rewrite called done
    expect(indexText()).toContain(`'./lib/${drifted}'`); // untouched, so nothing was packed over
  });
});

describe('assert-pack', () => {
  beforeEach(() => {
    expect(runPiPackage('materialize').code).toBe(0);
  });

  it('control — a faithfully materialised package matches the expected list', () => {
    const { code, out } = runPiPackage('assert-pack');
    expect(code).toBe(0);
    expect(out).toContain('tarball contents match the expected list');
  });

  it('fails when a resource index.ts imports never reached the package', () => {
    rmSync(pkg('bin', shared[0]));
    const { code, out } = runPiPackage('assert-pack');
    expect(code).toBe(1);
    expect(out).toContain(`missing from the tarball: bin/${shared[0]}`);
  });

  it('fails when a file the allowlist admits appears without being expected', () => {
    writeFileSync(pkg('commands', 'stowaway.md'), '# not in apps/plugin/commands\n');
    const { code, out } = runPiPackage('assert-pack');
    expect(code).toBe(1);
    expect(out).toContain('unexpected in the tarball: commands/stowaway.md');
  });
});
