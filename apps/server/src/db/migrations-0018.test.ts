import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * Faithful test of migration 0018 (topic_key convergence). Runs the actual
 * migration SQL against a minimal `memory` table so both the heal pre-pass and
 * the UNIQUE partial index — including the global-slot (project_id NULL) case
 * the COALESCE key exists to cover — are exercised.
 */

const MIGRATION_SQL = readFileSync(
  fileURLToPath(new URL('./migrations/0018_unique_topic_key_active_index.sql', import.meta.url)),
  'utf8',
);

let db: Database.Database;

function applyMigration(): void {
  for (const stmt of MIGRATION_SQL.split('--> statement-breakpoint')) {
    const trimmed = stmt.trim();
    if (trimmed.length > 0) db.exec(trimmed);
  }
}

function seed(
  id: string,
  scope: string,
  projectId: string | null,
  topicKey: string,
  createdAt: number,
): void {
  db.prepare(
    `INSERT INTO memory (id, scope, project_id, topic_key, status, created_at) VALUES (?, ?, ?, ?, 'active', ?)`,
  ).run(id, scope, projectId, topicKey, createdAt);
}

function status(id: string): string {
  const row = db.prepare(`SELECT status FROM memory WHERE id = ?`).get(id) as { status: string };
  return row.status;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE memory (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      project_id TEXT,
      topic_key TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
  `);
});

afterEach(() => db.close());

describe('migration 0018 — heal pre-pass', () => {
  it('keeps the most-recently-created active row per slot and supersedes the rest', () => {
    seed('r1', 'project', 'p1', 'k', 1000);
    seed('r2', 'project', 'p1', 'k', 2000);
    seed('g1', 'global', null, 'g', 1000);
    seed('g2', 'global', null, 'g', 2000);
    seed('lone', 'project', 'p1', 'other', 1500);

    applyMigration();

    expect(status('r2')).toBe('active');
    expect(status('r1')).toBe('superseded');
    expect(status('g2')).toBe('active');
    expect(status('g1')).toBe('superseded');
    expect(status('lone')).toBe('active');
  });

  it('is a no-op on a database with no duplicate-active slots', () => {
    seed('a', 'project', 'p1', 'k', 1000);
    seed('b', 'project', 'p1', 'k2', 1000);
    applyMigration();
    expect(status('a')).toBe('active');
    expect(status('b')).toBe('active');
  });
});

describe('migration 0018 — UNIQUE index enforcement', () => {
  beforeEach(() => applyMigration());

  it('rejects a second active row in a project slot', () => {
    seed('x', 'project', 'p1', 'k', 1000);
    expect(() => seed('y', 'project', 'p1', 'k', 2000)).toThrow(/UNIQUE/i);
  });

  it('rejects a second active row in a GLOBAL slot (project_id NULL)', () => {
    seed('gx', 'global', null, 'k', 1000);
    // Without COALESCE(project_id,'') SQLite would treat the NULLs as distinct
    // and admit this row; the expression key makes the constraint bite.
    expect(() => seed('gy', 'global', null, 'k', 2000)).toThrow(/UNIQUE/i);
  });

  it('allows the same topic_key in different scopes/projects', () => {
    seed('a', 'project', 'p1', 'k', 1000);
    expect(() => seed('b', 'project', 'p2', 'k', 1000)).not.toThrow();
    expect(() => seed('c', 'global', null, 'k', 1000)).not.toThrow();
  });

  it('allows a superseded row alongside an active one in the same slot', () => {
    seed('a', 'project', 'p1', 'k', 1000);
    expect(() =>
      db
        .prepare(
          `INSERT INTO memory (id, scope, project_id, topic_key, status, created_at) VALUES ('b','project','p1','k','superseded',2000)`,
        )
        .run(),
    ).not.toThrow();
  });
});
