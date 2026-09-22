import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Repositories, type TransactionRunner } from '@rembric/db';

import { EXTRACTOR_VERSION } from './entities.js';

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

export function entityIndexResetWarning(dataDir: string, countRows: () => number): string | null {
  if (readMarker(dataDir)?.extractorVersion === EXTRACTOR_VERSION) return null;
  const stale = countRows();
  if (stale === 0) return null;
  return `entity index owes a reset: ${stale} link(s) may predate the current extraction recipe, so entity lookups can return retired addresses until the next restart succeeds`;
}

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
  resetEntityIndex(repos, tx);
  writeMarker(dataDir, false);
  return { reset: true };
}
