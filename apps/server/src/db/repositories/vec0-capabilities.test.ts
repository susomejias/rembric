import Database from 'better-sqlite3';
import * as sqliteVec from 'sqlite-vec';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Capability gate for the sqlite-vec features the hybrid-search migration
 * (0014) and the dense retriever depend on. Kept (not throwaway) so a future
 * sqlite-vec bump that drops a capability fails here loudly rather than
 * silently corrupting search. Pure extension behavior — no app code.
 */
describe('sqlite-vec vec0 capabilities (hybrid-search gate)', () => {
  let db: Database.Database;

  const vec = (a: number, b: number): Buffer => {
    const v = new Float32Array(8);
    v[0] = a;
    v[1] = b;
    return Buffer.from(v.buffer);
  };

  beforeEach(() => {
    db = new Database(':memory:');
    sqliteVec.load(db);
    db.exec(
      `CREATE VIRTUAL TABLE memory_vec USING vec0(
         memory_id TEXT PRIMARY KEY,
         partition_key TEXT partition key,
         status TEXT,
         type TEXT,
         embedding FLOAT[8]
       );`,
    );
    const ins = db.prepare(
      'INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding) VALUES (?, ?, ?, ?, ?)',
    );
    ins.run('a', 'projA', 'active', 'user', vec(1, 0));
    ins.run('b', 'projA', 'active', 'project', vec(0.9, 0.1));
    ins.run('c', 'projA', 'superseded', 'user', vec(0.8, 0.2));
    ins.run('d', 'projB', 'active', 'user', vec(1, 0));
    ins.run('e', '__global__', 'active', 'user', vec(1, 0));
  });

  afterEach(() => db.close());

  it('kNN MATCH isolates by partition_key, status, AND type with zero leakage', () => {
    const rows = db
      .prepare<[Buffer, string, string], { memory_id: string }>(
        `SELECT memory_id FROM memory_vec
         WHERE embedding MATCH ? AND k = 10
           AND partition_key = ? AND status = 'active' AND type = ?`,
      )
      .all(vec(1, 0), 'projA', 'user');
    // Only 'a' qualifies: 'b' wrong type, 'c' wrong status, 'd'/'e' wrong partition.
    expect(rows.map((r) => r.memory_id)).toEqual(['a']);
  });

  it('a base-table AFTER UPDATE OF status trigger can update the vec0 status column', () => {
    db.exec('CREATE TABLE memory (id TEXT PRIMARY KEY, status TEXT)');
    db.prepare("INSERT INTO memory (id, status) VALUES ('a', 'active')").run();
    db.exec(
      `CREATE TRIGGER memory_vec_status_sync AFTER UPDATE OF status ON memory BEGIN
         UPDATE memory_vec SET status = new.status WHERE memory_id = new.id;
       END;`,
    );
    db.prepare("UPDATE memory SET status = 'superseded' WHERE id = 'a'").run();
    const row = db
      .prepare<[], { status: string }>("SELECT status FROM memory_vec WHERE memory_id = 'a'")
      .get();
    expect(row!.status).toBe('superseded');
  });

  it('rejects the operations the bespoke migration recipe avoids', () => {
    // Trigger ON the vtable is forbidden (FTS-style triggers live on the base table).
    expect(() =>
      db.exec('CREATE TRIGGER t AFTER INSERT ON memory_vec BEGIN SELECT 1; END;'),
    ).toThrow();
    // NULL on an aux TEXT metadata column is rejected (so it must be supplied at insert).
    expect(() =>
      db
        .prepare(
          'INSERT INTO memory_vec (memory_id, partition_key, status, type, embedding) VALUES (?, ?, ?, ?, ?)',
        )
        .run('z', 'projA', null, 'user', vec(1, 0)),
    ).toThrow();
    // partition_key UPDATE is unsupported (fine — it is immutable per memory).
    expect(() =>
      db.prepare("UPDATE memory_vec SET partition_key = 'x' WHERE memory_id = 'a'").run(),
    ).toThrow();
  });

  it('ALTER TABLE … RENAME corrupts the shadow tables (why the recipe drops + recreates)', () => {
    db.exec('ALTER TABLE memory_vec RENAME TO memory_vec_renamed');
    // The rename does not move the shadow tables, so the renamed vtable is unusable.
    expect(() => db.prepare('SELECT count(*) FROM memory_vec_renamed').get()).toThrow();
  });
});
