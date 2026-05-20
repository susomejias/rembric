import type { DashboardSession } from '../db/schema/sessions.js';
import type { SessionsService } from '../services/sessions.js';

/**
 * Per-request session context attached to the Hono `c.set('session', …)`
 * inside the dashboard router after authentication succeeds.
 */
export interface ResolvedSession {
  session: DashboardSession;
  sessions: SessionsService;
  tokenId: string;
}
