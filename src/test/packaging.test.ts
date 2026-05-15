import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

/**
 * 12.1 / 12.2 — packaging shape.
 *
 * Verifies the tarball that `npm pack` would produce contains exactly
 * the files we want published, and nothing else:
 *
 *   - `dist/` (with type declarations)
 *   - `package.json`
 *   - `README.md`
 *   - `LICENSE`
 *   - `examples/`
 *
 * Specifically asserts: no `src/` source files, no test files, no
 * `.tsbuildinfo`, no editor / config dotfiles, no migration directory
 * outside `dist/db/migrations`.
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');

let cachedFiles: string[] | undefined;

function loadPackaged(): string[] {
  if (cachedFiles) return cachedFiles;
  const out = execFileSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  const start = out.indexOf('[');
  if (start === -1) throw new Error(`npm pack --json produced no array: ${out.slice(0, 200)}`);
  const json = JSON.parse(out.slice(start)) as Array<{ files: Array<{ path: string }> }>;
  cachedFiles = json[0]!.files.map((f) => f.path).sort();
  return cachedFiles;
}

describe('npm pack tarball shape', () => {
  // `npm pack` runs the `prepack` lifecycle (which builds `dist/`), so calling
  // it once up-front both warms the cache and ensures later tests aren't the
  // ones paying the build cost.
  beforeAll(() => {
    loadPackaged();
  });

  it('produces only the allow-listed top-level entries', () => {
    const files = loadPackaged();
    const allowedRoots = new Set(['dist', 'examples', 'package.json', 'README.md', 'LICENSE']);
    for (const f of files) {
      const root = f.split('/')[0]!;
      expect(allowedRoots, `tarball includes unexpected root '${root}' via '${f}'`).toContain(root);
    }
  });

  it('does not include any TypeScript source files', () => {
    const files = loadPackaged();
    const offenders = files.filter(
      (f) =>
        f.startsWith('src/') ||
        f.endsWith('.tsbuildinfo') ||
        f.endsWith('.test.ts') ||
        f.endsWith('.spec.ts'),
    );
    expect(
      offenders,
      `tarball contains forbidden source/test files: ${offenders.join(', ')}`,
    ).toEqual([]);
  });

  it('ships type declarations alongside compiled JS', () => {
    const files = loadPackaged();
    expect(files).toContain('dist/cli.js');
    expect(files).toContain('dist/cli.d.ts');
    expect(files).toContain('dist/index.js');
    expect(files).toContain('dist/index.d.ts');
  });

  it('ships migration SQL and dashboard public assets', () => {
    const files = loadPackaged();
    expect(files).toContain('dist/db/migrations/0000_initial_tables.sql');
    expect(files).toContain('dist/dashboard/public/assets/htmx.min.js');
    // CSS now comes from content-hashed bundles emitted by build-css.mjs.
    const cssBundles = files.filter((f) =>
      /^dist\/dashboard\/public\/assets\/styles\/core\.[0-9a-f]+\.css$/.test(f),
    );
    expect(cssBundles.length).toBeGreaterThanOrEqual(1);
    expect(files).toContain('dist/dashboard/public/assets/styles/manifest.json');
  });

  it('package.json `bin` points at a file that the tarball actually contains', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      bin: { rembric: string };
    };
    const binPath = pkg.bin.rembric.replace(/^\.\//, '');
    const files = loadPackaged();
    expect(files).toContain(binPath);
  });

  it('package.json `main` and `types` resolve to entries inside the tarball', () => {
    const pkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      main: string;
      types: string;
    };
    const files = loadPackaged();
    expect(files).toContain(pkg.main.replace(/^\.\//, ''));
    expect(files).toContain(pkg.types.replace(/^\.\//, ''));
  });
});
