import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createDb, type DbHandle } from './index.js';

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
