/**
 * Database-level introspection and administration. These operate on the
 * SQLite file itself (PRAGMA, dbstat, VACUUM), not on any aggregate —
 * which is why this is a function module, not a repository.
 */

import type { DbHandle } from './client.js';

export interface DbSizeInfo {
  pageCount: number;
  pageSize: number;
  freelistCount: number;
  totalBytes: number;
  freelistBytes: number;
}

export function readDbSize(handle: DbHandle): DbSizeInfo {
  const row = handle.raw
    .prepare<[], { page_count: number; page_size: number; freelist_count: number }>(
      `SELECT
        (SELECT page_count FROM pragma_page_count) AS page_count,
        (SELECT page_size  FROM pragma_page_size)  AS page_size,
        (SELECT freelist_count FROM pragma_freelist_count) AS freelist_count`,
    )
    .get();
  const pageCount = row?.page_count ?? 0;
  const pageSize = row?.page_size ?? 0;
  const freelistCount = row?.freelist_count ?? 0;
  return {
    pageCount,
    pageSize,
    freelistCount,
    totalBytes: pageCount * pageSize,
    freelistBytes: freelistCount * pageSize,
  };
}

export function readJournalMode(handle: DbHandle): string {
  const row = handle.raw.prepare<[], { journal_mode: string }>('PRAGMA journal_mode').get();
  return row?.journal_mode ?? 'unknown';
}

/**
 * `PRAGMA quick_check` — returns 'ok' on a healthy database, otherwise
 * the first reported problem line.
 */
export function quickCheck(handle: DbHandle): string {
  const row = handle.raw.prepare<[], Record<string, string>>('PRAGMA quick_check').get();
  if (!row) return 'unknown';
  return Object.values(row)[0] ?? 'unknown';
}

/**
 * Per-btree on-disk bytes via the optional `dbstat` virtual table.
 * Returns null when the module is not compiled into the SQLite build.
 */
export function readDbstatBytes(handle: DbHandle): Map<string, number> | null {
  try {
    const rows = handle.raw
      .prepare<
        [],
        { name: string; bytes: number }
      >('SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name')
      .all();
    return new Map(rows.map((r) => [r.name, r.bytes]));
  } catch {
    return null;
  }
}

/**
 * COUNT(*) for a dynamically-named table. Returns null when the table
 * does not exist (virtual-table shadow names vary across builds).
 */
export function countTableRows(handle: DbHandle, table: string): number | null {
  try {
    const row = handle.raw
      .prepare<[], { v: number }>(`SELECT COUNT(*) AS v FROM "${table.replaceAll('"', '""')}"`)
      .get();
    return row?.v ?? 0;
  } catch {
    return null;
  }
}

export function vacuumInto(handle: DbHandle, dest: string): void {
  handle.raw.prepare('VACUUM INTO ?').run(dest);
}

/**
 * Handle-bound facade for consumers that must not hold the raw database
 * handle themselves (the dashboard maintenance page).
 */
export interface DbDiagnostics {
  readDbSize(): DbSizeInfo;
  readJournalMode(): string;
  quickCheck(): string;
  readDbstatBytes(): Map<string, number> | null;
  countTableRows(table: string): number | null;
  vacuumInto(dest: string): void;
}

export function createDiagnostics(handle: DbHandle): DbDiagnostics {
  return {
    readDbSize: () => readDbSize(handle),
    readJournalMode: () => readJournalMode(handle),
    quickCheck: () => quickCheck(handle),
    readDbstatBytes: () => readDbstatBytes(handle),
    countTableRows: (table) => countTableRows(handle, table),
    vacuumInto: (dest) => vacuumInto(handle, dest),
  };
}
