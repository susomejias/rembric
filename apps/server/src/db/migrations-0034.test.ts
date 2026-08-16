import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentSessionsService } from '../services/agent-sessions.js';
import { createMigrationFixture, type MigrationFixture } from '../test/migration-fixture.js';

import { createRepositories } from './repositories/index.js';

import type { DbHandle } from './index.js';

/**
 * 0034 is purely additive — three ALTER TABLE ADD COLUMN statements, no
 * rebuild — so the interesting property is what it does NOT do: no
 * pre-existing row anywhere moves, and the three new columns start NULL
 * on a populated file (`sessions`, "Session rows MUST carry the three
 * nudge-gate timestamps...", "A populated table migrates without
 * rewriting a row").
 */

const MIGRATION = '0034_session_nudge_gate.sql';

type Row = Record<string, unknown>;

let fx: MigrationFixture;

const open = (): DbHandle => fx.open();

function seeded(handle: DbHandle): {
  plainId: string;
  curatedId: string;
  terminalId: string;
  softDeletedId: string;
} {
  handle.raw.exec(`
    INSERT INTO projects (id, slug, display_name, archived_at, created_at)
      VALUES ('01PROJECTALPHA', 'alpha', NULL, NULL, 1000);
    INSERT INTO tokens (id, name, hash, scope, project_id, created_at)
      VALUES ('01TOKADMIN', 'admin', 's1$aa$bb', '*', NULL, 1000);
    INSERT INTO sessions (id, token_id, project_id, agent, started_at, summary, summary_final, status)
      VALUES ('01SESSPLAIN', '01TOKADMIN', '01PROJECTALPHA', 'test', 1001, NULL, 0, 'active');
    INSERT INTO sessions (id, token_id, project_id, agent, started_at, summary, summary_final, status)
      VALUES ('01SESSCURATED', '01TOKADMIN', '01PROJECTALPHA', 'test', 1002, 'a pre-existing curated summary', 1, 'active');
    INSERT INTO sessions (id, token_id, project_id, agent, started_at, ended_at, summary, summary_final, status)
      VALUES ('01SESSTERMINAL', '01TOKADMIN', '01PROJECTALPHA', 'test', 1003, 2000, 'done', 1, 'ended');
    INSERT INTO sessions (id, token_id, project_id, agent, started_at, status, deleted_at)
      VALUES ('01SESSDELETED', '01TOKADMIN', '01PROJECTALPHA', 'test', 1004, 'abandoned', 3000);
  `);
  return {
    plainId: '01SESSPLAIN',
    curatedId: '01SESSCURATED',
    terminalId: '01SESSTERMINAL',
    softDeletedId: '01SESSDELETED',
  };
}

function tableRows(handle: DbHandle, table: string): Row[] {
  return handle.raw.prepare<[], Row>(`SELECT * FROM ${table} ORDER BY id`).all();
}

beforeEach(() => {
  fx = createMigrationFixture(MIGRATION);
  fx.stagePrior();
});

afterEach(() => fx.cleanup());

describe('migration 0034 — session nudge gate columns', () => {
  it('runs against a populated data file: every pre-existing row survives verbatim, new columns NULL', () => {
    const pre = open();
    seeded(pre);
    const before = tableRows(pre, 'sessions');
    expect(before).toHaveLength(4);
    pre.close();

    fx.stage();
    const handle = open();
    try {
      const after = handle.raw
        .prepare<
          [],
          Row & { last_work_at: unknown; last_summary_at: unknown; last_nudge_at: unknown }
        >(`SELECT * FROM sessions ORDER BY id`)
        .all();
      expect(after).toHaveLength(4);
      for (const row of after) {
        expect(row.last_work_at).toBeNull();
        expect(row.last_summary_at).toBeNull();
        expect(row.last_nudge_at).toBeNull();
      }
      // Every OTHER column is byte-identical to before the migration.
      const beforeSansNew = before.map((r) => {
        const { ...rest } = r;
        return rest;
      });
      const afterSansNew = after.map((r) => {
        const { last_work_at, last_summary_at, last_nudge_at, ...rest } = r;
        void last_work_at;
        void last_summary_at;
        void last_nudge_at;
        return rest;
      });
      expect(afterSansNew).toEqual(beforeSansNew);

      expect(handle.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('declares all three columns nullable, with no CHECK and no rebuild', () => {
    fx.stage();
    const handle = open();
    try {
      const columns = handle.raw
        .prepare<[], { name: string; notnull: number }>(`PRAGMA table_info(sessions)`)
        .all();
      for (const name of ['last_work_at', 'last_summary_at', 'last_nudge_at']) {
        const col = columns.find((c) => c.name === name);
        expect(col, `${name} missing`).toBeDefined();
        expect(col?.notnull).toBe(0);
      }
    } finally {
      handle.close();
    }
  });

  it('a pre-existing session with a curated summary keeps reading back unchanged', () => {
    const pre = open();
    const { curatedId } = seeded(pre);
    pre.close();

    fx.stage();
    const handle = open();
    try {
      const repos = createRepositories(handle.db);
      const svc = new AgentSessionsService(repos, handle.db);
      const row = svc.getById(curatedId);
      expect(row?.summary).toBe('a pre-existing curated summary');
      expect(row?.summaryFinal).toBe(true);
      expect(row?.lastWorkAt).toBeNull();
      expect(row?.lastSummaryAt).toBeNull();
      expect(row?.lastNudgeAt).toBeNull();
    } finally {
      handle.close();
    }
  });

  it('a pre-existing terminal and a soft-deleted row both survive with the new columns NULL', () => {
    const pre = open();
    const { terminalId, softDeletedId } = seeded(pre);
    pre.close();

    fx.stage();
    const handle = open();
    try {
      const repos = createRepositories(handle.db);
      const svc = new AgentSessionsService(repos, handle.db);
      const terminal = svc.getById(terminalId);
      expect(terminal?.status).toBe('ended');
      expect(terminal?.lastWorkAt).toBeNull();

      const deleted = svc.getById(softDeletedId);
      expect(deleted?.deletedAt).not.toBeNull();
      expect(deleted?.lastNudgeAt).toBeNull();
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
    } finally {
      handle.close();
    }
  });
});
