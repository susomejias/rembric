/**
 * `/dashboard/update` — update offer page, one-click trigger, progress
 * view with post-restart polling, and the JSON endpoints the progress
 * script consumes.
 */

import { Hono, type Context } from 'hono';

import type { SelfUpdateOrchestrator } from '../services/self-update/orchestrator.js';
import type { SessionsService } from '../services/sessions.js';
import type { UpdateCheckService } from '../services/update-check.js';
import { REMBRIC_VERSION } from '../version.js';

import { viewHead } from './components.js';
import { readFormAndVerifyCsrf } from './csrf.js';
import { renderPage } from './page-shell.js';
import { html, raw, type SafeHtml } from './templates.js';
import type { ResolvedSession } from './types.js';
import { updateActionBlock, updateChangelog, updateSummary } from './update-modal.js';
import type { UpdateViewState } from './update-modal.js';

export interface UpdateDeps {
  updates: UpdateCheckService;
  selfUpdate: SelfUpdateOrchestrator;
  sessions: SessionsService;
}

function getSession(c: Context): ResolvedSession | null {
  return (c.get('session') as ResolvedSession | undefined) ?? null;
}

function getUpdateState(c: Context): UpdateViewState | null {
  return (c.get('update') as UpdateViewState | undefined) ?? null;
}

// Polls /dashboard/update/status while this process is alive; once the
// swap starts (phase=restarting or the server stops answering) it flips
// to probing /dashboard/update/version and reloads when the version
// changes. Connection errors render as the restart step, not as errors.
const PROGRESS_SCRIPT = `
(function(){
  var root = document.querySelector('[data-upd-progress]');
  if (!root) return;
  var initial = root.getAttribute('data-initial-version') || '';
  var verifying = false;
  function setStep(key, state){
    var el = root.querySelector('[data-step="' + key + '"]');
    if (!el) return;
    el.setAttribute('data-state', state);
  }
  function setSteps(states){
    for (var k in states) setStep(k, states[k]);
  }
  function fail(message){
    var el = root.querySelector('[data-upd-error]');
    if (el) { el.textContent = message; el.style.display = ''; }
  }
  var sawDown = false;
  var sameVersionAfterDown = 0;
  function probeOpts(){
    var o = { credentials: 'same-origin' };
    // Docker Desktop port-forwards can hang instead of refusing while the
    // backend is down — never let a probe wait forever.
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) o.signal = AbortSignal.timeout(4000);
    return o;
  }
  function verifyTick(){
    fetch('/dashboard/update/version', probeOpts())
      .then(function(r){ return r.json(); })
      .then(function(v){
        if (v.version && v.version !== initial) {
          setSteps({ restart: 'done', verify: 'done' });
          window.location.replace('/dashboard');
          return;
        }
        // Same version AFTER the server went down and came back = the
        // upgrader rolled back (the old container was restarted).
        if (sawDown && ++sameVersionAfterDown >= 2) {
          setSteps({ restart: 'done', verify: 'idle' });
          fail('The update did not complete — the server is still on v' + initial +
            ' (the upgrader rolled back). Check the upgrader container logs on the host.');
          return;
        }
        setTimeout(verifyTick, 2000);
      })
      .catch(function(){ sawDown = true; setTimeout(verifyTick, 2000); });
  }
  function statusTick(){
    if (verifying) return;
    fetch('/dashboard/update/status', probeOpts())
      .then(function(r){ return r.json(); })
      .then(function(s){
        if (s.phase === 'failed') {
          fail(s.error || 'update failed');
          setSteps({ backup: 'idle', pull: 'idle', restart: 'idle', verify: 'idle' });
          return;
        }
        if (s.phase === 'backup') setSteps({ backup: 'active' });
        if (s.phase === 'pull') {
          setSteps({ backup: 'done', pull: 'active' });
          var pullEl = root.querySelector('[data-pull-progress]');
          if (pullEl && s.pull) pullEl.textContent = s.pull.done + '/' + s.pull.total + ' LAYERS';
        }
        if (s.phase === 'launch' || s.phase === 'restarting') {
          setSteps({ backup: 'done', pull: 'done', restart: 'active' });
          if (s.phase === 'restarting') {
            verifying = true;
            setSteps({ verify: 'active' });
            verifyTick();
            return;
          }
        }
        setTimeout(statusTick, 1500);
      })
      .catch(function(){
        // Server going down mid-swap is the expected path.
        verifying = true;
        setSteps({ backup: 'done', pull: 'done', restart: 'active', verify: 'active' });
        verifyTick();
      });
  }
  statusTick();
})();
`;

