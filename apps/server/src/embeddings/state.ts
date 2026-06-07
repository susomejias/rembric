import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Repositories } from '../db/repositories/index.js';

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
      return { modelId: String(parsed.modelId) };
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
export function ensureVectorModel(
  repos: Pick<Repositories, 'vectors'>,
  dataDir: string,
): { wiped: number } {
  const marker = readMarker(dataDir);
  if (marker?.modelId === EMBEDDING_MODEL_ID) return { wiped: 0 };

  const stale = repos.vectors.count();
  if (stale > 0) {
    repos.vectors.deleteAll();
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
export function logSimilarityDistribution(
  repos: Pick<Repositories, 'vectors'>,
  sample = 200,
): void {
  const rows = repos.vectors.similaritySample(sample);
  if (rows.length < 5) return;
  const sims = rows.map((r) => r.sim).sort((a, b) => a - b);
  const pct = (p: number): string => sims[Math.floor((sims.length - 1) * p)]!.toFixed(3);
  console.error(
    `  ◆ embedding drain complete — nearest-neighbor similarity over ${sims.length} rows: p50=${pct(0.5)} p90=${pct(0.9)} max=${pct(1)} (VEC_THRESHOLD reference)`,
  );
}
