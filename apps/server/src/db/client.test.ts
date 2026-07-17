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
});
