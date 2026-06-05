#!/usr/bin/env node
// Build-time model bake. Downloads the pinned embedding model, flattens
// it into the LOCAL-model layout transformers.js resolves offline
// (<target>/<model-id>/<files>), then re-validates the pipeline against
// the flattened files with networking disabled — exactly the resolution
// path the runtime uses. A drifted or corrupt artifact fails the image
// build instead of production.
//
//   node scripts/fetch-model.mjs /models

import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const MODEL_ID = 'onnx-community/gte-multilingual-base';
const REVISION = '2edbf5e672aab465f9ed4c154a8b61791c082c69';
const DTYPE = 'q8';
const DIMS = 768;

const target = process.argv[2];
if (!target) {
  console.error('usage: fetch-model.mjs <models-dir>');
  process.exit(2);
}

console.error(`fetch-model: ${MODEL_ID}@${REVISION.slice(0, 7)} dtype=${DTYPE} → ${target}`);

// Phase 1 — download at the pinned revision into a throwaway cache.
const tmpCache = join(target, '.cache-tmp');
{
  const { env, pipeline } = await import('@huggingface/transformers');
  env.cacheDir = tmpCache;
  await pipeline('feature-extraction', MODEL_ID, { dtype: DTYPE, revision: REVISION });
}

// Phase 2 — flatten the revision-qualified cache into the local-model
// layout (<target>/<model-id>/<files>), which offline resolution expects.
const modelDir = join(target, MODEL_ID);
mkdirSync(modelDir, { recursive: true });
const cachedModel = join(tmpCache, MODEL_ID);
const flatten = (dir, out) => {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      // Revision dirs collapse into the root; real subdirs (onnx/) keep their name.
      flatten(full, entry === REVISION ? out : join(out, entry));
    } else {
      mkdirSync(out, { recursive: true });
      cpSync(full, join(out, entry));
    }
  }
};
flatten(cachedModel, modelDir);
rmSync(tmpCache, { recursive: true, force: true });

// Phase 3 — offline validation of the SHIPPED layout, in a fresh process
// so phase-1 module state cannot mask a broken flatten.
const { execFileSync } = await import('node:child_process');
const validator = `
  const { env, pipeline } = await import('@huggingface/transformers');
  env.localModelPath = ${JSON.stringify(target)};
  env.allowRemoteModels = false;
  const extractor = await pipeline('feature-extraction', ${JSON.stringify(MODEL_ID)}, { dtype: ${JSON.stringify(DTYPE)} });
  const embed = async (t) => (await extractor(t, { pooling: 'cls', normalize: true })).data;
  const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const a = await embed('purge empty sessions from the database');
  const b = await embed('empty sessions get deleted from the database');
  const c = await embed('the dashboard uses a brutalist dark theme');
  if (a.length !== ${DIMS}) { console.error('fetch-model: FAIL — dims ' + a.length); process.exit(1); }
  const same = cos(a, b), unrel = cos(a, c);
  if (same < 0.7 || unrel > 0.65 || same - unrel < 0.05) {
    console.error('fetch-model: FAIL — bounds (same=' + same.toFixed(3) + ', unrelated=' + unrel.toFixed(3) + ')');
    process.exit(1);
  }
  console.error('fetch-model: OK — same-fact=' + same.toFixed(3) + ' unrelated=' + unrel.toFixed(3) + ' rss=' + Math.round(process.memoryUsage().rss / 1048576) + 'MB');
`;
execFileSync(process.execPath, ['--input-type=module', '-e', validator], { stdio: 'inherit' });
