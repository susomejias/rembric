#!/usr/bin/env node
// Trigger a one-shot (forced) consolidation sweep against an existing
// Rembric DB and print the run summary + per-op detail. Use:
//
//   REMBRIC_DATA_DIR=/tmp/rembric-smoke3 \
//   pnpm exec node scripts/smoke-consolidation.mjs

import { ConsolidationRunner } from '../dist/consolidation/index.js';
import { loadConfig } from '../dist/config.js';
import { createDb } from '../dist/db/index.js';
import { RelationsService } from '../dist/services/relations.js';

const config = loadConfig();
const handle = createDb({ dataDir: config.dataDir });

const runner = new ConsolidationRunner({
  db: handle.db,
  relations: new RelationsService(handle.db),
  orphanDeadlineMs: config.judgments.orphanDeadlineMs,
});

const start = Date.now();
const summary = runner.runAll({ force: true });
const ms = Date.now() - start;

const ops = handle.raw
  .prepare(
    'SELECT id, op_type, affected_ids, created_id, reasoning, applied_at FROM consolidation_ops ORDER BY applied_at DESC LIMIT 20',
  )
  .all();

console.log(JSON.stringify({ ms, summary, ops }, null, 2));
handle.close();
