import type { SessionsService } from '@rembric/core';
import { type DashboardSession } from '@rembric/db';

/**
 * Per-request session context attached to the Hono `c.set('session', …)`
 * inside the dashboard router after authentication succeeds.
 */
export interface ResolvedSession {
  session: DashboardSession;
  sessions: SessionsService;
  tokenId: string;
}
