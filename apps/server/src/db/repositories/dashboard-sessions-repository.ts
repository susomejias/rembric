import { and, eq, gt } from 'drizzle-orm';

import type { Db } from '../client.js';
import {
  dashboardSessions,
  type DashboardSession,
  type NewDashboardSession,
} from '../schema/sessions.js';
import { tokens } from '../schema/tokens.js';

export interface ResolvedDashboardSession {
  session: DashboardSession;
  tokenScope: string;
}

export class DashboardSessionsRepository {
  constructor(private readonly db: Db) {}

  insert(values: NewDashboardSession): DashboardSession | undefined {
    return this.db.insert(dashboardSessions).values(values).returning().get();
  }

  /** Resolve a non-expired session by id, joined to its token's scope. */
  resolveActive(sessionId: string, now: Date): ResolvedDashboardSession | undefined {
    const row = this.db
      .select({ session: dashboardSessions, tokenScope: tokens.scope })
      .from(dashboardSessions)
      .innerJoin(tokens, eq(tokens.id, dashboardSessions.tokenId))
      .where(and(gt(dashboardSessions.expiresAt, now), eq(dashboardSessions.id, sessionId)))
      .get();
    return row ?? undefined;
  }

  touchLastSeen(sessionId: string, lastSeenAt: Date): void {
    this.db
      .update(dashboardSessions)
      .set({ lastSeenAt })
      .where(eq(dashboardSessions.id, sessionId))
      .run();
  }

  deleteById(sessionId: string): void {
    this.db.delete(dashboardSessions).where(eq(dashboardSessions.id, sessionId)).run();
  }
}
