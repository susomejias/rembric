import type { Context } from 'hono';

import type { DashboardSession } from '../db/schema/sessions.js';
import type { SessionsService } from '../services/sessions.js';

import { raw, type SafeHtml } from './templates.js';

const CSRF_FIELD = 'csrf';

/**
 * Mint a CSRF token bound to the current session + form name and emit
 * the hidden input HTML in one shot. Templates do:
 *
 *   ${csrfInput(session, sessions, 'memory.archive')}
 */
export function csrfInput(
  session: DashboardSession,
  sessions: SessionsService,
  formName: string,
): SafeHtml {
  const token = sessions.csrfToken(session, formName);
  return raw(`<input type="hidden" name="${CSRF_FIELD}" value="${token}">`);
}

export async function verifyCsrf(
  c: Context,
  session: DashboardSession,
  sessions: SessionsService,
  formName: string,
): Promise<true | Response> {
  const form = await c.req.formData();
  const submitted = form.get(CSRF_FIELD);
  const candidate = typeof submitted === 'string' ? submitted : '';
  if (!candidate || !sessions.verifyCsrf(session, formName, candidate)) {
    return c.json({ ok: false, code: 'csrf_invalid' }, 403);
  }
  return true;
}

/** Read the parsed form data + verify CSRF in one helper. */
export async function readFormAndVerifyCsrf(
  c: Context,
  session: DashboardSession,
  sessions: SessionsService,
  formName: string,
): Promise<FormData | Response> {
  const form = await c.req.formData();
  const submitted = form.get(CSRF_FIELD);
  const candidate = typeof submitted === 'string' ? submitted : '';
  if (!candidate || !sessions.verifyCsrf(session, formName, candidate)) {
    return c.json({ ok: false, code: 'csrf_invalid' }, 403);
  }
  return form;
}

export { CSRF_FIELD };
