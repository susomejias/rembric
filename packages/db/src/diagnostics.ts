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

export function quickCheck(handle: DbHandle): string {
  const row = handle.raw.prepare<[], Record<string, string>>('PRAGMA quick_check').get();
  if (!row) return 'unknown';
  return Object.values(row)[0] ?? 'unknown';
}

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

export function refreshStatistics(handle: DbHandle): void {
  handle.raw.exec('ANALYZE');
}

/** Liveness ping for the healthz endpoint. Throws on a dead connection. */
export function ping(handle: DbHandle): void {
  handle.raw.prepare('SELECT 1').get();
}

export interface DbDiagnostics {
  readDbSize(): DbSizeInfo;
  readJournalMode(): string;
  quickCheck(): string;
  readDbstatBytes(): Map<string, number> | null;
  countTableRows(table: string): number | null;
  vacuumInto(dest: string): void;
  ping(): void;
}

export function createDiagnostics(handle: DbHandle): DbDiagnostics {
  return {
    readDbSize: () => readDbSize(handle),
    readJournalMode: () => readJournalMode(handle),
    quickCheck: () => quickCheck(handle),
    readDbstatBytes: () => readDbstatBytes(handle),
    countTableRows: (table) => countTableRows(handle, table),
    vacuumInto: (dest) => vacuumInto(handle, dest),
    ping: () => ping(handle),
  };
}
