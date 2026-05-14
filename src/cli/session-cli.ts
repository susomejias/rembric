import { desc, eq } from 'drizzle-orm';

import { loadConfig } from '../config.js';
import { createDb } from '../db/index.js';
import { agentSessions } from '../db/schema/agent-sessions.js';
import { projects } from '../db/schema/projects.js';
import { tokens } from '../db/schema/tokens.js';

/**
 * `rembric session list` — read-only report of agent sessions.
 *
 * The CLI hits the local SQLite directly (read-only); operators with
 * a running server share the same data file. JSON output by default;
 * `--table` switches to a column-aligned text table for human reading.
 */

export interface SessionListArgs {
  limit?: number;
  status?: 'active' | 'ended' | 'abandoned';
  json?: boolean;
}

export function runSessionList(args: SessionListArgs = {}): void {
  const config = loadConfig();
  const handle = createDb({ dataDir: config.dataDir, readonly: true });
  try {
    const limit = Math.min(Math.max(args.limit ?? 50, 1), 500);
    const query = handle.db
      .select({
        id: agentSessions.id,
        agent: agentSessions.agent,
        status: agentSessions.status,
        startedAt: agentSessions.startedAt,
        endedAt: agentSessions.endedAt,
        tokenName: tokens.name,
        projectSlug: projects.slug,
      })
      .from(agentSessions)
      .leftJoin(tokens, eq(tokens.id, agentSessions.tokenId))
      .leftJoin(projects, eq(projects.id, agentSessions.projectId))
      .orderBy(desc(agentSessions.startedAt))
      .limit(limit);

    const rows = args.status
      ? query.where(eq(agentSessions.status, args.status)).all()
      : query.all();

    if (args.json === false) {
      process.stdout.write(renderTable(rows));
    } else {
      process.stdout.write(JSON.stringify({ sessions: rows }, null, 2) + '\n');
    }
  } finally {
    handle.close();
  }
}

interface RenderableRow {
  id: string;
  agent: string;
  status: string;
  startedAt: Date | null;
  endedAt: Date | null;
  tokenName: string | null;
  projectSlug: string | null;
}

function renderTable(rows: RenderableRow[]): string {
  if (rows.length === 0) return '(no sessions)\n';
  const header = ['id', 'agent', 'status', 'project', 'token', 'started', 'ended'];
  const lines = rows.map((r) => [
    r.id,
    r.agent,
    r.status,
    r.projectSlug ?? '(global)',
    r.tokenName ?? '(deleted)',
    r.startedAt ? r.startedAt.toISOString() : '',
    r.endedAt ? r.endedAt.toISOString() : '',
  ]);
  const widths = header.map((h, i) =>
    Math.max(h.length, ...lines.map((row) => (row[i] ?? '').length)),
  );
  const pad = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i]!, ' ')).join('  ');
  return [pad(header), pad(widths.map((w) => '-'.repeat(w))), ...lines.map(pad)].join('\n') + '\n';
}
