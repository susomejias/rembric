import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL('./migrations/0021_memory_replaces_table.sql', import.meta.url)),
  'utf8',
);

let db: Database.Database;

function applyMigration(): void {
  for (const stmt of MIGRATION_SQL.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed.length > 0) db.exec(trimmed);
  }
}

function seed(id: string, replaces: string[], createdAt = 1000): void {
  db.prepare(
    `INSERT INTO memory (id, status, replaces, created_at) VALUES (?, 'active', ?, ?)`,
  ).run(id, JSON.stringify(replaces), createdAt);
}

function edges(): Array<{ predecessor_id: string; successor_id: string }> {
  return db
    .prepare(
      `SELECT predecessor_id, successor_id FROM memory_replaces ORDER BY predecessor_id, successor_id`,
    )
    .all() as Array<{ predecessor_id: string; successor_id: string }>;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memory (
      id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      replaces TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL
    );
  `);
});

afterEach(() => db.close());

describe('migration 0021 — backfill', () => {
  it('reconstructs the reverse-edge table from pre-existing replaces arrays', () => {
    seed('m1', []);
    seed('m2', ['m1']);
    seed('m3', ['m1', 'm2']);

    applyMigration();

    expect(edges()).toEqual([
      { predecessor_id: 'm1', successor_id: 'm2' },
      { predecessor_id: 'm1', successor_id: 'm3' },
      { predecessor_id: 'm2', successor_id: 'm3' },
    ]);
  });

  it('is a no-op edge set on a database with no replaces links', () => {
    seed('a', []);
    seed('b', []);
    applyMigration();
    expect(edges()).toEqual([]);
  });
});

describe('migration 0021 — triggers', () => {
  beforeEach(() => applyMigration());

  it('memory_replaces_ai populates the reverse edge on insert', () => {
    seed('m1', []);
    seed('m2', ['m1']);
    expect(edges()).toEqual([{ predecessor_id: 'm1', successor_id: 'm2' }]);
  });

  it('memory_replaces_au re-syncs the reverse edge when replaces is updated', () => {
    seed('m1', []);
    seed('m2', []);
    seed('m3', []);
    db.prepare(`UPDATE memory SET replaces = ? WHERE id = 'm2'`).run(JSON.stringify(['m1']));
    expect(edges()).toEqual([{ predecessor_id: 'm1', successor_id: 'm2' }]);

    db.prepare(`UPDATE memory SET replaces = ? WHERE id = 'm2'`).run(JSON.stringify(['m1', 'm3']));
    expect(edges()).toEqual([
      { predecessor_id: 'm1', successor_id: 'm2' },
      { predecessor_id: 'm3', successor_id: 'm2' },
    ]);
  });

  it('memory_replaces_ad removes edges in both directions on delete', () => {
    seed('m1', []);
    seed('m2', ['m1']);
    seed('m3', ['m2']);
    expect(edges()).toHaveLength(2);

    db.prepare(`DELETE FROM memory WHERE id = 'm2'`).run();
    // m2 was a successor of m1 AND a predecessor of m3 — both edges drop.
    expect(edges()).toEqual([]);
  });

  it('deleting an isolated row leaves unrelated edges untouched', () => {
    seed('m1', []);
    seed('m2', ['m1']);
    seed('isolated', []);
    db.prepare(`DELETE FROM memory WHERE id = 'isolated'`).run();
    expect(edges()).toEqual([{ predecessor_id: 'm1', successor_id: 'm2' }]);
  });
});
