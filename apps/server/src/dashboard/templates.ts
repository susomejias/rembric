/**
 * SSR helpers for the dashboard.
 *
 * `html` escapes every interpolated value by default. Use `raw` to opt
 * out (for pre-rendered HTML produced by another `html` call).
 *
 * The brutalist visual identity ships as compiled CSS bundles under
 * `dist/dashboard/public/assets/styles/` — emitted by
 * `scripts/build-css.mjs` from `src/dashboard/styles/`. `shell()` reads
 * the build-time manifest to inject the right per-page `<link>` tags.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderMobileBar, type NavKey } from './components.js';

export interface SafeHtml {
  readonly __html: string;
}

export function isSafeHtml(value: unknown): value is SafeHtml {
  return typeof value === 'object' && value !== null && '__html' in value;
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = '';
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) {
      out += renderValue(values[i]);
    }
  }
  return { __html: out };
}

export function raw(s: string): SafeHtml {
  return { __html: s };
}

function renderValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return escape(value);
  if (typeof value === 'number' || typeof value === 'bigint' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) return escape(value.toISOString());
  if (isSafeHtml(value)) return value.__html;
  if (Array.isArray(value)) return value.map(renderValue).join('');
  return escape(JSON.stringify(value));
}

export function escape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ─── manifest (built-CSS lookup) ──────────────────────────────────── */

interface CssManifest {
  core: string | null;
  views: Record<string, string>;
}

const EMPTY_MANIFEST: CssManifest = { core: null, views: {} };

let cachedManifest: CssManifest | null = null;

function manifestPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled mode (`<repo>/dist/dashboard/`): manifest lives next door.
  // tsx mode (`<repo>/src/dashboard/`, used by the dev container):
  // `build:css` writes only to `dist/`, so redirect the lookup to the
  // sibling dist tree. See docs/docker.md::Local dev stack for the
  // chained build:css + copy-assets startup that populates it.
  if (here.endsWith('/src/dashboard') || here.endsWith('\\src\\dashboard')) {
    return resolve(here, '../../dist/dashboard/public/assets/styles/manifest.json');
  }
  return resolve(here, 'public/assets/styles/manifest.json');
}

function loadManifest(): CssManifest {
  if (cachedManifest) return cachedManifest;
  const p = manifestPath();
  if (!existsSync(p)) {
    cachedManifest = EMPTY_MANIFEST;
    return cachedManifest;
  }
  try {
    const text = readFileSync(p, 'utf8');
    const parsed = JSON.parse(text) as CssManifest;
    cachedManifest = parsed;
    return parsed;
  } catch {
    cachedManifest = EMPTY_MANIFEST;
    return cachedManifest;
  }
}

/* ─── upgrader script (timestamps) ─────────────────────────────────── */

const TS_UPGRADER = `
(function(){
  function upgrade(root){
    var scope = root && root.querySelectorAll ? root : document;
    var nodes = scope.querySelectorAll('time[data-rembric-ts][datetime]');
    if (!nodes.length) return;
    var fmt;
    try {
      fmt = new Intl.DateTimeFormat(undefined, {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false
      });
    } catch (_) { return; }
    for (var i = 0; i < nodes.length; i++) {
      var iso = nodes[i].getAttribute('datetime');
      var d = new Date(iso);
      if (!isNaN(d.getTime())) nodes[i].textContent = fmt.format(d);
    }
  }
  function bind(){
    upgrade(document);
    if (document.body) {
      document.body.addEventListener('htmx:afterSwap', function(e){
        upgrade(e && e.target ? e.target : document);
      });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
`;

