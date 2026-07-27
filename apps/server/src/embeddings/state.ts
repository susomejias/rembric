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
 * The reset is the only non-incremental step. A pending marker reads as a
 * mismatch, so a reset interrupted at any point is retried on a later boot
 * instead of leaving an empty index under a marker claiming the corpus was
 * rebuilt. From there the regular missing-vector drain in `EmbeddingWorker`
 * re-embeds the corpus in batches — resumable across restarts by
 * construction. `memory_vec` is derived data; wiping it does not touch the
 * append-only `memory` table.
 *
 * Entity-index counterpart: `services/entity-state.ts`.
 */

const MARKER_FILE = 'embedding-state.json';

interface EmbeddingState {
  modelId: string;
  inputVersion: string;
  pending?: boolean;
}

export function embeddingMarkerPath(dataDir: string): string {
  return join(dataDir, MARKER_FILE);
}

function readMarker(dataDir: string): EmbeddingState | null {
  try {
    const raw = readFileSync(embeddingMarkerPath(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && 'modelId' in parsed) {
      // `inputVersion` is absent in pre-v2 markers; `undefined ?? ''` → '' so it
      // mismatches the current recipe and forces a one-time re-embed.
      const obj = parsed as { modelId: unknown; inputVersion?: string; pending?: unknown };
      // Absent means settled, so a marker predating the two-phase reset still
      // matches and wipes nothing. Any non-boolean reads as pending: unlike
      // `inputVersion`, a bad type here would otherwise skip the retry.
      if (obj.pending !== undefined && (typeof obj.pending !== 'boolean' || obj.pending)) {
        return null;
      }
      return { modelId: String(obj.modelId), inputVersion: obj.inputVersion ?? '' };
    }
  } catch {
    // missing or unreadable marker — treated as "unknown identity"
  }
  return null;
}

function writeMarker(dataDir: string, pending: boolean): void {
  writeFileSync(
    embeddingMarkerPath(dataDir),
    JSON.stringify(
      {
        modelId: EMBEDDING_MODEL_ID,
        inputVersion: EMBEDDING_INPUT_VERSION,
        pending,
      } satisfies EmbeddingState,
      null,
      2,
    ) + '\n',
  );
}

/**
 * True when the on-disk marker is settled AND names the compiled-in identity —
 * i.e. existing `memory_vec` rows are comparable with freshly embedded queries.
 * False means a reset is owed, so a dense search would fuse vectors from one
 * recipe with a query from another.
 */
export function vectorIdentityMatches(dataDir: string): boolean {
  const marker = readMarker(dataDir);
  return marker?.modelId === EMBEDDING_MODEL_ID && marker.inputVersion === EMBEDDING_INPUT_VERSION;
}

/**
 * Operator-facing warning for the window this module cannot close: boot no
 * longer aborts on marker trouble, so rows from a previous recipe can still be
 * served. `countRows` is lazy because the vec0 count is only worth paying on
 * the unhealthy branch.
 */
export function vectorIndexResetWarning(dataDir: string, countRows: () => number): string | null {
  if (vectorIdentityMatches(dataDir)) return null;
  const stale = countRows();
  if (stale === 0) return null;
  return `vector index owes a reset: ${stale} row(s) may predate the current embedding recipe, so dense search results are unreliable until the next restart succeeds`;
}

/**
 * Align `memory_vec` with the compiled-in embedding identity (model + input
 * recipe). Reports how many stale vectors were wiped (0 when the marker
 * already matches on both axes) and whether the marker reached its settled
 * state. A settle failure is reported rather than thrown, so the wipe count
 * survives it.
 */
export function ensureVectorModel(
  repos: Pick<Repositories, 'vectors'>,
  dataDir: string,
): { wiped: number; markerWritten: boolean } {
  const marker = readMarker(dataDir);
  if (marker?.modelId === EMBEDDING_MODEL_ID && marker.inputVersion === EMBEDDING_INPUT_VERSION) {
    return { wiped: 0, markerWritten: true };
  }

  // Before the wipe, so an unwritable data dir performs zero wipes rather than
  // one per boot.
  writeMarker(dataDir, true);

  const stale = repos.vectors.count();
  if (stale > 0) {
    repos.vectors.deleteAll();
  }

  try {
    writeMarker(dataDir, false);
  } catch {
    return { wiped: stale, markerWritten: false };
  }
  return { wiped: stale, markerWritten: true };
}
