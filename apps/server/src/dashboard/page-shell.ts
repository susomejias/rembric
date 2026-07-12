/**
 * Convenience wrapper around `shell()` that builds the brutalist sidebar
 * for an authenticated dashboard page.
 *
 * Per-route handlers call `renderPage(c, deps.sessions, body, opts)` and
 * get back the full HTML string — sidebar, mobile bar, view-head wrapper,
 * cookie-driven collapse state, CSRF-protected toggle button, and the
 * update badge/modal (when the auth middleware found a newer release)
 * included.
 */

import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';

import type { SessionsService } from '../services/sessions.js';

import { renderSidebar, type NavKey } from './components.js';
import { csrfInput } from './csrf.js';
import { raw, shell, type SafeHtml } from './templates.js';
import type { ResolvedSession } from './types.js';
import { updateShellExtras, type UpdateViewState } from './update-modal.js';

const SIDEBAR_COOKIE = 'rbr-sb-collapsed';

export interface PageOpts {
  title: string;
  activeNav: NavKey;
  view?: string;
  counters?: { pendingJudgments?: number; needsReview?: number };
  flash?: { kind: 'error' | 'success'; text: string };
}

export function renderPage(
  c: Context,
  sessionsService: SessionsService,
  body: SafeHtml,
  opts: PageOpts,
): string {
  const resolved = c.get('session' as never) as ResolvedSession | undefined;
  const collapsed = getCookie(c, SIDEBAR_COOKIE) === '1';
  const csrf = resolved ? csrfInput(resolved.session, sessionsService, 'sidebar.toggle') : raw('');
  const updateState = (c.get('update' as never) as UpdateViewState | undefined | null) ?? null;
  const checkEnabled = (c.get('updateCheckEnabled' as never) as boolean | undefined) ?? false;
  const { badge, modal } = updateShellExtras(
    updateState,
    resolved?.session ?? null,
    sessionsService,
    checkEnabled,
  );
  const sidebar = renderSidebar({
    active: opts.activeNav,
    counters: opts.counters ?? {},
    collapsed,
    csrf,
    update: badge,
  });
  return shell(body, {
    title: opts.title,
    activeNav: opts.activeNav,
    view: opts.view ?? opts.activeNav,
    sidebar,
    collapsed,
    flash: opts.flash,
    counters: opts.counters,
    updateBadge: badge,
    updateModal: modal,
  });
}
