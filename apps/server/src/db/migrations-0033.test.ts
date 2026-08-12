import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentSessionsService } from '../services/agent-sessions.js';
import { createMigrationFixture, type MigrationFixture } from '../test/migration-fixture.js';

import { createRepositories } from './repositories/index.js';

import type { DbHandle } from './index.js';

/**
 * 0033 is purely additive — one CREATE TABLE, one named unique index, no
 * rebuild — so the interesting property is what it does NOT do: no
 * pre-existing row anywhere moves, and the new table starts empty on a
 * populated file (`openspec/specs/persistence/spec.md`,
 * "Migration `0033_session_summary_versions.sql` MUST create the
 * summary-version table additively, with no backfill").
 */

const MIGRATION = '0033_session_summary_versions.sql';

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

describe('migration 0033 — session_summary_versions', () => {
  it('runs against a populated data file: creates an empty table and leaves every pre-existing row byte-identical', () => {
    const pre = open();
    seeded(pre);
    const before = {
      sessions: tableRows(pre, 'sessions'),
      memory: tableRows(pre, 'memory'),
      prompts: tableRows(pre, 'prompts'),
      confirmations: tableRows(pre, 'confirmations'),
    };
    expect(before.sessions).toHaveLength(2);
    expect(before.memory).toHaveLength(1);
    expect(before.prompts).toHaveLength(1);
    expect(before.confirmations).toHaveLength(1);
    pre.close();

    fx.stage();
    const handle = open();
    try {
      expect(
        handle.raw
          .prepare<[], { n: number }>(`SELECT count(*) AS n FROM session_summary_versions`)
          .get()?.n,
      ).toBe(0);

      expect(tableRows(handle, 'sessions')).toEqual(before.sessions);
      expect(tableRows(handle, 'memory')).toEqual(before.memory);
      expect(tableRows(handle, 'prompts')).toEqual(before.prompts);
      expect(tableRows(handle, 'confirmations')).toEqual(before.confirmations);

      expect(handle.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('the migrated table declares a nullable `title` column (design D22)', () => {
    fx.stage();
    const handle = open();
    try {
      const columns = handle.raw
        .prepare<
          [],
          { name: string; notnull: number }
        >(`PRAGMA table_info(session_summary_versions)`)
        .all();
      const title = columns.find((c) => c.name === 'title');
      expect(title).toBeDefined();
      expect(title?.notnull).toBe(0);
    } finally {
      handle.close();
    }
  });

  it('a curated summary written before the upgrade keeps reading back unchanged, with no version rows', () => {
    const pre = open();
    const { curatedSessionId } = seeded(pre);
    pre.close();

    fx.stage();
    const handle = open();
    try {
      const repos = createRepositories(handle.db);
      const svc = new AgentSessionsService(repos, handle.db);
      const row = svc.getById(curatedSessionId);
      expect(row?.summary).toBe('a pre-existing curated summary');
      expect(row?.summaryFinal).toBe(true);
      expect(repos.agentSessions.adminListSummaryVersions(curatedSessionId)).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('the next curated write on a pre-existing session starts the history at version 1 with the NEW content, not the pre-migration text', () => {
    const pre = open();
    const { curatedSessionId } = seeded(pre);
    pre.close();

    fx.stage();
    const handle = open();
    try {
      const repos = createRepositories(handle.db);
      const svc = new AgentSessionsService(repos, handle.db);
      svc.writeSummary(curatedSessionId, {
        tokenId: '01TOKADMIN',
        summary: 'the first post-upgrade curation',
        title: 'Post-upgrade title',
        final: true,
      });

      const versions = repos.agentSessions.adminListSummaryVersions(curatedSessionId);
      expect(versions).toHaveLength(1);
      expect(versions[0]).toMatchObject({
        version: 1,
        content: 'the first post-upgrade curation',
        title: 'Post-upgrade title',
      });
      expect(svc.getById(curatedSessionId)?.summary).toBe('the first post-upgrade curation');
    } finally {
      handle.close();
    }
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
          >(`SELECT count(*) AS n FROM _migrations WHERE filename = ?`)
          .get(MIGRATION)?.n,
      ).toBe(1);
      expect(
        handle.raw
          .prepare<[], { n: number }>(`SELECT count(*) AS n FROM session_summary_versions`)
          .get()?.n,
      ).toBe(0);
    } finally {
      handle.close();
    }
  });
});
