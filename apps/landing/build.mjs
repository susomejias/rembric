// Minify the static landing into dist/ with esbuild (JS + CSS). HTML and
// binary assets are copied verbatim — Brotli/gzip on the host handles those.
// Source of truth is public/ (readable, dev-served); dist/ is the deploy output.
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import * as esbuild from 'esbuild';

const root = dirname(fileURLToPath(import.meta.url));
const SRC = join(root, 'public');
const OUT = join(root, 'dist');

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

await esbuild.build({
  entryPoints: [
    join(SRC, 'scripts/landing.js'),
    join(SRC, 'styles/tokens.css'),
    join(SRC, 'styles/landing.css'),
  ],
  outdir: OUT,
  outbase: SRC,
  minify: true,
  legalComments: 'none',
  target: ['es2019', 'chrome90', 'firefox90', 'safari14'],
});

await cp(join(SRC, 'assets'), join(OUT, 'assets'), { recursive: true });
for (const file of ['index.html', 'robots.txt', 'sitemap.xml', 'llms.txt']) {
  await cp(join(SRC, file), join(OUT, file));
}

console.log('landing built → apps/landing/dist');
