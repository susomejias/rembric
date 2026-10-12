import { sql } from 'drizzle-orm';

import type { Db } from '../client.js';
import { ENTITY_KINDS, type EntityKind } from '../schema/entities.js';
import { RELATION_VALUES, type RelationKind } from '../schema/memory-relations.js';
import { MEMORY_TYPES, type MemoryType } from '../schema/memory.js';

export const WRAPPED_AGENTS = [
  'Claude Code',
  'Codex CLI',
  'Hermes',
  'Other',
  'Pi',
  'opencode',
] as const;
export type WrappedAgent = (typeof WRAPPED_AGENTS)[number];
export type WrappedStats = {
  year: number;
  yearToDate: boolean;
  memories: number;
  sessions: number;
  judgments: number;
  judgmentTypes: Record<RelationKind, number>;
  projects: number;
  projectMemories: { top: number[]; other: number };
  entities: {
    total: number;
    recurring: number;
    scannedMemories: number;
    eligibleMemories: number;
    kinds: { kind: EntityKind; n: number }[];
    memoryKinds: { kind: EntityKind; n: number }[];
  };
  activeDays: number;
  longestStreak: number;
  months: number[];
  types: Record<MemoryType, number>;
  agents: { agent: WrappedAgent; n: number }[];
  days: { day: number; n: number }[];
};

const DAY_MS = 86_400_000;

export class WrappedRepository {
  constructor(private readonly db: Db) {}

  adminYears(nowMs = Date.now()): number[] {
    return this.db
      .all<{ year: number }>(
        sql`
      SELECT DISTINCT CAST(strftime('%Y', at / 1000, 'unixepoch') AS INTEGER) AS year
      FROM (
        SELECT created_at AS at FROM memory
        UNION ALL SELECT started_at AS at FROM sessions WHERE deleted_at IS NULL
        UNION ALL SELECT judged_at AS at FROM memory_relations WHERE status = 'judged'
      )
      WHERE at >= ${Date.UTC(1970, 0, 1)} AND at <= ${nowMs}
      ORDER BY year DESC
    `,
      )
      .map((row) => row.year);
  }

