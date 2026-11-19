#!/usr/bin/env node
// Build-time model bake. Downloads the pinned embedding and reranking models,
// flattens them into the LOCAL-model layout transformers.js resolves offline
// (<target>/<model-id>/<files>), then re-validates both against the flattened
// files with networking disabled — exactly the resolution path the runtime
// uses. A drifted or corrupt artifact fails the image build instead of
// production.
//
//   node scripts/fetch-model.mjs /models

import { cpSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import embedding from '../src/embeddings/model-identity.json' with { type: 'json' };
import reranking from '../src/rerank/model-identity.json' with { type: 'json' };

const target = process.argv[2];
if (!target) {
  console.error('usage: fetch-model.mjs <models-dir>');
  process.exit(2);
}

const MODELS = [
  { identity: embedding, load: 'embedder' },
  { identity: reranking, load: 'reranker' },
];

// Phase 1 — download each model at its pinned revision into a throwaway cache.
// Anonymous requests from shared CI runners get rate-limited by HF (429);
// transformers.js sends Authorization automatically when HF_TOKEN is set
// (wired as a Docker build secret), and transient failures retry with
// backoff. A non-transient error (bad revision, 401) fails immediately.
const tmpCache = join(target, '.cache-tmp');
const transformers = await import('@huggingface/transformers');
transformers.env.cacheDir = tmpCache;
const download = async ({ identity, load }) => {
  const opts = { revision: identity.revision };
  await transformers.AutoTokenizer.from_pretrained(identity.modelId, opts);
  const Model =
    load === 'embedder' ? transformers.AutoModel : transformers.AutoModelForSequenceClassification;
  await Model.from_pretrained(identity.modelId, { ...opts, dtype: identity.dtype });
};
for (const model of MODELS) {
  const ATTEMPTS = 5;
  const TRANSIENT = /\((429|5\d{2})\)|fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN/;
  console.error(
    `fetch-model: ${model.identity.modelId}@${model.identity.revision.slice(0, 7)} dtype=${model.identity.dtype} → ${target}`,
  );
  for (let attempt = 1; ; attempt++) {
    try {
      await download(model);
      break;
    } catch (err) {
      const msg = String(err?.message ?? err);
      if (attempt >= ATTEMPTS || !TRANSIENT.test(msg)) throw err;
      rmSync(join(tmpCache, model.identity.modelId), { recursive: true, force: true });
      const waitMs = 5000 * 2 ** (attempt - 1);
      console.error(
        `fetch-model: transient download failure (attempt ${attempt}/${ATTEMPTS}, retrying in ${waitMs / 1000}s): ${msg}`,
      );
      await new Promise((resolve) => setTimeout(resolve, waitMs));
    }
  }
}

// Phase 2 — flatten each revision-qualified cache into the local-model
// layout (<target>/<model-id>/<files>), which offline resolution expects.
for (const { identity } of MODELS) {
  const modelDir = join(target, identity.modelId);
  mkdirSync(modelDir, { recursive: true });
  const flatten = (dir, out) => {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        // Revision dirs collapse into the root; real subdirs (onnx/) keep their name.
        flatten(full, entry === identity.revision ? out : join(out, entry));
      } else {
        mkdirSync(out, { recursive: true });
        cpSync(full, join(out, entry));
      }
    }
  };
  flatten(join(tmpCache, identity.modelId), modelDir);
}
rmSync(tmpCache, { recursive: true, force: true });

// Phase 3 — offline validation of the SHIPPED layout, in a fresh process
// so phase-1 module state cannot mask a broken flatten. The embedder runs
// the runtime recipe (tokenizer + model + mean pooling, truncated to its
// pinned token cap); the reranker must rank a relevant memory first.
const { execFileSync } = await import('node:child_process');
const validator = `
  const t = await import('@huggingface/transformers');
  t.env.localModelPath = ${JSON.stringify(target)};
  t.env.allowRemoteModels = false;
  const e = ${JSON.stringify(embedding)};
  const r = ${JSON.stringify(reranking)};
  const tok = await t.AutoTokenizer.from_pretrained(e.modelId);
  const model = await t.AutoModel.from_pretrained(e.modelId, { dtype: e.dtype });
  const embed = async (text) => {
    const inputs = tok(text, { truncation: true, max_length: e.maxTokens });
    const out = await model(inputs);
    return t.mean_pooling(out.last_hidden_state, inputs.attention_mask).normalize(2, -1).data;
  };
  const cos = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
  const a = await embed('purge empty sessions from the database');
  const b = await embed('empty sessions get deleted from the database');
  const c = await embed('the dashboard uses a brutalist dark theme');
  if (a.length !== e.dims) { console.error('fetch-model: FAIL — dims ' + a.length); process.exit(1); }
  const same = cos(a, b), unrel = cos(a, c);
  if (same < 0.7 || unrel > 0.65 || same - unrel < 0.05) {
    console.error('fetch-model: FAIL — embedder bounds (same=' + same.toFixed(3) + ', unrelated=' + unrel.toFixed(3) + ')');
    process.exit(1);
  }
  const rtok = await t.AutoTokenizer.from_pretrained(r.modelId);
  const rmodel = await t.AutoModelForSequenceClassification.from_pretrained(r.modelId, { dtype: r.dtype });
  const q = 'what port does the scheduler listen on';
  const docs = ['The scheduler listens on port 8781.', 'The dashboard uses a dark theme.'];
  const { logits } = await rmodel(rtok([q, q], { text_pair: docs, padding: true, truncation: true }));
  if (!(logits.data[0] > logits.data[1])) {
    console.error('fetch-model: FAIL — reranker did not rank the relevant document first');
    process.exit(1);
  }
  console.error('fetch-model: OK — same-fact=' + same.toFixed(3) + ' unrelated=' + unrel.toFixed(3) + ' rerank=' + logits.data[0].toFixed(2) + '>' + logits.data[1].toFixed(2) + ' rss=' + Math.round(process.memoryUsage().rss / 1048576) + 'MB');
`;
execFileSync(process.execPath, ['--input-type=module', '-e', validator], { stdio: 'inherit' });
