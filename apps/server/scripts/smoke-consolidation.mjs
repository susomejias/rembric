#!/usr/bin/env node
// Trigger a one-shot consolidation pass against an existing Rembric DB and
// print the run summary + per-op detail. Use:
//
//   REMBRIC_DATA_DIR=/tmp/rembric-smoke3 \
//   OPENAI_BASE_URL=http://192.168.20.45:11434/v1 \
//   OPENAI_API_KEY=ollama \
//   OPENAI_MODEL=qwen2.5:7b-instruct-q4_K_M \
//   OPENAI_EMBEDDING_MODEL=nomic-embed-text:latest \
//   pnpm exec node scripts/smoke-consolidation.mjs

import { ConsolidationRunner } from '../dist/consolidation/index.js';
import { loadConfig } from '../dist/config.js';
import { createDb } from '../dist/db/index.js';
import { LlmClient } from '../dist/llm/index.js';
import { EmbeddingWorker } from '../dist/services/embedding-worker.js';

const config = loadConfig();
const handle = createDb({ dataDir: config.dataDir });

const chatLlm = new LlmClient({ baseUrl: config.llm.baseUrl, apiKey: config.llm.apiKey });
const embeddingLlm = new LlmClient({
  baseUrl: config.embedding.baseUrl,
  apiKey: config.embedding.apiKey,
});
const embeddingWorker = config.embedding.enabled
  ? new EmbeddingWorker({ db: handle.db, client: embeddingLlm, model: config.embedding.model })
  : null;

const runner = new ConsolidationRunner({
  db: handle.db,
  llm: chatLlm,
  model: config.llm.model,
  batchSize: 50,
  embeddingWorker,
});

const start = Date.now();
const summary = await runner.runAll();
const ms = Date.now() - start;

const ops = handle.raw
  .prepare(
    'SELECT id, op_type, affected_ids, created_id, reasoning, applied_at FROM consolidation_ops ORDER BY applied_at DESC LIMIT 20',
  )
  .all();

console.log(JSON.stringify({ ms, summary, ops }, null, 2));
handle.close();