  adminYear(year: number, nowMs = Date.now()): WrappedStats {
    const currentYear = new Date(nowMs).getUTCFullYear();
    if (!Number.isInteger(year) || year < 1970 || year > currentYear) {
      throw new RangeError('Invalid Wrapped year');
    }
    const start = Date.UTC(year, 0, 1);
    const end = Math.min(Date.UTC(year + 1, 0, 1), nowMs + 1);
    const saves = this.db.all<{ day: number; type: MemoryType; n: number }>(sql`
      SELECT CAST(created_at / ${DAY_MS} AS INTEGER) AS day, type, count(*) AS n
      FROM memory WHERE created_at >= ${start} AND created_at < ${end}
      GROUP BY day, type ORDER BY day, type
    `);
    const starts = this.db.all<{ day: number; agent: WrappedAgent; n: number }>(sql`
      SELECT CAST(started_at / ${DAY_MS} AS INTEGER) AS day,
        CASE
          WHEN agent IN ('claude-code', 'claude') THEN 'Claude Code'
          WHEN agent IN ('codex-cli', 'codex') THEN 'Codex CLI'
          WHEN agent IN ('hermes-agent', 'hermes') THEN 'Hermes'
          WHEN agent = 'pi' THEN 'Pi'
          WHEN agent = 'opencode' THEN 'opencode'
          ELSE 'Other'
        END AS agent, count(*) AS n
      FROM sessions
      WHERE started_at >= ${start} AND started_at < ${end} AND deleted_at IS NULL
      GROUP BY day, 2 ORDER BY day, 2
    `);
    const decisions = this.db.all<{ day: number; relation: RelationKind | null; n: number }>(sql`
      SELECT CAST(judged_at / ${DAY_MS} AS INTEGER) AS day, relation, count(*) AS n
      FROM memory_relations
      WHERE status = 'judged' AND judged_at >= ${start} AND judged_at < ${end}
      GROUP BY day, relation ORDER BY day, relation
    `);
    const projects =
      this.db.get<{ n: number }>(sql`
      SELECT count(DISTINCT project_id) AS n FROM (
        SELECT project_id FROM memory WHERE created_at >= ${start} AND created_at < ${end}
        UNION ALL
        SELECT project_id FROM sessions
        WHERE started_at >= ${start} AND started_at < ${end} AND deleted_at IS NULL
      )
    `)?.n ?? 0;

    const projectCounts = this.db.all<{ n: number }>(sql`
      SELECT count(*) AS n FROM memory
      WHERE created_at >= ${start} AND created_at < ${end} AND project_id IS NOT NULL
      GROUP BY project_id ORDER BY n DESC, project_id
    `);
    const projectMemories = {
      top: projectCounts.slice(0, 4).map((row) => row.n),
      other: projectCounts.slice(4).reduce((sum, row) => sum + row.n, 0),
    };
    const entityKinds = this.db.all<{ kind: EntityKind; n: number; recurring: number }>(sql`
      SELECT kind, count(*) AS n, sum(links >= 2) AS recurring FROM (
        SELECT e.kind, e.value, count(DISTINCT m.id) AS links
        FROM memory m
        JOIN memory_entity_links l ON l.memory_id = m.id
        JOIN memory_entities e ON e.id = l.entity_id
        WHERE m.created_at >= ${start} AND m.created_at < ${end}
          AND e.kind IN (${sql.join(
            ENTITY_KINDS.map((kind) => sql`${kind}`),
            sql`, `,
          )})
        GROUP BY e.kind, e.value
      ) GROUP BY kind ORDER BY n DESC, kind
    `);
    const memoryKinds = this.db
      .all<{ kind: EntityKind; n: number }>(
        sql`
      SELECT e.kind, count(DISTINCT m.id) AS n
      FROM memory m
      JOIN memory_entity_links l ON l.memory_id = m.id
      JOIN memory_entities e ON e.id = l.entity_id
      WHERE m.created_at >= ${start} AND m.created_at < ${end}
      GROUP BY e.kind ORDER BY n DESC, e.kind
    `,
      )
      .filter(({ kind }) => ENTITY_KINDS.includes(kind));
    const coverage = this.db.get<{ scannedMemories: number; eligibleMemories: number }>(sql`
      SELECT count(s.memory_id) AS scannedMemories, count(*) AS eligibleMemories
      FROM memory m LEFT JOIN memory_entity_scan s ON s.memory_id = m.id
      WHERE m.created_at >= ${start} AND m.created_at < ${end} AND m.project_id IS NOT NULL
    `);
    const entities = {
      total: entityKinds.reduce((sum, row) => sum + row.n, 0),
      recurring: entityKinds.reduce((sum, row) => sum + row.recurring, 0),
      ...coverage,
      kinds: entityKinds.map(({ kind, n }) => ({ kind, n })),
      memoryKinds,
    };

    const types: Record<MemoryType, number> = {
      user: 0,
      feedback: 0,
      project: 0,
      reference: 0,
      procedural: 0,
    };
    const months = Array<number>(12).fill(0);
    const dayCounts = new Map<number, number>();
    const agentCounts = new Map<WrappedAgent, number>();
    let memories = 0;
    let sessions = 0;
    for (const row of saves) {
      memories += row.n;
      if (MEMORY_TYPES.includes(row.type)) types[row.type] += row.n;
      months[new Date(row.day * DAY_MS).getUTCMonth()]! += row.n;
      dayCounts.set(row.day, (dayCounts.get(row.day) ?? 0) + row.n);
    }
    for (const row of starts) {
      sessions += row.n;
      agentCounts.set(row.agent, (agentCounts.get(row.agent) ?? 0) + row.n);
      dayCounts.set(row.day, (dayCounts.get(row.day) ?? 0) + row.n);
    }
    const judgmentTypes: Record<RelationKind, number> = {
      supersedes: 0,
      conflicts_with: 0,
      related: 0,
      compatible: 0,
      scoped: 0,
      not_conflict: 0,
    };
    let judgments = 0;
    for (const row of decisions) {
      judgments += row.n;
      if (row.relation !== null && RELATION_VALUES.includes(row.relation))
        judgmentTypes[row.relation] += row.n;
      dayCounts.set(row.day, (dayCounts.get(row.day) ?? 0) + row.n);
    }
    const days = [...dayCounts].sort(([a], [b]) => a - b).map(([day, n]) => ({ day, n }));
    let streak = 0;
    let longestStreak = 0;
    let previous = -1;
    for (const { day } of days) {
      streak = day === previous + 1 ? streak + 1 : 1;
      longestStreak = Math.max(longestStreak, streak);
      previous = day;
    }
    const agents = [...agentCounts]
      .map(([agent, n]) => ({ agent, n }))
      .sort((a, b) => b.n - a.n || a.agent.localeCompare(b.agent, 'en'));
    return {
      year,
      yearToDate: year === currentYear,
      memories,
      sessions,
      judgments,
      judgmentTypes,
      projects,
      projectMemories,
      entities,
      activeDays: days.length,
      longestStreak,
      months,
      types,
      agents,
      days,
    };
  }
}
