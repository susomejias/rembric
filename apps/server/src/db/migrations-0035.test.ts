import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createMigrationFixture, type MigrationFixture } from '../test/migration-fixture.js';

import type { DbHandle } from './index.js';

const MIGRATION = '0035_drop_session_summary_versions.sql';

type Row = Record<string, unknown>;

let fx: MigrationFixture;

const open = (): DbHandle => fx.open();

function seeded(handle: DbHandle): { sessionId: string; curatedSessionId: string } {
  handle.raw.exec(`
    INSERT INTO projects (id, slug, display_name, archived_at, created_at)
      VALUES ('01PROJECTALPHA', 'alpha', NULL, NULL, 1000);
    INSERT INTO tokens (id, name, hash, scope, project_id, created_at)
      VALUES ('01TOKADMIN', 'admin', 's1$aa$bb', '*', NULL, 1000);
    INSERT INTO sessions (id, token_id, project_id, agent, started_at, summary, summary_final)
      VALUES ('01SESSPLAIN', '01TOKADMIN', '01PROJECTALPHA', 'test', 1001, NULL, 0);
    INSERT INTO sessions (id, token_id, project_id, agent, started_at, summary, summary_final)
      VALUES ('01SESSCURATED', '01TOKADMIN', '01PROJECTALPHA', 'test', 1002, 'a pre-existing curated summary', 1);
    INSERT INTO memory (id, scope, project_id, type, title, content, tags, status, replaces, created_at, session_id)
      VALUES ('01MEMORY', 'project', '01PROJECTALPHA', 'user', 'a memory', 'about the session', '[]', 'active', '[]', 1003, '01SESSCURATED');
    INSERT INTO prompts (id, session_id, project_id, content, title, created_at)
      VALUES ('01PROMPT', '01SESSCURATED', '01PROJECTALPHA', 'a captured prompt', 'a captured prompt', 1004);
    INSERT INTO confirmations (id, memory_id, session_id, verdict, event_ts)
      VALUES ('01CONFIRMATION', '01MEMORY', '01SESSCURATED', 'affirm', 1005);
    INSERT INTO session_summary_versions (id, session_id, version, content, title, created_at)
      VALUES ('01V1', '01SESSCURATED', 1, 'a pre-existing curated summary', NULL, 1002);
  `);
  return { sessionId: '01SESSPLAIN', curatedSessionId: '01SESSCURATED' };
}

function tableRows(handle: DbHandle, table: string): Row[] {
  return handle.raw.prepare<[], Row>(`SELECT * FROM ${table} ORDER BY id`).all();
}

beforeEach(() => {
  fx = createMigrationFixture(MIGRATION);
  fx.stagePrior();
});

afterEach(() => fx.cleanup());

describe('migration 0035 — drop session_summary_versions', () => {
  it('drops the table against a populated file carrying version rows, leaving every other row byte-identical', () => {
    const pre = open();
    seeded(pre);
    const before = {
      sessions: tableRows(pre, 'sessions'),
      memory: tableRows(pre, 'memory'),
      prompts: tableRows(pre, 'prompts'),
      confirmations: tableRows(pre, 'confirmations'),
    };
    expect(
      pre.raw.prepare<[], { n: number }>('SELECT count(*) AS n FROM session_summary_versions').get()
        ?.n,
    ).toBe(1);
    pre.close();

    fx.stage();
    const handle = open();
    try {
      expect(() => handle.raw.prepare('SELECT 1 FROM session_summary_versions').get()).toThrow();

      expect(tableRows(handle, 'sessions')).toEqual(before.sessions);
      expect(tableRows(handle, 'memory')).toEqual(before.memory);
      expect(tableRows(handle, 'prompts')).toEqual(before.prompts);
      expect(tableRows(handle, 'confirmations')).toEqual(before.confirmations);

      expect(handle.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('the migration file contains exactly one DROP TABLE, no CREATE/INSERT/ALTER/DROP INDEX, and no pragma', () => {
    const source = fx.source();
    expect(source.match(/DROP\s+TABLE/gi) ?? []).toHaveLength(1);
    expect(source).not.toMatch(/CREATE\s+TABLE/i);
    expect(source).not.toMatch(/INSERT\s+INTO/i);
    expect(source).not.toMatch(/ALTER\s+TABLE/i);
    expect(source).not.toMatch(/DROP\s+INDEX/i);
    expect(source).not.toMatch(/PRAGMA/i);
  });

  it('re-applies nothing on a second boot', () => {
    const pre = open();
    seeded(pre);
    pre.close();

    fx.stage();
    open().close();

    const handle = open();
    try {
      expect(
        handle.raw
          .prepare<
            [string],
            { n: number }
          >('SELECT count(*) AS n FROM _migrations WHERE filename = ?')
          .get(MIGRATION)?.n,
      ).toBe(1);
      expect(() => handle.raw.prepare('SELECT 1 FROM session_summary_versions').get()).toThrow();
    } finally {
      handle.close();
    }
  });
});
