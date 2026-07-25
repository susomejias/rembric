import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Repositories } from '../db/repositories/index.js';

import { EMBEDDING_INPUT_VERSION, EMBEDDING_MODEL_ID } from './embedder.js';

/**
 * Embedding identity marker. Vectors are only comparable when they come from
 * one model AND one input recipe, so a change on EITHER axis — the model id
 * (including the upgrade from the external-provider era, which never wrote a
 * marker) or the `EMBEDDING_INPUT_VERSION` (e.g. content-only → title+content)
 * — invalidates every `memory_vec` row at once.
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
  inputVersion: string;
}

function readMarker(dataDir: string): EmbeddingState | null {
  try {
    const raw = readFileSync(join(dataDir, MARKER_FILE), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'modelId' in parsed) {
      // `inputVersion` is absent in pre-v2 markers; `undefined ?? ''` → '' so it
      // mismatches the current recipe and forces a one-time re-embed.
      const obj = parsed as { modelId: unknown; inputVersion?: string };
      return { modelId: String(obj.modelId), inputVersion: obj.inputVersion ?? '' };
    }
  } catch {
    // missing or unreadable marker — treated as "unknown identity"
  }
  return null;
}

/**
 * Align `memory_vec` with the compiled-in embedding identity (model +
 * input recipe). Returns the number of stale vectors wiped (0 when the
 * marker already matches on both axes).
 */
export function ensureVectorModel(
  repos: Pick<Repositories, 'vectors'>,
  dataDir: string,
): { wiped: number } {
  const marker = readMarker(dataDir);
  if (marker?.modelId === EMBEDDING_MODEL_ID && marker.inputVersion === EMBEDDING_INPUT_VERSION) {
    return { wiped: 0 };
  }

  const stale = repos.vectors.count();
  if (stale > 0) {
    repos.vectors.deleteAll();
  }
  writeFileSync(
    join(dataDir, MARKER_FILE),
    JSON.stringify(
      {
        modelId: EMBEDDING_MODEL_ID,
        inputVersion: EMBEDDING_INPUT_VERSION,
      } satisfies EmbeddingState,
      null,
      2,
    ) + '\n',
  );
  return { wiped: stale };
}
