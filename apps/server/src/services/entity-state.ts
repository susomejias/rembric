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
 */

const MARKER_FILE = 'entity-state.json';

interface EntityState {
  extractorVersion: string;
}

function readMarker(dataDir: string): EntityState | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(dataDir, MARKER_FILE), 'utf8'));
    if (parsed && typeof parsed === 'object' && 'extractorVersion' in parsed) {
      return { extractorVersion: String(parsed.extractorVersion) };
    }
  } catch {
    // missing or unreadable marker — treated as "unknown identity"
  }
  return null;
}

/**
 * Atomic wipe of the derived entity index — the only sanctioned path to
 * `truncateAll`. The marker is written before the wipe, so a truncate that
 * failed part-way would leave the index inconsistent with a marker claiming
 * it was rebuilt, and nothing would ever notice.
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
  writeFileSync(
    join(dataDir, MARKER_FILE),
    JSON.stringify({ extractorVersion: EXTRACTOR_VERSION } satisfies EntityState, null, 2) + '\n',
  );
  // Unconditional: a corpus scanned under the old recipe may hold zero
  // entities yet still have scan rows, which alone would block the re-scan.
  resetEntityIndex(repos, tx);
  return { reset: true };
}
