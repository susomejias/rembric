import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { expect, it } from 'vitest';

import { createDb } from './client.js';

it('migrates additive period indexes with covering memory keys and partial stable session ordering', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rembric-period-indexes-'));
  const h = createDb({ dataDir: dir, onMigrationProgress: () => {}, onStartupLog: () => {} });
  try {
    expect(h.raw.pragma("index_list('memory')")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'memory_created_at_idx' }),
        expect.objectContaining({ name: 'memory_scope_project_created_id_idx' }),
      ]),
    );
    expect(h.raw.pragma("index_xinfo('memory_scope_project_created_id_idx')")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seqno: 0, name: 'scope', desc: 0, key: 1 }),
        expect.objectContaining({ seqno: 1, name: 'project_id', desc: 0, key: 1 }),
        expect.objectContaining({ seqno: 2, name: 'created_at', desc: 1, key: 1 }),
        expect.objectContaining({ seqno: 3, name: 'id', desc: 1, key: 1 }),
      ]),
    );
    expect(h.raw.pragma("index_list('sessions')")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'sessions_project_started_idx' }),
        expect.objectContaining({ name: 'sessions_project_started_id_live_idx', partial: 1 }),
      ]),
    );
    expect(h.raw.pragma("index_xinfo('sessions_project_started_id_live_idx')")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ seqno: 0, name: 'project_id', desc: 0, key: 1 }),
        expect.objectContaining({ seqno: 1, name: 'started_at', desc: 1, key: 1 }),
        expect.objectContaining({ seqno: 2, name: 'id', desc: 1, key: 1 }),
      ]),
    );
  } finally {
    h.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
