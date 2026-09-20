#!/usr/bin/env node
/**
 * Post-build asset copy.
 *
 * The TypeScript compiler only emits .ts → .js; dashboard static assets still
 * have to be mirrored from src/ into dist/. Migrations used to be here too —
 * they moved with the data layer, and `packages/db` copies its own (see
 * `packages/db/scripts/copy-migrations.mjs`). Copying them from here would
 * resurrect a second, unreferenced copy of files whose names are primary keys
 * in `_migrations`.
 */

import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const targets = [{ from: 'src/dashboard/public', to: 'dist/dashboard/public', glob: '**/*' }];

for (const { from, to } of targets) {
  const src = join(root, from);
  const dst = join(root, to);
  if (!existsSync(src)) continue;
  mkdirSync(dirname(dst), { recursive: true });
  cpSync(src, dst, { recursive: true });
  console.log(`copied ${from} → ${to}`);
}
