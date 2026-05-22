import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createTestDb, type TestDb } from '../test/index.js';

describe('migration 0011_summary_length_check', () => {
  let db: TestDb;

  beforeEach(() => {
    db = createTestDb();
  });

  afterEach(() => db.cleanup());

  it('rejects a direct INSERT with summary > 2000 chars via SQLITE_CONSTRAINT_CHECK', () => {
    const raw = db.handle.raw;
    raw
      .prepare(
        "INSERT INTO tokens (id, name, hash, scope, created_at) VALUES ('tok1', 'tok1-name', 'h', '*', 0)",
      )
      .run();
    expect(() =>
      raw
        .prepare(
          "INSERT INTO sessions (id, token_id, agent, started_at, summary, status) VALUES ('s1', 'tok1', 'claude', 0, ?, 'active')",
        )
        .run('a'.repeat(2001)),
    ).toThrow(/CHECK constraint failed/);
  });

  it('rejects a direct UPDATE that would push summary over 2000 chars', () => {
    const raw = db.handle.raw;
    raw
      .prepare(
        "INSERT INTO tokens (id, name, hash, scope, created_at) VALUES ('tok2', 'tok2-name', 'h', '*', 0)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO sessions (id, token_id, agent, started_at, summary, status) VALUES ('s2', 'tok2', 'claude', 0, 'short', 'active')",
      )
      .run();
    expect(() =>
      raw.prepare("UPDATE sessions SET summary = ? WHERE id = 's2'").run('a'.repeat(2001)),
    ).toThrow(/CHECK constraint failed/);
    const after = raw.prepare("SELECT summary FROM sessions WHERE id = 's2'").get() as {
      summary: string;
    };
    expect(after.summary).toBe('short');
  });

  it('accepts summary at exactly 2000 chars and NULL summary', () => {
    const raw = db.handle.raw;
    raw
      .prepare(
        "INSERT INTO tokens (id, name, hash, scope, created_at) VALUES ('tok3', 'tok3-name', 'h', '*', 0)",
      )
      .run();
    raw
      .prepare(
        "INSERT INTO sessions (id, token_id, agent, started_at, summary, status) VALUES ('s3a', 'tok3', 'claude', 0, ?, 'active')",
      )
      .run('a'.repeat(2000));
    raw
      .prepare(
        "INSERT INTO sessions (id, token_id, agent, started_at, summary, status) VALUES ('s3b', 'tok3', 'claude', 0, NULL, 'active')",
      )
      .run();
    const rows = raw
      .prepare("SELECT id, length(summary) AS len FROM sessions WHERE id IN ('s3a','s3b')")
      .all() as Array<{ id: string; len: number | null }>;
    expect(rows.find((r) => r.id === 's3a')?.len).toBe(2000);
    expect(rows.find((r) => r.id === 's3b')?.len).toBeNull();
  });

  it('preserves the three sessions indexes after the table-rebuild', () => {
    const raw = db.handle.raw;
    const indexes = raw
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sessions' ORDER BY name",
      )
      .all() as Array<{ name: string }>;
    const names = indexes.map((r) => r.name);
    expect(names).toContain('sessions_token_status_idx');
    expect(names).toContain('sessions_project_started_idx');
    expect(names).toContain('sessions_status_started_idx');
  });
});
