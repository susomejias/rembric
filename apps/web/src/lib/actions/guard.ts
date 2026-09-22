import type { SessionContext, SessionsService } from '@rembric/core';
import { redirect } from 'next/navigation';

import { getServices, type Services } from '../services';
import { resolveDashboardSession, type SessionCookieSource } from '../session';

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
  if (!resolved.sessions.verifyCsrf(resolved.session.session, formName, candidate)) {
    return refuse('csrf_invalid');
  }

  return { ok: true, session: resolved.session, sessions: resolved.sessions, services };
}

export function guardFailure(result: Extract<GuardResult, { ok: false }>): { error: string } {
  if (result.error === 'session_required') redirect('/dashboard/login');
  return { error: result.message };
}
