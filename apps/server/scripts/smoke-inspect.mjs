#!/usr/bin/env node
// Inspect Rembric DB state (counts in memory, memory_vec, consolidation_*) by
// reusing the application's DB initialization (loads sqlite-vec). Use:
//
//   REMBRIC_DATA_DIR=/tmp/rembric-smoke3 pnpm exec node scripts/smoke-inspect.mjs

import { createDb } from '../dist/db/index.js';

const dataDir = process.env.REMBRIC_DATA_DIR ?? `${process.env.HOME}/.rembric`;
const handle = createDb({ dataDir, readonly: true });

function scalar(sql) {
  const row = handle.raw.prepare(sql).get();
  return row ? Object.values(row)[0] : null;
}

const out = {
  dataDir,
  memory: {
    total: scalar('SELECT count(*) FROM memory'),
    active: scalar("SELECT count(*) FROM memory WHERE status='active'"),
    superseded: scalar("SELECT count(*) FROM memory WHERE status='superseded'"),
    archived: scalar("SELECT count(*) FROM memory WHERE status='archived'"),
  },
  embeddings: {
    vec_rows: scalar('SELECT count(*) FROM memory_vec'),
    pending: scalar(
      'SELECT count(*) FROM memory m LEFT JOIN memory_vec v ON v.memory_id = m.id WHERE v.memory_id IS NULL',
    ),
  },
  projects: scalar('SELECT count(*) FROM projects'),
  tokens: scalar('SELECT count(*) FROM tokens'),
  consolidation: {
    runs: scalar('SELECT count(*) FROM consolidation_runs'),
    ops: scalar('SELECT count(*) FROM consolidation_ops'),
    last_run_summary: scalar(
      'SELECT summary FROM consolidation_runs ORDER BY started_at DESC LIMIT 1',
    ),
  },
};

console.log(JSON.stringify(out, null, 2));
handle.close();
