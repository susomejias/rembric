import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';

import { EMBEDDING_MODEL_ID } from './embedder.js';

/**
 * Embedding-model identity marker. Vectors are only comparable when they
 * come from one model, so a model change (including the upgrade from the
 * external-provider era, which never wrote a marker) invalidates every
 * `memory_vec` row at once.
 *
 * The reset is the only non-incremental step: wipe the derived vectors,
 * record the new identity. From there the regular missing-vector drain
 * in `EmbeddingWorker` re-embeds the corpus in batches — resumable across
 * restarts by construction. `memory_vec` is derived data; wiping it does
 * not touch the append-only `memory` table.
 */

const MARKER_FILE = 'embedding-state.json';

interface EmbeddingState {
  modelId: string;
}

function readMarker(dataDir: string): EmbeddingState | null {
  try {
    const raw = readFileSync(join(dataDir, MARKER_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'modelId' in parsed) {
      return { modelId: String((parsed).modelId) };
    }
  } catch {
    // missing or unreadable marker — treated as "unknown model"
  }
  return null;
}

/**
 * Align `memory_vec` with the compiled-in model. Returns the number of
 * stale vectors wiped (0 when the marker already matches).
 */
export function ensureVectorModel(db: Db, dataDir: string): { wiped: number } {
  const marker = readMarker(dataDir);
  if (marker?.modelId === EMBEDDING_MODEL_ID) return { wiped: 0 };

  const count = db.get<{ v: number }>(sql`SELECT count(*) AS v FROM memory_vec`) as
    | { v: number }
    | undefined;
  const stale = count?.v ?? 0;
  if (stale > 0) {
    db.run(sql`DELETE FROM memory_vec`);
  }
  writeFileSync(
    join(dataDir, MARKER_FILE),
    JSON.stringify({ modelId: EMBEDDING_MODEL_ID } satisfies EmbeddingState, null, 2) + '\n',
  );
  return { wiped: stale };
}

/**
 * Calibration telemetry: nearest-neighbor cosine similarity percentiles
 * over a sample of recent vectors. Logged when the drain completes so the
 * shipped `VEC_THRESHOLD` constant can be sanity-checked against real
 * corpora (see `save-time-candidates.ts`).
 */
export function logSimilarityDistribution(db: Db, sample = 200): void {
  const rows = db.all<{ memory_id: string; sim: number }>(sql`
    SELECT v_self.memory_id AS memory_id,
           1 - MIN(vec_distance_cosine(v_self.embedding, v_other.embedding)) AS sim
    FROM memory_vec v_self
      JOIN memory_vec v_other ON v_other.memory_id != v_self.memory_id
    GROUP BY v_self.memory_id
    ORDER BY v_self.memory_id DESC
    LIMIT ${sample}
  `);
  if (rows.length < 5) return;
  const sims = rows.map((r) => r.sim).sort((a, b) => a - b);
  const pct = (p: number): string => sims[Math.floor((sims.length - 1) * p)]!.toFixed(3);
  console.error(
    `  ◆ embedding drain complete — nearest-neighbor similarity over ${sims.length} rows: p50=${pct(0.5)} p90=${pct(0.9)} max=${pct(1)} (VEC_THRESHOLD reference)`,
  );
}
