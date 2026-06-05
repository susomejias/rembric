#!/usr/bin/env node
// Build-time model bake. Downloads the pinned embedding model into the
// given cache dir USING the same library + revision the server loads at
// runtime, then validates the pipeline functionally (dims + similarity
// bounds from the 2026-06-05 calibration battery). A drifted or corrupt
// artifact fails the image build instead of production.
//
//   node scripts/fetch-model.mjs /models

import { env, pipeline } from '@huggingface/transformers';

const MODEL_ID = 'onnx-community/gte-multilingual-base';
const REVISION = '2edbf5e672aab465f9ed4c154a8b61791c082c69';
const DTYPE = 'q8';
const DIMS = 768;

const target = process.argv[2];
if (!target) {
  console.error('usage: fetch-model.mjs <cache-dir>');
  process.exit(2);
}
env.cacheDir = target;

console.error(`fetch-model: ${MODEL_ID}@${REVISION.slice(0, 7)} dtype=${DTYPE} → ${target}`);
const extractor = await pipeline('feature-extraction', MODEL_ID, {
  dtype: DTYPE,
  revision: REVISION,
});

const embed = async (text) => {
  const out = await extractor(text, { pooling: 'cls', normalize: true });
  return out.data;
};
const cos = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

const a = await embed('purgar las sesiones vacías de la base de datos');
const b = await embed('purge empty sessions from the database');
const c = await embed('el dashboard usa un tema oscuro brutalista');

if (a.length !== DIMS) {
  console.error(`fetch-model: FAIL — expected ${DIMS} dims, got ${a.length}`);
  process.exit(1);
}
const sameFact = cos(a, b);
const unrelated = cos(a, c);
if (sameFact < 0.75 || unrelated > 0.6) {
  console.error(
    `fetch-model: FAIL — similarity bounds violated (same-fact=${sameFact.toFixed(3)} expected >0.75, unrelated=${unrelated.toFixed(3)} expected <0.6)`,
  );
  process.exit(1);
}
console.error(
  `fetch-model: OK — same-fact=${sameFact.toFixed(3)} unrelated=${unrelated.toFixed(3)} rss=${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB`,
);
