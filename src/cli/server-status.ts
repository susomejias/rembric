import { sql } from 'drizzle-orm';

import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { consolidationRuns } from '../db/schema/consolidation.js';
import { memory } from '../db/schema/memory.js';
import { projects } from '../db/schema/projects.js';
import { tokens } from '../db/schema/tokens.js';

/** `rembric status` — print health-ish counters from the local DB. */
export function runStatus(): void {
  const config = loadConfig();
  const handle = createDb({ dataDir: config.dataDir, readonly: true });
  try {
    const total =
      handle.db
        .select({ v: sql<number>`count(*)` })
        .from(memory)
        .get()?.v ?? 0;
    const active =
      handle.db
        .select({ v: sql<number>`count(*)` })
        .from(memory)
        .where(sql`status = 'active'`)
        .get()?.v ?? 0;
    const archived =
      handle.db
        .select({ v: sql<number>`count(*)` })
        .from(memory)
        .where(sql`status = 'archived'`)
        .get()?.v ?? 0;
    const superseded =
      handle.db
        .select({ v: sql<number>`count(*)` })
        .from(memory)
        .where(sql`status = 'superseded'`)
        .get()?.v ?? 0;
    const projectsCount =
      handle.db
        .select({ v: sql<number>`count(*)` })
        .from(projects)
        .get()?.v ?? 0;
    const tokensCount =
      handle.db
        .select({ v: sql<number>`count(*)` })
        .from(tokens)
        .get()?.v ?? 0;
    const lastConsolidation = handle.db
      .select({ startedAt: consolidationRuns.startedAt, summary: consolidationRuns.summary })
      .from(consolidationRuns)
      .orderBy(sql`started_at DESC`)
      .limit(1)
      .get();

    const sessionsByStatus = handle.db
      .select({ status: agentSessions.status, n: sql<number>`count(*)` })
      .from(agentSessions)
      .groupBy(agentSessions.status)
      .all()
      .reduce<Record<string, number>>(
        (acc, row) => {
          acc[row.status] = Number(row.n);
          return acc;
        },
        { active: 0, ended: 0, abandoned: 0 },
      );

    process.stdout.write(
      JSON.stringify(
        {
          dataDir: config.dataDir,
          memories: { total, active, superseded, archived },
          projects: projectsCount,
          tokens: tokensCount,
          sessions: {
            active: sessionsByStatus.active ?? 0,
            ended: sessionsByStatus.ended ?? 0,
            abandoned: sessionsByStatus.abandoned ?? 0,
          },
          lastConsolidation: lastConsolidation
            ? { at: lastConsolidation.startedAt, summary: lastConsolidation.summary }
            : null,
        },
        null,
        2,
      ) + '\n',
    );
  } finally {
    handle.close();
  }
}
