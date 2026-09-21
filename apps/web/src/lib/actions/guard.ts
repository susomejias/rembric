import type { SessionContext, SessionsService } from '@rembric/core';
import { redirect } from 'next/navigation';

import { getServices, type Services } from '../services';
import { resolveDashboardSession, type SessionCookieSource } from '../session';

/**
 * The three preconditions every dashboard mutation checks. The order is the
 * contract, not an implementation detail:
 *
 *  1. the session is resolved first, so an anonymous submission is refused
 *     before any authorization decision is even reachable;
 *  2. the originating token's scope must be `*`, so a valid session minted from
 *     a project- or read-scoped token cannot drive an operator mutation;
 *  3. the CSRF token is verified last, against the session it was minted for and
 *     the form name whose handler is running, so a token harvested from one form
 *     cannot drive another.
 *
 * A Server Action cannot set a response status, so a refusal is a value the
 * caller renders; the service call is never reached either way.
 */

export type GuardError = 'session_required' | 'admin_required' | 'csrf_invalid';

export type GuardResult =
  | { ok: true; session: SessionContext; sessions: SessionsService; services: Services }
  | { ok: false; error: GuardError; message: string };

const CSRF_FIELD = 'csrf';

const MESSAGES: Record<GuardError, string> = {
  session_required: 'Your dashboard session has expired. Sign in again.',
  admin_required: 'This action requires an admin token.',
  csrf_invalid: 'This submission could not be verified. Reload the page and try again.',
};

function refuse(error: GuardError): GuardResult {
  return { ok: false, error, message: MESSAGES[error] };
}

/** `cookieSource` is for the test suite: a real request falls through to `next/headers`, so the tested path is the production path. */
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
  // `verifyCsrf` refuses on the 43-character HMAC length alone, so a separate
  // empty-candidate arm would be unreachable.
  if (!resolved.sessions.verifyCsrf(resolved.session.session, formName, candidate)) {
    return refuse('csrf_invalid');
  }

  return { ok: true, session: resolved.session, sessions: resolved.sessions, services };
}

/**
 * `redirect` throws the framework's own control-flow error, so it must be called
 * from a frame that no `try` encloses — called inside a mutation's
 * `try`/`catch` it would turn into a caught, discarded value.
 */
export function guardFailure(result: Extract<GuardResult, { ok: false }>): { error: string } {
  if (result.error === 'session_required') redirect('/dashboard/login');
  return { error: result.message };
}