// Desktop sidebar collapse with animation. The form normally POSTs to
// /_sidebar/toggle and reloads the page; this enhancement toggles the
// `.is-collapsed` class on `.app` instantly so the CSS width transition
// plays, then persists the new state via background fetch.
const SB_COLLAPSE = `
(function(){
  function bind(){
    var form = document.querySelector('form[action="/dashboard/_sidebar/toggle"]');
    var app = document.querySelector('.app');
    if (!form || !app) return;
    var sb = app.querySelector('.sb');
    form.addEventListener('submit', function(e){
      if (e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      var nowCollapsed = !app.classList.contains('is-collapsed');
      // Toggle on both .app (layout width) and .sb (label visibility)
      // so the existing CSS rules fire together — toggling just one
      // leaves overflowing labels.
      app.classList.toggle('is-collapsed', nowCollapsed);
      if (sb) sb.classList.toggle('is-collapsed', nowCollapsed);
      var data = new FormData(form);
      fetch(form.action, { method: 'POST', body: data, credentials: 'same-origin' }).catch(function(){});
      var glyph = form.querySelector('.glyph');
      var label = form.querySelector('.sb-collapse .label');
      if (glyph) glyph.textContent = nowCollapsed ? '››' : '‹‹';
      if (label) label.textContent = nowCollapsed ? 'EXPAND' : 'COLLAPSE';
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
`;

const MOB_TOGGLE = `
(function(){
  function bind(){
    var btn = document.querySelector('.mob-toggle');
    var sb = document.querySelector('.app > .sb');
    var closeBtn = document.querySelector('.sb-mob-close');
    if (!btn || !sb) return;
    function setOpen(open){
      sb.classList.toggle('is-open', open);
      btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      btn.textContent = open ? '✕ CLOSE' : '☰ MENU';
    }
    btn.addEventListener('click', function(e){
      e.preventDefault();
      setOpen(!sb.classList.contains('is-open'));
    });
    if (closeBtn) {
      closeBtn.addEventListener('click', function(e){
        e.preventDefault();
        setOpen(false);
      });
    }
    // Close when clicking a nav item that doesn't navigate elsewhere is
    // handled by the page reload itself; nav items inside the drawer
    // already navigate, so no extra handler is needed there.
    // Allow Escape to close.
    document.addEventListener('keydown', function(e){
      if (e.key === 'Escape' && sb.classList.contains('is-open')) {
        setOpen(false);
      }
    });
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bind);
  } else {
    bind();
  }
})();
`;

