#!/usr/bin/env node
/**
 * Dashboard CSS pipeline.
 *
 * Reads `src/dashboard/styles/core/*.css` (in fixed order) and
 * `src/dashboard/styles/views/*.css`, minifies via lightningcss, emits
 * content-hashed bundles into `dist/dashboard/public/assets/styles/` plus
 * a `manifest.json` that `templates.ts:shell()` consults to inject the
 * right `<link>` per view.
 *
 * Idempotent: same input → identical output (hashes derived from content).
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { transform } from 'lightningcss';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const stylesSrc = join(root, 'src/dashboard/styles');
const stylesDst = join(root, 'dist/dashboard/public/assets/styles');
const viewsDst = join(stylesDst, 'views');

const CORE_ORDER = [
  'tokens.css',
  'base.css',
  'atoms.css',
  'layout.css',
  'patterns.css',
  'content.css',
];

function shortHash(buf) {
  return createHash('sha256').update(buf).digest('hex').slice(0, 8);
}

function minify(filename, source) {
  const { code, warnings } = transform({
    filename,
    code: Buffer.from(source),
    minify: true,
    sourceMap: false,
  });
  if (warnings && warnings.length) {
    for (const w of warnings) console.warn(`lightningcss: ${filename}: ${w.message}`);
  }
  return code;
}

function readCoreConcat() {
  const dir = join(stylesSrc, 'core');
  if (!existsSync(dir)) return null;
  let merged = '';
  for (const name of CORE_ORDER) {
    const p = join(dir, name);
    if (!existsSync(p)) {
      throw new Error(`build-css: missing required core file ${p}`);
    }
    merged += `/* ── ${name} ────────────────────────────────── */\n`;
    merged += readFileSync(p, 'utf8');
    merged += '\n';
  }
  return merged;
}

function readViews() {
  const dir = join(stylesSrc, 'views');
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => extname(f) === '.css')
    .map((f) => ({
      name: basename(f, '.css'),
      source: readFileSync(join(dir, f), 'utf8'),
      filename: f,
    }));
}

function main() {
  if (!existsSync(stylesSrc)) {
    console.log(
      `build-css: ${stylesSrc} does not exist yet — skipping (no design-system files to build).`,
    );
    return;
  }

  mkdirSync(stylesDst, { recursive: true });
  mkdirSync(viewsDst, { recursive: true });

  // Wipe existing hashed bundles so old hashes don't accumulate.
  for (const f of readdirSync(stylesDst)) {
    const p = join(stylesDst, f);
    if (f === 'views') continue;
    rmSync(p, { force: true });
  }
  for (const f of readdirSync(viewsDst)) {
    rmSync(join(viewsDst, f), { force: true });
  }

  const manifest = { core: null, views: {} };

  const core = readCoreConcat();
  if (core != null) {
    const minified = minify('core.css', core);
    const hash = shortHash(minified);
    const outName = `core.${hash}.css`;
    writeFileSync(join(stylesDst, outName), minified);
    manifest.core = outName;
    console.log(`build-css: core → ${outName} (${minified.length} bytes)`);
  } else {
    console.warn('build-css: no core/ directory found — manifest.core will be null.');
  }

  for (const view of readViews()) {
    const minified = minify(view.filename, view.source);
    const hash = shortHash(minified);
    const outName = `${view.name}.${hash}.css`;
    writeFileSync(join(viewsDst, outName), minified);
    manifest.views[view.name] = `views/${outName}`;
    console.log(`build-css: ${view.name} → views/${outName} (${minified.length} bytes)`);
  }

  writeFileSync(join(stylesDst, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.log(`build-css: manifest written (${Object.keys(manifest.views).length} views)`);
}

main();