// Manual quadrant helper: while an update is available, watch for the
// operator running the compose commands out-of-band and reload when the
// server comes back on the new version.
const WATCH_SCRIPT = `
(function(){
  var el = document.querySelector('[data-upd-watch]');
  if (!el) return;
  var initial = el.getAttribute('data-initial-version') || '';
  function tick(){
    var o = { credentials: 'same-origin' };
    if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) o.signal = AbortSignal.timeout(4000);
    fetch('/dashboard/update/version', o)
      .then(function(r){ return r.json(); })
      .then(function(v){
        if (v.version && v.version !== initial) window.location.reload();
        else setTimeout(tick, 5000);
      })
      .catch(function(){ setTimeout(tick, 5000); });
  }
  setTimeout(tick, 5000);
})();
`;

function progressStep(key: string, label: string): SafeHtml {
  return html`
    <div class="upd-step" data-step="${key}" data-state="idle">
      <span class="dot"></span>
      <span class="label">${label}</span>
      ${key === 'pull' ? html`<span class="meta" data-pull-progress></span>` : raw('')}
    </div>
  `;
}

export function createUpdateRouter(deps: UpdateDeps): Hono {
  const app = new Hono();

  app.get('/', (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');

    const status = deps.selfUpdate.status();
    const running =
      status.phase === 'backup' ||
      status.phase === 'pull' ||
      status.phase === 'launch' ||
      status.phase === 'restarting';

    if (running) {
      const body = html`
        ${viewHead({ num: '09', title: 'Updating Rembric.', hl: 'Updating' })}
        <div class="upd-progress" data-upd-progress data-initial-version="${REMBRIC_VERSION}">
          <div class="upd-progress-title">
            INSTALLING v${status.targetVersion ?? ''}
            <span class="sub">USUALLY TAKES UNDER A MINUTE</span>
          </div>
          ${progressStep('backup', 'BACK UP DATABASE')} ${progressStep('pull', 'PULL NEW IMAGE')}
          ${progressStep('restart', 'RESTART SERVICE')}
          ${progressStep('verify', 'VERIFY NEW VERSION')}
          <div class="flash error" data-upd-error style="display:none"></div>
        </div>
        <script>
          ${raw(PROGRESS_SCRIPT)};
        </script>
      `;
      return c.html(
        renderPage(c, deps.sessions, body, { title: 'Update', activeNav: 'home', view: 'update' }),
      );
    }

    const state = getUpdateState(c);
    const err = c.req.query('err');
    const flash = err
      ? ({ kind: 'error', text: updateErrorText(err) } as const)
      : status.phase === 'failed' && status.error
        ? ({ kind: 'error', text: `Last update attempt failed: ${status.error}` } as const)
        : undefined;

    const body = state
      ? html`
          ${viewHead({ num: '09', title: 'Update Available.', hl: 'Update' })}
          <div class="upd-page" data-upd-watch data-initial-version="${REMBRIC_VERSION}">
            ${updateSummary(state.info)} ${updateChangelog(state.info)}
            ${updateActionBlock(state, session.session, deps.sessions)}
          </div>
          <script>
            ${raw(WATCH_SCRIPT)};
          </script>
        `
      : html`
          ${viewHead({ num: '09', title: 'Updates.', hl: 'Updates' })}
          <div class="upd-page">
            <div class="upd-note">
              <span class="lab">UP TO DATE</span>
              <p>
                You are running <code>v${REMBRIC_VERSION}</code> — no newer release is known. The
                check runs at most once a day and can be disabled with
                <code>REMBRIC_UPDATE_CHECK=off</code>.
              </p>
            </div>
          </div>
        `;

    return c.html(
      renderPage(c, deps.sessions, body, {
        title: 'Update',
        activeNav: 'home',
        view: 'update',
        flash,
      }),
    );
  });

  app.post('/start', async (c) => {
    const session = getSession(c);
    if (!session) return c.redirect('/dashboard/login');
    const form = await readFormAndVerifyCsrf(c, session.session, deps.sessions, 'update.start');
    if (form instanceof Response) return form;

    const info = deps.updates.peek();
    if (!info) return c.redirect('/dashboard/update?err=no_update');
    const result = await deps.selfUpdate.start(info.latestVersion);
    if (!result.ok) return c.redirect(`/dashboard/update?err=${result.code}`);
    return c.redirect('/dashboard/update');
  });

  app.get('/status', (c) => {
    const session = getSession(c);
    if (!session) return c.json({ ok: false }, 401);
    return c.json(deps.selfUpdate.status());
  });

  app.get('/version', (c) => {
    const session = getSession(c);
    if (!session) return c.json({ ok: false }, 401);
    return c.json({ version: REMBRIC_VERSION });
  });

  return app;
}

function updateErrorText(code: string): string {
  switch (code) {
    case 'not_available':
      return 'One-click update is not available on this deployment (no usable Docker socket or pinned image tag).';
    case 'already_running':
      return 'An update is already in progress.';
    case 'backup_failed':
      return 'The pre-update database backup failed; the update was aborted before touching any container.';
    case 'no_update':
      return 'No update is currently known.';
    default:
      return 'The update could not be started.';
  }
}
