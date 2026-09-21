import type { SessionContext, SessionsService } from '@rembric/core';
import { redirect } from 'next/navigation';

import { getServices, type Services } from '../services';
import { resolveDashboardSession, type SessionCookieSource } from '../session';

/**
 * The three preconditions every dashboard mutation checks before it touches a
 * service — the same three the Hono handlers ran in
 * `apps/server/src/dashboard/{projects,sessions,tokens}.ts`.
 *
 * The order is the contract, not an implementation detail:
 *
 *  1. the session is resolved first, so an anonymous submission is refused
 *     before any authorization decision is even reachable;
 *  2. the originating token's scope must be `*`, so a valid session minted from
 *     a project- or read-scoped token cannot drive an operator mutation;
 *  3. the CSRF token is verified last, against the session it was minted for and
 *     the form name whose handler is running, so a token harvested from one form
 *     cannot drive another.
 *
 * `dashboard-router.ts` answered the second and third refusals with a 403. A
 * Server Action cannot set a response status, so the refusal is a value the
 * caller renders instead; the boundary it preserves is the one that matters —
 * the service call is never reached. `apps/web/src/middleware.ts` already
 * redirects an unauthenticated `/dashboard` request, so `session_required` is
 * the defence-in-depth case of a cookie that expired mid-form.
 */

export type GuardError = 'session_required' | 'admin_required' | 'csrf_invalid';

export type GuardResult =
  | { ok: true; session: SessionContext; sessions: SessionsService; services: Services }
  | { ok: false; error: GuardError; message: string };

/** `apps/server/src/dashboard/csrf.ts`'s field name; `CsrfField` writes it. */
const CSRF_FIELD = 'csrf';

const MESSAGES: Record<GuardError, string> = {
  session_required: 'Your dashboard session has expired. Sign in again.',
  admin_required: 'This action requires an admin token.',
  csrf_invalid: 'This submission could not be verified. Reload the page and try again.',
};

function refuse(error: GuardError): GuardResult {
  return { ok: false, error, message: MESSAGES[error] };
}

/**
 * `cookieSource` is optional and exists for the test suite: a real request falls
 * through to `next/headers`, a test injects a cookie store it built from a real
 * `dashboard_sessions` row. Nothing else about the check is injectable, so the
 * tested path is the production path.
 */
export async function guardAction(
  formData: FormData,
  formName: string,
  cookieSource?: SessionCookieSource,
): Promise<GuardResult> {
  const services = getServices();

  const resolved = await resolveDashboardSession(cookieSource);
  if (resolved === null) return refuse('session_required');
  if (resolved.session.scope !== '*') return refuse('admin_required');

  const submitted = formData.get(CSRF_FIELD);
  const candidate = typeof submitted === 'string' ? submitted : '';
  // `verifyCsrf` compares the candidate against a 43-character HMAC, so an
  // absent or non-string field is refused on length alone; a separate
  // empty-candidate arm would be a condition no submission can distinguish.
  if (!resolved.sessions.verifyCsrf(resolved.session.session, formName, candidate)) {
    return refuse('csrf_invalid');
  }

  return { ok: true, session: resolved.session, sessions: resolved.sessions, services };
}

/**
 * What a refused mutation returns to its `ActionForm`, or the sign-in redirect
 * `dashboard-router.ts` answered an absent session with.
 *
 * `redirect` throws the framework's own control-flow error, so it must be called
 * from a frame that no `try` encloses — calling it inside the mutation's
 * `try`/`catch` would turn the redirect into a caught, discarded value. Every
 * action therefore resolves the guard *before* it opens that block, and the
 * redirect leaves from here.
 */
export function guardFailure(result: Extract<GuardResult, { ok: false }>): { error: string } {
  if (result.error === 'session_required') redirect('/dashboard/login');
  return { error: result.message };
}
