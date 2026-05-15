/**
 * Minimal server-side rendering helpers for the dashboard.
 *
 * `html` is a tagged template literal that HTML-escapes every interpolated
 * value by default. To inject pre-rendered HTML (typically the output of
 * another `html\`\`` call), use the marker objects it returns directly —
 * they pass through unescaped.
 *
 * Why not use a templating library: this dashboard is small, server-side,
 * no client framework. A tagged template + a stable CSS rules block is
 * enough and has zero install / upgrade surface.
 */

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
  // Defensive fallback: never let an arbitrary object stringify to
  // '[object Object]' inside HTML. JSON-stringify and escape instead.
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

/* ─────────────────────────────────────────────────────────────────────── */

const STYLE = `
  :root {
    color-scheme: light dark;
    --fg: #1c1f23;
    --muted: #6b7280;
    --bg: #fafaf9;
    --card: #ffffff;
    --border: #e5e7eb;
    --accent: #2563eb;
    --warn: #c2410c;
    --danger: #b91c1c;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --fg: #e5e7eb;
      --muted: #9ca3af;
      --bg: #0c0e12;
      --card: #15181d;
      --border: #2a2f37;
    }
  }
  * { box-sizing: border-box; }
  body {
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    color: var(--fg);
    background: var(--bg);
    margin: 0;
    line-height: 1.5;
  }
  header {
    background: var(--card);
    border-bottom: 1px solid var(--border);
    padding: .75rem 1.25rem;
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }
  header .brand { font-weight: 700; font-size: 1.05rem; }
  header nav { display: flex; gap: 1rem; flex: 1; }
  header nav a { color: var(--muted); text-decoration: none; padding: .25rem 0; }
  header nav a.active, header nav a:hover { color: var(--fg); }
  main { max-width: 1100px; margin: 1.25rem auto; padding: 0 1.25rem; }
  h1 { margin: .25rem 0 1rem 0; font-size: 1.4rem; }
  h2 { margin-top: 2rem; font-size: 1.1rem; }
  table { width: 100%; border-collapse: collapse; background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  th, td { text-align: left; padding: .55rem .8rem; border-bottom: 1px solid var(--border); font-size: .92rem; vertical-align: top; }
  tr:last-child td { border-bottom: 0; }
  th { background: var(--bg); font-weight: 600; color: var(--muted); font-size: .8rem; text-transform: uppercase; letter-spacing: .03em; }
  td.mono, code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .82rem; }
  td.muted, .muted { color: var(--muted); }
  td.right, th.right { text-align: right; }
  form.inline { display: inline; }
  input, select, button, textarea {
    font: inherit;
    color: inherit;
    background: var(--card);
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: .4rem .65rem;
  }
  input[type=text], input[type=password], input[type=search], select { min-width: 12ch; }
  button {
    cursor: pointer;
    background: var(--card);
  }
  button.primary { background: var(--accent); color: white; border-color: var(--accent); }
  button.danger  { background: var(--danger); color: white; border-color: var(--danger); }
  button.warn    { background: var(--warn);   color: white; border-color: var(--warn); }
  button.subtle  { color: var(--muted); }
  .filters { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; margin: .5rem 0 1rem; }
  .pager { display: flex; justify-content: space-between; align-items: center; margin-top: 1rem; }
  .pill { display: inline-block; padding: .1rem .55rem; border-radius: 999px; font-size: .75rem; border: 1px solid var(--border); }
  .pill.active     { color: #166534; background: #dcfce7; border-color: #bbf7d0; }
  .pill.archived   { color: #6b7280; background: #f3f4f6; border-color: #e5e7eb; }
  .pill.superseded { color: #92400e; background: #fef3c7; border-color: #fde68a; }
  .pill.global     { color: #1e3a8a; background: #dbeafe; border-color: #bfdbfe; }
  .pill.project    { color: #5b21b6; background: #ede9fe; border-color: #ddd6fe; }
  .pill.scope-star { color: #b91c1c; background: #fee2e2; border-color: #fecaca; }
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: .75rem; margin-bottom: 1rem; }
  .stat-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: .8rem 1rem; }
  .stat-card .label { color: var(--muted); font-size: .75rem; text-transform: uppercase; letter-spacing: .03em; }
  .stat-card .value { font-size: 1.4rem; font-weight: 600; margin-top: .25rem; }
  .flash { padding: .75rem 1rem; border-radius: 6px; margin-bottom: 1rem; border: 1px solid var(--border); }
  .flash.error { color: #b91c1c; background: #fef2f2; border-color: #fecaca; }
  .flash.success { color: #166534; background: #dcfce7; border-color: #bbf7d0; }
  details { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: .5rem 1rem; margin-bottom: .75rem; }
  details summary { cursor: pointer; font-weight: 500; }
  pre { background: var(--bg); border: 1px solid var(--border); padding: .75rem; border-radius: 6px; overflow: auto; font-size: .82rem; }
  form.stack { display: grid; gap: .65rem; max-width: 480px; }
  label { display: grid; gap: .25rem; font-size: .9rem; }
  .small { font-size: .82rem; color: var(--muted); }
  .one-shot { border: 1px dashed var(--warn); padding: 1rem; border-radius: 6px; background: #fff7ed; color: #7c2d12; word-break: break-all; }
  @media (prefers-color-scheme: dark) {
    .one-shot { background: #1f1408; color: #fed7aa; }
    .pill.active { color: #bbf7d0; background: #052e16; border-color: #14532d; }
    .pill.archived { color: #d1d5db; background: #1f2937; border-color: #374151; }
    .pill.superseded { color: #fde68a; background: #451a03; border-color: #78350f; }
    .pill.global { color: #bfdbfe; background: #0c1a3a; border-color: #1e3a8a; }
    .pill.project { color: #ddd6fe; background: #1e1245; border-color: #4c1d95; }
    .pill.scope-star { color: #fecaca; background: #3a0d0d; border-color: #7f1d1d; }
    .flash.error { background: #2a0a0a; color: #fecaca; }
    .flash.success { background: #052e16; color: #bbf7d0; }
    .one-shot { background: #1f1408; color: #fed7aa; }
  }
`;

