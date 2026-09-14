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

import { renderSidebar, type BadgeCounters, type NavKey } from './components.js';
import { csrfInput } from './csrf.js';
import { raw, shell, type SafeHtml } from './templates.js';
import type { ResolvedSession } from './types.js';
import { updateShellExtras, type UpdateViewState } from './update-modal.js';

const SIDEBAR_COOKIE = 'rbr-sb-collapsed';

export interface PageOpts {
  title: string;
  activeNav: NavKey;
  view?: string;
  /** Override for the request-wide badge counters (see `badgeCountersFrom`). */
  badges?: BadgeCounters;
  flash?: { kind: 'error' | 'success'; text: string };
}

/**
 * Sidebar badge counters for the current request, computed once by the
 * dashboard router's auth middleware (`computeBadgeCounters`) and stashed in
 * context. Every page sees the same badges; a handler may still override via
 * `PageOpts.badges`.
 */
export function badgeCountersFrom(c: Context): BadgeCounters {
  return (c.get('badgeCounters' as never) as BadgeCounters | undefined) ?? {};
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
    counters: opts.badges ?? badgeCountersFrom(c),
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
    updateBadge: badge,
    updateModal: modal,
  });
}
