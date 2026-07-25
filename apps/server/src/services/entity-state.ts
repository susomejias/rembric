import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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

export function ensureEntityExtractor(
  repos: Pick<Repositories, 'entities'>,
  dataDir: string,
): { reset: boolean } {
  if (readMarker(dataDir)?.extractorVersion === EXTRACTOR_VERSION) return { reset: false };

  // Unconditional: a corpus scanned under the old recipe may hold zero
  // entities yet still have scan rows, which alone would block the re-scan.
  repos.entities.truncateAll();
  writeFileSync(
    join(dataDir, MARKER_FILE),
    JSON.stringify({ extractorVersion: EXTRACTOR_VERSION } satisfies EntityState, null, 2) + '\n',
  );
  return { reset: true };
}