export interface ShellOptions {
  title: string;
  activeNav?:
    | 'home'
    | 'memories'
    | 'sessions'
    | 'relations'
    | 'consolidation'
    | 'projects'
    | 'tokens';
  flash?: { kind: 'error' | 'success'; text: string };
}

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

const NAV = [
  { key: 'home', label: 'Home', href: '/dashboard' },
  { key: 'memories', label: 'Memories', href: '/dashboard/memories' },
  { key: 'sessions', label: 'Sessions', href: '/dashboard/sessions' },
  { key: 'relations', label: 'Relations', href: '/dashboard/relations' },
  { key: 'consolidation', label: 'Consolidation', href: '/dashboard/consolidation' },
  { key: 'projects', label: 'Projects', href: '/dashboard/projects' },
  { key: 'tokens', label: 'Tokens', href: '/dashboard/tokens' },
] as const;

export function shell(body: SafeHtml, opts: ShellOptions): string {
  const nav = NAV.map(
    (n) =>
      `<a href="${n.href}" class="${opts.activeNav === n.key ? 'active' : ''}">${escape(n.label)}</a>`,
  ).join('');
  const flash = opts.flash
    ? `<div class="flash ${opts.flash.kind === 'error' ? 'error' : 'success'}">${escape(opts.flash.text)}</div>`
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escape(opts.title)} · Rembric</title>
  <style>${STYLE}</style>
  <script>${TS_UPGRADER}</script>
</head>
<body>
  <header>
    <span class="brand">Rembric</span>
    <nav>${nav}</nav>
    <form action="/dashboard/logout" method="post" class="inline">
      <button type="submit" class="subtle">Logout</button>
    </form>
  </header>
  <main>
    ${flash}
    ${body.__html}
  </main>
</body>
</html>`;
}

export function statusPill(status: string): SafeHtml {
  return raw(`<span class="pill ${escape(status)}">${escape(status)}</span>`);
}

export function scopePill(scope: string): SafeHtml {
  return raw(`<span class="pill ${escape(scope)}">${escape(scope)}</span>`);
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
