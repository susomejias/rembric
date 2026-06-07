import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { ulid } from 'ulid';

import type { Repositories } from '../db/repositories/index.js';
import { type DashboardSession } from '../db/schema/sessions.js';

import { DomainError } from './errors.js';

/**
 * Backing store for `/dashboard` cookie sessions.
 *
 * The cookie carries `<sessionId>.<signature>` where the signature is an
 * HMAC over the session id using `sessionKey`. We look up the row in
 * `dashboard_sessions`, check expiration, and return the underlying token
 * for authz decisions.
 *
 * CSRF: each session row carries a `csrfSecret` used to mint per-form
 * CSRF tokens by HMAC over (sessionId, formName).
 */

const COOKIE_NAME = 'rembric_session';
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

export interface SessionContext {
  session: DashboardSession;
  tokenId: string;
  scope: string;
}

export class SessionsService {
  constructor(
    private readonly repos: Pick<Repositories, 'dashboardSessions'>,
    private readonly sessionKey: Buffer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  static cookieName(): string {
    return COOKIE_NAME;
  }

  /** Create a fresh session bound to the given token id. */
  create(tokenId: string): { session: DashboardSession; cookie: string } {
    const ts = this.now();
    const expiresAt = new Date(ts.getTime() + SESSION_TTL_MS);
    const id = ulid(ts.getTime());
    const csrfSecret = randomBytes(32).toString('base64url');

    const session = this.repos.dashboardSessions.insert({
      id,
      tokenId,
      csrfSecret,
      createdAt: ts,
      expiresAt,
      lastSeenAt: ts,
    });

    if (!session) throw new DomainError('conflict', 'sessions.create: insert returned no row');

    const cookie = this.signCookieValue(session.id);
    return { session, cookie };
  }

  /** Validate a cookie value and return the session + originating token. */
  resolve(cookieValue: string | undefined): SessionContext | null {
    if (!cookieValue) return null;
    const sessionId = this.verifyCookieValue(cookieValue);
    if (!sessionId) return null;

    const ts = this.now();
    const row = this.repos.dashboardSessions.resolveActive(sessionId, ts);
    if (!row) return null;

    // Touch lastSeenAt so the dashboard "current sessions" view is useful.
    this.repos.dashboardSessions.touchLastSeen(sessionId, ts);

    return {
      session: row.session,
      tokenId: row.session.tokenId,
      scope: row.tokenScope,
    };
  }

  /** Delete a session by id (logout). */
  destroy(sessionId: string): void {
    this.repos.dashboardSessions.deleteById(sessionId);
  }

  /**
   * Mint a CSRF token tying a session to a form name. Forms include this
   * value as a hidden input or HTMX header; mutating handlers verify.
   */
  csrfToken(session: DashboardSession, formName: string): string {
    return createHmac('sha256', session.csrfSecret).update(formName).digest('base64url');
  }

  verifyCsrf(session: DashboardSession, formName: string, candidate: string): boolean {
    const expected = this.csrfToken(session, formName);
    const a = Buffer.from(expected);
    const b = Buffer.from(candidate);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  private signCookieValue(sessionId: string): string {
    const sig = createHmac('sha256', this.sessionKey).update(sessionId).digest('base64url');
    return `${sessionId}.${sig}`;
  }

  private verifyCookieValue(cookieValue: string): string | null {
    const idx = cookieValue.lastIndexOf('.');
    if (idx <= 0) return null;
    const sessionId = cookieValue.slice(0, idx);
    const sig = cookieValue.slice(idx + 1);
    const expectedSig = createHmac('sha256', this.sessionKey).update(sessionId).digest('base64url');
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length) return null;
    if (!timingSafeEqual(a, b)) return null;
    return sessionId;
  }
}
