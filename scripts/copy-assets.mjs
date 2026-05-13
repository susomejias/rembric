#!/usr/bin/env node
/**
 * Post-build asset copy.
 *
 * The TypeScript compiler only emits .ts → .js. We also need migration SQL
 * files and (later) dashboard static assets in dist/. This script mirrors
 * those non-TS artifacts from src/ into dist/.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const targets = [
  { from: 'src/db/migrations', to: 'dist/db/migrations', glob: '**/*.sql' },
  { from: 'src/dashboard/public', to: 'dist/dashboard/public', glob: '**/*' },
];

for (const { from, to } of targets) {
  const src = join(root, from);
  const dst = join(root, to);
  if (!existsSync(src)) continue;
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log(`copied ${from} → ${to}`);
}
