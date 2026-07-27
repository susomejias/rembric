import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { TransactionRunner } from '../db/client.js';
import type { Repositories } from '../db/repositories/index.js';

import { EXTRACTOR_VERSION } from './entities.js';

/**
 * Extractor identity marker, the entity-index counterpart of
 * `embeddings/state.ts`. `memory_entity_scan` records THAT a memory was
 * scanned, not which recipe scanned it, so without this a recipe change would
 * leave existing memories indexed under the old rules forever. On mismatch the
 * derived index is truncated and the regular backfill drain re-scans in batches.
 *
 * The marker is two-phase, and a pending marker reads as a mismatch: a wipe
 * that rolled back restores the scan rows, so without that the drain would see
 * the corpus as scanned under a marker already claiming the new recipe, and
 * nothing would ever re-check.
 */

const MARKER_FILE = 'entity-state.json';

interface EntityState {
  extractorVersion: string;
  pending?: boolean;
}

export function entityMarkerPath(dataDir: string): string {
  return join(dataDir, MARKER_FILE);
}

function readMarker(dataDir: string): EntityState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(entityMarkerPath(dataDir), 'utf8'));
    if (parsed && typeof parsed === 'object' && 'extractorVersion' in parsed) {
      const obj = parsed as { extractorVersion: unknown; pending?: unknown };
      // Absent means settled, so a marker predating the two-phase reset still
      // matches and wipes nothing. Any non-boolean reads as pending: unlike
      // `extractorVersion`, a bad type here would otherwise skip the retry.
      if (obj.pending !== undefined && (typeof obj.pending !== 'boolean' || obj.pending)) {
        return null;
      }
      return { extractorVersion: String(obj.extractorVersion) };
    }
  } catch {
    // missing or unreadable marker — treated as "unknown identity"
  }
  return null;
}

function writeMarker(dataDir: string, pending: boolean): void {
  writeFileSync(
    entityMarkerPath(dataDir),
    JSON.stringify(
      { extractorVersion: EXTRACTOR_VERSION, pending } satisfies EntityState,
      null,
      2,
    ) + '\n',
  );
}

/**
 * Operator-facing warning for the state the two-phase marker makes recoverable
 * but not immediately correct: a rolled-back wipe restores the scan rows, so the
 * backlog reads zero over an index still on the old recipe. `countRows` is lazy —
 * only the unhealthy branch pays for it. Mirrors `vectorIndexResetWarning`.
 */
export function entityIndexResetWarning(dataDir: string, countRows: () => number): string | null {
  if (readMarker(dataDir)?.extractorVersion === EXTRACTOR_VERSION) return null;
  const stale = countRows();
  if (stale === 0) return null;
  return `entity index owes a reset: ${stale} link(s) may predate the current extraction recipe, so entity lookups can return retired addresses until the next restart succeeds`;
}

/**
 * Atomic wipe of the derived entity index — the only sanctioned path to
 * `truncateAll`. One transaction: a partial wipe would leave the index
 * inconsistent with a marker that is about to claim it was rebuilt.
 */
export function resetEntityIndex(
  repos: Pick<Repositories, 'entities'>,
  tx: TransactionRunner,
): void {
  tx.transaction(() => {
    repos.entities.truncateAll();
  });
}

export function ensureEntityExtractor(
  repos: Pick<Repositories, 'entities'>,
  dataDir: string,
  tx: TransactionRunner,
): { reset: boolean } {
  if (readMarker(dataDir)?.extractorVersion === EXTRACTOR_VERSION) return { reset: false };

  // Marker first: truncating before it persists re-wipes the index on every boot attempt.
  writeMarker(dataDir, true);
  // Unconditional: a corpus scanned under the old recipe may hold zero
  // entities yet still have scan rows, which alone would block the re-scan.
  resetEntityIndex(repos, tx);
  writeMarker(dataDir, false);
  return { reset: true };
}
