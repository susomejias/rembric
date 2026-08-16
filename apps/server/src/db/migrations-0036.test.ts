import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentSessionsService } from '../services/agent-sessions.js';
import { createMigrationFixture, type MigrationFixture } from '../test/migration-fixture.js';

import { createRepositories } from './repositories/index.js';

import type { DbHandle } from './index.js';

/**
 * 0036 adds the single-writer anchor `last_turn_report_at` (`session-nudges`,
 * D1a). Additive, like 0034: one `ALTER TABLE ADD COLUMN`, no rebuild, and
 * every pre-existing row reads NULL — which is what makes an upgraded session
 * anchor its first work stamp on `started_at` rather than on a stale reading.
 */

const MIGRATION = '0036_session_turn_report_anchor.sql';

type Row = Record<string, unknown>;

let fx: MigrationFixture;

const open = (): DbHandle => fx.open();

function seed(handle: DbHandle): void {
  handle.raw.exec(`
    INSERT INTO projects (id, slug, display_name, archived_at, created_at)
      VALUES ('01PROJECTALPHA', 'alpha', NULL, NULL, 1000);
    INSERT INTO tokens (id, name, hash, scope, project_id, created_at)
      VALUES ('01TOKADMIN', 'admin', 's1$aa$bb', '*', NULL, 1000);
    INSERT INTO sessions (id, token_id, project_id, agent, started_at, summary, summary_final, status, last_work_at, last_summary_at)
      VALUES ('01SESSLIVE', '01TOKADMIN', '01PROJECTALPHA', 'test', 1001, '## Goal\nx', 1, 'active', 5000, 6000);
    INSERT INTO sessions (id, token_id, project_id, agent, started_at, ended_at, status)
      VALUES ('01SESSDONE', '01TOKADMIN', '01PROJECTALPHA', 'test', 1003, 2000, 'ended');
    INSERT INTO sessions (id, token_id, project_id, agent, started_at, status)
      VALUES ('01SESSFRESH', '01TOKADMIN', '01PROJECTALPHA', 'test', 1005, 'active');
  `);
}

beforeEach(() => {
  fx = createMigrationFixture(MIGRATION);
  fx.stagePrior();
});

afterEach(() => fx.cleanup());

describe('migration 0036 — the turn-report anchor column', () => {
  it('leaves every pre-existing row byte-identical and the new column NULL', () => {
    const pre = open();
    seed(pre);
    const before = pre.raw.prepare<[], Row>('SELECT * FROM sessions ORDER BY id').all();
    expect(before).toHaveLength(3);
    pre.close();

    fx.stage();
    const handle = open();
    try {
      const after = handle.raw
        .prepare<[], Row & { last_turn_report_at: unknown }>('SELECT * FROM sessions ORDER BY id')
        .all();
      expect(after).toHaveLength(3);
      for (const row of after) expect(row.last_turn_report_at).toBeNull();
      expect(
        after.map(({ last_turn_report_at: _ignored, ...rest }) => rest),
        'a rebuild, or any row rewrite, would show up here',
      ).toEqual(before);
      // The columns 0034 added keep their values — this is not a fresh table.
      const live = after.find((r) => r.id === '01SESSLIVE');
      expect(live?.last_work_at).toBe(5000);
      expect(live?.last_summary_at).toBe(6000);
      expect(handle.raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    } finally {
      handle.close();
    }
  });

  it('declares the column nullable, with no CHECK and no NOT NULL', () => {
    fx.stage();
    const handle = open();
    try {
      const col = handle.raw
        .prepare<[], { name: string; notnull: number; dflt_value: unknown }>(
          'PRAGMA table_info(sessions)',
        )
        .all()
        .find((c) => c.name === 'last_turn_report_at');
      expect(col, 'last_turn_report_at missing').toBeDefined();
      expect(col?.notnull).toBe(0);
      expect(col?.dflt_value).toBeNull();
      const body = fx
        .source()
        .split('\n')
        .filter((l) => !l.startsWith('--'))
        .join('\n');
      expect(body).not.toMatch(/CHECK|NOT NULL/i);
      expect(body).toMatch(/ADD COLUMN/);
    } finally {
      handle.close();
    }
  });

  it("an upgraded session's first work stamp anchors on started_at, not on a stale reading", () => {
    const pre = open();
    seed(pre);
    pre.close();

    fx.stageThroughHead();
    const handle = open();
    try {
      const repos = createRepositories(handle.db);
      const row = repos.agentSessions.getById('01SESSFRESH')!;
      expect(row.lastTurnReportAt).toBeNull();
      expect(row.lastWorkAt).toBeNull();

      const at = new Date(row.startedAt.getTime() + 40 * 60_000);
      const svc = new AgentSessionsService(repos, handle.db, () => at);
      svc.reportTurn('01SESSFRESH', { tokenId: '01TOKADMIN', usedTools: true });

      const after = repos.agentSessions.getById('01SESSFRESH')!;
      expect(after.lastWorkAt?.getTime()).toBe(row.startedAt.getTime());
      expect(after.lastTurnReportAt?.getTime()).toBe(at.getTime());
    } finally {
      handle.close();
    }
  });

  it('re-applies nothing on a second boot', () => {
    fx.stage();
    const first = open();
    first.close();
    const second = open();
    try {
      const applied = second.raw
        .prepare<
          [string],
          { filename: string }
        >('SELECT filename FROM _migrations WHERE filename = ?')
        .all(MIGRATION);
      expect(applied).toHaveLength(1);
    } finally {
      second.close();
    }
  });
});
