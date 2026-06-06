/**
 * Update-availability UI shared between the global dashboard modal
 * (injected by `page-shell.ts` on every authenticated page) and the
 * `/dashboard/update` view. Pure renderers — the router lives in
 * `update.ts`.
 */

import type { DashboardSession } from '../db/schema/sessions.js';
import type { SelfUpdateCapability } from '../services/self-update/capability.js';
import type { SessionsService } from '../services/sessions.js';
import type { UpdateInfo } from '../services/update-check.js';

import { btn } from './components.js';
import { csrfInput } from './csrf.js';
import { formatTs, html, raw, type SafeHtml } from './templates.js';

export const UPDATE_DOCS_URL = 'https://github.com/susomejias/rembric/blob/main/docs/updates.md';
export const MANUAL_UPDATE_COMMAND = 'docker compose pull && docker compose up -d';

/** Per-request update view state threaded through Hono context. */
export interface UpdateViewState {
  info: UpdateInfo;
  capability: SelfUpdateCapability;
  /** True while an update run is in flight (progress view takes over). */
  running: boolean;
}

/** Capability-dependent primary action block (modal and update page). */
export function updateActionBlock(
  state: UpdateViewState,
  session: DashboardSession,
  sessions: SessionsService,
): SafeHtml {
  const { info, capability } = state;
  if (capability.state === 'available') {
    return html`
      <form
        action="/dashboard/update/start"
        method="post"
        class="upd-action"
        data-confirm="Rembric will back up the database, stop, replace its container with v${info.latestVersion} and restart. Your data and configuration are preserved."
        data-confirm-label="UPDATE NOW"
        data-confirm-tone="danger"
      >
        ${csrfInput(session, sessions, 'update.start')}
        ${btn({ variant: 'primary', label: `UPDATE TO v${info.latestVersion} →`, type: 'submit' })}
      </form>
    `;
  }
  if (capability.state === 'pinned') {
    return html`
      <div class="upd-note warn">
        <span class="lab">ONE-CLICK DISABLED · IMAGE TAG PINNED</span>
        <p>
          This deployment pins the image to <code>:${capability.imageTag ?? ''}</code> (the
          <code>REMBRIC_VERSION</code> variable in your <code>.env</code>). Self-updating would be
          silently reverted by the next <code>docker compose up</code>. Remove the pin and run
          <code>docker compose up -d</code> once to enable one-click updates, or update manually:
        </p>
        ${commandBlock()}
      </div>
    `;
  }
  return html`
    <div class="upd-note">
      <span class="lab">MANUAL UPDATE</span>
      <p>Run this on the host, then this page will reload on the new version:</p>
      ${commandBlock()}
      <a href="${UPDATE_DOCS_URL}" target="_blank" rel="noopener" class="upd-docs-link"
        >HOW TO ENABLE ONE-CLICK UPDATES ›</a
      >
    </div>
  `;
}

function commandBlock(): SafeHtml {
  return html`
    <div class="upd-cmd">
      <code data-upd-cmd>${MANUAL_UPDATE_COMMAND}</code>
      <button type="button" class="btn secondary sm" data-upd-copy>COPY</button>
    </div>
  `;
}

export function updateSummary(info: UpdateInfo): SafeHtml {
  return html`
    <div class="upd-versions">
      <code>v${info.currentVersion}</code>
      <span class="arrow">→</span>
      <code class="new">v${info.latestVersion}</code>
      ${info.publishedAt
        ? html`<span class="when">· published ${formatTs(info.publishedAt)}</span>`
        : raw('')}
    </div>
  `;
}

export function updateChangelog(info: UpdateInfo): SafeHtml {
  return html`
    <div class="upd-changelog-head">
      <span>WHAT'S NEW</span>
      ${info.releaseUrl
        ? html`<a href="${info.releaseUrl}" target="_blank" rel="noopener"
            >VIEW RELEASE ON GITHUB ›</a
          >`
        : raw('')}
    </div>
    <pre class="upd-changelog">${info.changelog || '(no changelog provided)'}</pre>
  `;
}

// Auto-show unless this exact version was dismissed; LATER persists the
// dismissal per version; COPY feeds the manual command to the clipboard.
const MODAL_SCRIPT = `
(function(){
  function bind(){
    var dlg = document.getElementById('rbr-update');
    if (!dlg || typeof dlg.showModal !== 'function') return;
    var version = dlg.getAttribute('data-version') || '';
    var KEY = 'rbr-upd-dismissed';
    var copyBtns = dlg.querySelectorAll('[data-upd-copy]');
    for (var i = 0; i < copyBtns.length; i++) {
      copyBtns[i].addEventListener('click', function(e){
        var code = dlg.querySelector('[data-upd-cmd]');
        if (code && navigator.clipboard) {
          navigator.clipboard.writeText(code.textContent || '');
          e.target.textContent = 'COPIED';
        }
      });
    }
    var later = dlg.querySelector('[data-upd-later]');
    if (later) {
      later.addEventListener('click', function(){
        try { localStorage.setItem(KEY, version); } catch (_) {}
        dlg.close();
      });
    }
    var dismissed = null;
    try { dismissed = localStorage.getItem(KEY); } catch (_) {}
    if (dismissed !== version && !dlg.open) dlg.showModal();
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
`;

/**
 * The global per-version dismissable modal. Returns empty when there is
 * nothing to announce or while an update run is already in progress.
 */
export function renderUpdateModal(
  state: UpdateViewState | null,
  session: DashboardSession,
  sessions: SessionsService,
): SafeHtml {
  if (!state || state.running) return raw('');
  const { info } = state;
  return html`
    <dialog id="rbr-update" class="modal upd-modal" data-version="${info.latestVersion}">
      <div class="modal-head">
        <span class="bn"></span>
        <span class="lab">UPDATE AVAILABLE</span>
      </div>
      <div class="modal-body">
        ${updateSummary(info)} ${updateChangelog(info)}
        ${updateActionBlock(state, session, sessions)}
      </div>
      <div class="modal-foot">
        <button type="button" data-upd-later>LATER</button>
        <a class="btn secondary" href="/dashboard/update">OPEN UPDATE PAGE →</a>
      </div>
    </dialog>
    <script>
      ${raw(MODAL_SCRIPT)};
    </script>
  `;
}

/** Brand-block badge (sidebar + mobile bar). */
export function updateBadge(latestVersion: string): SafeHtml {
  return html`
    <a class="sb-update" href="/dashboard/update" title="Update available">
      <span class="bn"></span>
      <span class="label">UPDATE v${latestVersion}</span>
    </a>
  `;
}

/**
 * Badge + modal pair for the page shell, derived from the per-request
 * update state set by the dashboard auth middleware.
 */
export function updateShellExtras(
  state: UpdateViewState | null,
  session: DashboardSession | null,
  sessions: SessionsService,
): { badge: SafeHtml | null; modal: SafeHtml | undefined } {
  if (!state || !session) return { badge: null, modal: undefined };
  return {
    badge: updateBadge(state.info.latestVersion),
    modal: renderUpdateModal(state, session, sessions),
  };
}
