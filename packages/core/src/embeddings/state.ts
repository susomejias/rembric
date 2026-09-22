import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Repositories } from '@rembric/db';

import { EMBEDDING_INPUT_VERSION, EMBEDDING_MODEL_ID } from './embedder.js';

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
      const obj = parsed as { modelId: unknown; inputVersion?: string; pending?: unknown };
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

export function vectorIdentityMatches(dataDir: string): boolean {
  const marker = readMarker(dataDir);
  return marker?.modelId === EMBEDDING_MODEL_ID && marker.inputVersion === EMBEDDING_INPUT_VERSION;
}

export function vectorIndexResetWarning(dataDir: string, countRows: () => number): string | null {
  if (vectorIdentityMatches(dataDir)) return null;
  const stale = countRows();
  if (stale === 0) return null;
  return `vector index owes a reset: ${stale} row(s) may predate the current embedding recipe, so dense search results are unreliable until the next restart succeeds`;
}

export function ensureVectorModel(
  repos: Pick<Repositories, 'vectors'>,
  dataDir: string,
): { wiped: number; markerWritten: boolean } {
  const marker = readMarker(dataDir);
  if (marker?.modelId === EMBEDDING_MODEL_ID && marker.inputVersion === EMBEDDING_INPUT_VERSION) {
    return { wiped: 0, markerWritten: true };
  }

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