// Confirm-before-submit for destructive forms. Any <form data-confirm="msg">
// (with optional data-confirm-label / data-confirm-tone) opens the global
// dialog before letting the submit through. Tone defaults to 'danger'.
const CONFIRM = `
(function(){
  function bind(root){
    var scope = root && root.querySelectorAll ? root : document;
    var forms = scope.querySelectorAll('form[data-confirm]');
    var dlg = document.getElementById('rbr-confirm');
    if (!dlg) return;
    for (var i = 0; i < forms.length; i++) {
      var f = forms[i];
      if (f.__rbrConfirmBound) continue;
      f.__rbrConfirmBound = true;
      f.addEventListener('submit', function(e){
        if (this.__rbrConfirmed) return;
        e.preventDefault();
        var msg = this.getAttribute('data-confirm') || 'Are you sure?';
        var label = this.getAttribute('data-confirm-label') || 'CONFIRM';
        var tone = this.getAttribute('data-confirm-tone') || 'danger';
        dlg.setAttribute('data-tone', tone);
        dlg.querySelector('.modal-head .lab').textContent =
          tone === 'danger' ? 'CONFIRM DESTRUCTIVE ACTION' :
          tone === 'warn' ? 'CONFIRM ACTION' : 'CONFIRM';
        dlg.querySelector('.modal-body').textContent = msg;
        var confirmBtn = dlg.querySelector('button[value="confirm"]');
        confirmBtn.textContent = label;
        var form = this;
        dlg.returnValue = '';
        dlg.showModal();
        dlg.addEventListener('close', function onClose(){
          dlg.removeEventListener('close', onClose);
          if (dlg.returnValue === 'confirm') {
            form.__rbrConfirmed = true;
            form.submit();
          }
        });
      });
    }
  }
  function start(){
    bind(document);
    if (document.body) {
      document.body.addEventListener('htmx:afterSwap', function(e){
        bind(e && e.target ? e.target : document);
      });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;

// Whole-row navigation for tables: any <tr data-href> sends the user to that
// URL on click. The handler bails out when the click target is an
// interactive element (a, button, input, form, label) so action buttons —
// DELETE, REVOKE, JUDGE, etc. — keep working.
const ROW_LINK = `
(function(){
  function isInteractive(el){
    while (el && el.nodeType === 1) {
      var tag = el.tagName;
      if (tag === 'A' || tag === 'BUTTON' || tag === 'INPUT' ||
          tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'LABEL' ||
          tag === 'FORM') return true;
      el = el.parentNode;
    }
    return false;
  }
  function bind(root){
    var scope = root && root.querySelectorAll ? root : document;
    var rows = scope.querySelectorAll('tr[data-href]');
    for (var i = 0; i < rows.length; i++) {
      if (rows[i].__rbrBound) continue;
      rows[i].__rbrBound = true;
      rows[i].addEventListener('click', function(e){
        if (isInteractive(e.target)) return;
        var href = this.getAttribute('data-href');
        if (href) window.location.href = href;
      });
    }
  }
  function start(){
    bind(document);
    if (document.body) {
      document.body.addEventListener('htmx:afterSwap', function(e){
        bind(e && e.target ? e.target : document);
      });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;

// Copy-raw for rendered Markdown blocks. Each <div class="md-block"> pairs a
// rendered <div class="md-body"> with a hidden <pre class="md-raw"> holding the
// verbatim source; the [data-md-copy] button copies that source so the raw
// Markdown isn't lost behind the render. Uses the async Clipboard API when in a
// secure context (https/localhost) and falls back to execCommand for plain-http
// deployments behind a VPN.
const MD_COPY = `
(function(){
  function copyText(text){
    if (navigator.clipboard && window.isSecureContext) {
      return navigator.clipboard.writeText(text);
    }
    return new Promise(function(resolve, reject){
      try {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.setAttribute('readonly', '');
        ta.style.position = 'absolute';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        var ok = document.execCommand('copy');
        document.body.removeChild(ta);
        ok ? resolve() : reject(new Error('execCommand failed'));
      } catch (e) { reject(e); }
    });
  }
  function bind(root){
    var scope = root && root.querySelectorAll ? root : document;
    var btns = scope.querySelectorAll('[data-md-copy]');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      if (b.__rbrMdCopyBound) continue;
      b.__rbrMdCopyBound = true;
      b.addEventListener('click', function(){
        var block = this.closest ? this.closest('.md-block') : this.parentNode;
        var src = block ? block.querySelector('.md-raw') : null;
        if (!src) return;
        var btn = this;
        copyText(src.textContent || '').then(function(){
          btn.classList.add('is-copied');
          setTimeout(function(){ btn.classList.remove('is-copied'); }, 1500);
        }).catch(function(){
          btn.classList.add('is-failed');
          setTimeout(function(){ btn.classList.remove('is-failed'); }, 1500);
        });
      });
    }
  }
  function start(){
    bind(document);
    if (document.body) {
      document.body.addEventListener('htmx:afterSwap', function(e){
        bind(e && e.target ? e.target : document);
      });
    }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
`;

/* ─── shell ─────────────────────────────────────────────────────────── */

export interface ShellOptions {
  title: string;
  activeNav?: NavKey;
  view?: string;
  collapsed?: boolean;
  flash?: { kind: 'error' | 'success'; text: string };
  counters?: { pendingJudgments?: number };
  /** Pre-rendered sidebar (with CSRF). When omitted, the shell renders
   *  without a sidebar — used for the login page. */
  sidebar?: SafeHtml;
  /** Pre-rendered update badge for the mobile bar (sidebar embeds its own). */
  updateBadge?: SafeHtml | null;
  /** Pre-rendered update-available dialog + script (see `update-modal.ts`). */
  updateModal?: SafeHtml;
}

export function shell(body: SafeHtml, opts: ShellOptions): string {
  const manifest = loadManifest();
  const viewKey = opts.view ?? opts.activeNav ?? null;
  const viewHref = viewKey ? manifest.views[viewKey] : undefined;

  const links: string[] = [];
  if (manifest.core) {
    links.push(`<link rel="stylesheet" href="/dashboard/assets/styles/${manifest.core}">`);
  }
  if (viewHref) {
    links.push(`<link rel="stylesheet" href="/dashboard/assets/styles/${viewHref}">`);
  }

  const flashHtml = opts.flash
    ? `<div class="flash ${opts.flash.kind === 'error' ? 'error' : 'success'}"><span class="lab">${opts.flash.kind === 'error' ? 'ERROR' : 'OK'}</span><span>${escape(opts.flash.text)}</span></div>`
    : '';

  const collapsed = opts.collapsed ?? false;

  const shellBody = opts.sidebar
    ? `<div class="app${collapsed ? ' is-collapsed' : ''}">
${opts.sidebar.__html}
${renderMobileBar(opts.activeNav ?? null, opts.updateBadge ?? null).__html}
<main class="main">
${flashHtml}
${body.__html}
</main>
</div>`
    : `<main>
${flashHtml}
${body.__html}
</main>`;

  const out = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(opts.title)} · Rembric</title>
<link rel="icon" type="image/png" sizes="32x32" href="/dashboard/assets/favicon-32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/dashboard/assets/favicon-16.png">
<link rel="shortcut icon" href="/dashboard/assets/favicon.png">
<link rel="apple-touch-icon" href="/dashboard/assets/favicon.png">
${links.join('\n')}
<script>${TS_UPGRADER}</script>
<script>${MOB_TOGGLE}</script>
<script>${SB_COLLAPSE}</script>
<script>${ROW_LINK}</script>
<script>${CONFIRM}</script>
<script>${MD_COPY}</script>
</head>
<body>
${shellBody}
${opts.updateModal ? opts.updateModal.__html : ''}
<dialog id="rbr-confirm" class="modal" data-tone="danger">
  <form method="dialog">
    <div class="modal-head">
      <span class="bn"></span>
      <span class="lab">CONFIRM DESTRUCTIVE ACTION</span>
    </div>
    <div class="modal-body">Are you sure?</div>
    <div class="modal-foot">
      <button type="submit" value="cancel">CANCEL</button>
      <button type="submit" value="confirm">CONFIRM</button>
    </div>
  </form>
</dialog>
</body>
</html>`;

  return minifyHtml(out);
}

/* ─── HTML whitespace-collapse minifier ────────────────────────────── */

const SKIP_RE = /<(pre|textarea|script)\b[^>]*>[\s\S]*?<\/\1>/gi;
const PLACEHOLDER = ' ';

export function minifyHtml(s: string): string {
  // Carve out skip-zones so we never collapse inside <pre>/<textarea>/<script>.
  const stash: string[] = [];
  const stashed = s.replace(SKIP_RE, (match) => {
    stash.push(match);
    return `${PLACEHOLDER}${stash.length - 1}${PLACEHOLDER}`;
  });

  const collapsed = stashed
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return collapsed.replace(new RegExp(`${PLACEHOLDER}(\\d+)${PLACEHOLDER}`, 'g'), (_, idx) => {
    return stash[Number(idx)] ?? '';
  });
}

/* ─── pills + timestamp helper ─────────────────────────────────────── */

export function statusPill(status: string): SafeHtml {
  const cls = escape(status);
  return raw(`<span class="pill ${cls}">${cls}</span>`);
}

/** Badge for the derived `needs_review` state; rendered only when applicable. */
export function reviewPill(): SafeHtml {
  return raw('<span class="pill needs_review">needs_review</span>');
}

export function scopePill(scope: string): SafeHtml {
  const cls = escape(scope);
  const label = scope === 'global' ? 'GLOBAL' : 'PROJECT';
  return raw(`<span class="pill ${cls}">${label}</span>`);
}

const VERDICT_KINDS = new Set([
  'supersedes',
  'conflicts_with',
  'related',
  'compatible',
  'scoped',
  'not_conflict',
]);

export function verdictPill(kind: string | null | undefined): SafeHtml {
  if (!kind) return raw('<span class="muted">—</span>');
  if (!VERDICT_KINDS.has(kind)) return raw(`<span class="pill">${escape(kind)}</span>`);
  const cls = escape(kind);
  return raw(`<span class="pill k-${cls}">${cls}</span>`);
}

export function formatTs(d: Date | string | number | null | undefined): SafeHtml {
  if (d === null || d === undefined) return raw('—');
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return raw('—');
  const iso = date.toISOString();
  const fallback = iso.replace('T', ' ').slice(0, 19) + ' UTC';
  return raw(`<time datetime="${iso}" data-rembric-ts>${escape(fallback)}</time>`);
}

export function shortId(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 14 ? id.slice(0, 8) + '…' + id.slice(-4) : id;
}
