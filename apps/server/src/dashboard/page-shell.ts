/**
 * Convenience wrapper around `shell()` that builds the brutalist sidebar
 * for an authenticated dashboard page.
 *
 * Per-route handlers call `renderPage(c, deps.sessions, body, opts)` and
 * get back the full HTML string — sidebar, mobile bar, view-head wrapper,
 * cookie-driven collapse state, and CSRF-protected toggle button included.
 */

import type { Context } from 'hono';
import { getCookie } from 'hono/cookie';

import type { SessionsService } from '../services/sessions.js';

import { renderSidebar, type NavKey } from './components.js';
import { csrfInput } from './csrf.js';
import { raw, shell, type SafeHtml } from './templates.js';
import type { ResolvedSession } from './types.js';

const SIDEBAR_COOKIE = 'rbr-sb-collapsed';

export interface PageOpts {
  title: string;
  activeNav: NavKey;
  view?: string;
  counters?: { pendingJudgments?: number };
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
  const sidebar = renderSidebar({
    active: opts.activeNav,
    counters: opts.counters ?? {},
    collapsed,
    csrf,
  });
  return shell(body, {
    title: opts.title,
    activeNav: opts.activeNav,
    view: opts.view ?? opts.activeNav,
    sidebar,
    collapsed,
    flash: opts.flash,
    counters: opts.counters,
  });
}
