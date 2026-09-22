import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createDb, type DbHandle } from '@rembric/db';

describe('createDb connection tuning', () => {
  let dataDir: string;
  const handles: DbHandle[] = [];

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'rembric-client-'));
  });

  afterEach(() => {
    for (const h of handles.splice(0)) {
      try {
        h.close();
      } catch {
        // ignore double-close
      }
    }
    rmSync(dataDir, { recursive: true, force: true });
  });

  function open(readonly = false): DbHandle {
    const h = createDb(readonly ? { dataDir, readonly: true } : { dataDir });
    handles.push(h);
    return h;
  }

  /**
   * Runs `fn` with stderr captured and returns only the `[db]` lines, so the
   * DS1 line is asserted where the container reads it — the default channel,
   * not an injected sink. The migration narration shares that channel and is
   * filtered out.
   */
  function captureDbLines<T>(fn: () => T): { lines: string[]; result: T } {
    const lines: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
      const line = args.map(String).join(' ');
      if (line.startsWith('[db] ')) lines.push(line);
    });
    try {
      return { lines, result: fn() };
    } finally {
      spy.mockRestore();
    }
  }

  it('announces the resolved path and reports a fresh database as not pre-existing', () => {
    const { lines } = captureDbLines(() => open());
    expect(lines).toEqual([`[db] data file ${join(dataDir, 'data.db')} (pre-existing: false)`]);
  });

  it('reports a database that was already on disk as pre-existing', () => {
    open().close();
    const { lines } = captureDbLines(() => open());
    expect(lines).toEqual([`[db] data file ${join(dataDir, 'data.db')} (pre-existing: true)`]);
  });

  it('logs the resolved path even when the data dir is given relative', () => {
    const relativeDir = relative(process.cwd(), dataDir);
    const { lines, result } = captureDbLines(() => createDb({ dataDir: relativeDir }));
    handles.push(result);
    expect(lines).toEqual([`[db] data file ${join(dataDir, 'data.db')} (pre-existing: false)`]);
    expect(existsSync(join(dataDir, 'data.db'))).toBe(true);
  });

  it('applies the performance + write pragmas on the writable connection', () => {
    const { raw } = open();
    const num = (p: string) => raw.pragma(p, { simple: true });
    expect(num('journal_mode')).toBe('wal');
    expect(num('busy_timeout')).toBe(5000);
    expect(num('cache_size')).toBe(-65536);
    expect(num('mmap_size')).toBe(268435456);
    expect(num('temp_store')).toBe(2); // 2 = MEMORY
    expect(num('foreign_keys')).toBe(1);
  });

  it('gives the read-only connection a busy timeout without touching write pragmas', () => {
    open(); // create + migrate the file first
    const { raw } = open(true);
    expect(raw.pragma('busy_timeout', { simple: true })).toBe(5000);
    expect(raw.pragma('cache_size', { simple: true })).toBe(-65536);
    expect(raw.pragma('temp_store', { simple: true })).toBe(2);
  });

  it('refreshes statistics that grew stale since the last clean shutdown', () => {
    const seed = (raw: DbHandle['raw'], from: number, to: number) => {
      const insert = raw.prepare(
        `INSERT INTO memory (id, scope, project_id, type, title, content, tags, status, replaces, created_at, last_seen_at)
         VALUES (?, 'global', NULL, 'project', 't', 'c', '[]', 'active', '[]', ?, ?)`,
      );
      raw.transaction(() => {
        for (let i = from; i < to; i++) insert.run(`m-${i}`, i, i);
      })();
    };
    const memoryStat = (raw: DbHandle['raw']) =>
      raw.prepare<[], { stat: string }>(`SELECT stat FROM sqlite_stat1 WHERE tbl = 'memory'`).get()
        ?.stat;

    const first = open();
    seed(first.raw, 0, 200);
    first.close(); // clean shutdown: writes statistics for 200 rows
    expect(memoryStat(open().raw)).toMatch(/^200 /);

    // The corpus grows 10x, then the process dies without a clean shutdown, so
    // nothing re-analyzes. `PRAGMA optimize` at open would leave the 200 behind.
    const grown = createDb({ dataDir });
    seed(grown.raw, 200, 2_000);
    grown.raw.close();

    expect(memoryStat(open().raw)).toMatch(/^2000 /);
  });
});
