/**
 * Dashboard SSR component helpers.
 *
 * Each function returns `SafeHtml` (the `templates.ts` escape-aware
 * marker) and is composable inside ``html`...`` tagged template literals.
 * No client framework, no JSX — plain string assembly with strict escape
 * boundaries at every interpolation point.
 *
 * The visual identity (palette, type, spacing) is locked in
 * `styles/core/tokens.css`. These helpers only emit class names; never
 * inline styles unless a one-off content-driven value (e.g. a width %)
 * demands it.
 */

import { escape, html, raw, type SafeHtml } from './templates.js';

/* ── icons (sidebar) ───────────────────────────────────────────────── */

const SVG_OPEN =
  '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">';
const SVG_CLOSE = '</svg>';

export const NAV_ICONS = Object.freeze({
  overview: `${SVG_OPEN}<rect x="1" y="1" width="6" height="6"/><rect x="9" y="1" width="6" height="6"/><rect x="1" y="9" width="6" height="6"/><rect x="9" y="9" width="6" height="6"/>${SVG_CLOSE}`,
  memories: `${SVG_OPEN}<rect x="2" y="2" width="12" height="12"/>${SVG_CLOSE}`,
  sessions: `${SVG_OPEN}<rect x="1" y="3" width="14" height="1.6"/><rect x="1" y="7.2" width="10" height="1.6"/><rect x="1" y="11.4" width="12" height="1.6"/>${SVG_CLOSE}`,
  relations: `${SVG_OPEN}<rect x="0" y="4" width="5" height="8"/><rect x="11" y="4" width="5" height="8"/><rect x="5" y="7.2" width="6" height="1.6"/>${SVG_CLOSE}`,
  consolidation: `${SVG_OPEN}<rect x="1" y="1" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="3.5" y="4" width="9" height="1.2"/><rect x="3.5" y="7.4" width="9" height="1.2"/><rect x="3.5" y="10.8" width="9" height="1.2"/>${SVG_CLOSE}`,
  projects: `${SVG_OPEN}<rect x="1" y="1" width="6" height="6"/><rect x="9" y="1" width="6" height="6"/><rect x="1" y="9" width="6" height="6"/><rect x="9" y="9" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.5"/>${SVG_CLOSE}`,
  tokens: `${SVG_OPEN}<rect x="0" y="7" width="7" height="2"/><rect x="8" y="4" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.5"/><rect x="11" y="7" width="2" height="2"/>${SVG_CLOSE}`,
} as const);

/* ── nav model ─────────────────────────────────────────────────────── */

export type NavKey =
  | 'home'
  | 'memories'
  | 'sessions'
  | 'relations'
  | 'consolidation'
  | 'projects'
  | 'tokens';

export interface NavEntry {
  key: NavKey;
  num: string;
  iconKey: keyof typeof NAV_ICONS;
  label: string;
  href: string;
  group: 'MAIN' | 'ADMIN';
  badgeKey?: 'pendingJudgments';
}

export const NAV: readonly NavEntry[] = Object.freeze([
  {
    key: 'home',
    num: '01',
    iconKey: 'overview',
    label: 'OVERVIEW',
    href: '/dashboard',
    group: 'MAIN',
  },
  {
    key: 'memories',
    num: '02',
    iconKey: 'memories',
    label: 'MEMORIES',
    href: '/dashboard/memories',
    group: 'MAIN',
  },
  {
    key: 'sessions',
    num: '03',
    iconKey: 'sessions',
    label: 'SESSIONS',
    href: '/dashboard/sessions',
    group: 'MAIN',
  },
  {
    key: 'relations',
    num: '04',
    iconKey: 'relations',
    label: 'JUDGMENTS',
    href: '/dashboard/relations',
    group: 'MAIN',
    badgeKey: 'pendingJudgments',
  },
  {
    key: 'consolidation',
    num: '05',
    iconKey: 'consolidation',
    label: 'CONSOLIDATION',
    href: '/dashboard/consolidation',
    group: 'MAIN',
  },
  {
    key: 'projects',
    num: '06',
    iconKey: 'projects',
    label: 'PROJECTS',
    href: '/dashboard/projects',
    group: 'ADMIN',
  },
  {
    key: 'tokens',
    num: '07',
    iconKey: 'tokens',
    label: 'TOKENS',
    href: '/dashboard/tokens',
    group: 'ADMIN',
  },
]);

export function navEntry(key: NavKey): NavEntry {
  const entry = NAV.find((n) => n.key === key);
  if (!entry) throw new Error(`unknown nav key: ${key}`);
  return entry;
}

/* ── sidebar + mobile bar ──────────────────────────────────────────── */

export interface SidebarOpts {
  active: NavKey | null;
  counters: { pendingJudgments?: number };
  collapsed: boolean;
  csrf: SafeHtml;
}

export function renderSidebar(opts: SidebarOpts): SafeHtml {
  const groups: Array<'MAIN' | 'ADMIN'> = ['MAIN', 'ADMIN'];
  const sections = groups.map((g) => {
    const items = NAV.filter((n) => n.group === g).map((n) => {
      const isActive = opts.active === n.key;
      const badgeCount = n.badgeKey ? (opts.counters[n.badgeKey] ?? 0) : 0;
      return html`
        <a
          class="sb-item${isActive ? ' is-active' : ''}"
          href="${n.href}"
          title="§ ${n.num} · ${n.label}"
        >
          <span class="icon" aria-hidden="true">${raw(NAV_ICONS[n.iconKey])}</span>
          <span class="label">${n.label}</span>
          ${badgeCount > 0 ? html`<span class="badge">${badgeCount}</span>` : raw('')}
        </a>
      `;
    });
    return html`
      <div>
        <div class="sb-section">${g}</div>
        <nav class="sb-nav">${items}</nav>
      </div>
    `;
  });

  return html`
    <aside class="sb${opts.collapsed ? ' is-collapsed' : ''}">
      <button type="button" class="sb-mob-close" aria-label="Close menu">✕</button>
      <a class="sb-brand" href="/dashboard" title="REMBRIC · Go to overview">
        <span class="bullet"></span>
        <div class="label-stack">
          <div>REMBRIC</div>
          <small>SELF-HOSTED</small>
        </div>
      </a>
      ${sections}
      <div class="sb-foot">
        <div class="sb-foot-text">
          <form action="/dashboard/logout" method="post" style="margin:0">
            <button type="submit" class="linklike">→ LOGOUT</button>
          </form>
        </div>
        <form action="/dashboard/_sidebar/toggle" method="post" style="margin:0">
          ${opts.csrf}
          <button
            type="submit"
            class="sb-collapse"
            title="${opts.collapsed ? 'EXPAND SIDEBAR' : 'COLLAPSE SIDEBAR'}"
            aria-label="${opts.collapsed ? 'Expand sidebar' : 'Collapse sidebar'}"
          >
            <span class="glyph">${opts.collapsed ? '››' : '‹‹'}</span>
            <span class="label">${opts.collapsed ? 'EXPAND' : 'COLLAPSE'}</span>
          </button>
        </form>
      </div>
    </aside>
  `;
}

export function renderMobileBar(_active: NavKey | null): SafeHtml {
  return html`
    <div class="mob-bar">
      <a class="brand" href="/dashboard">
        <span class="bullet"></span>
        <div class="label-stack">
          <div>REMBRIC</div>
          <small>SELF-HOSTED</small>
        </div>
      </a>
      <a class="mob-toggle" href="#sidebar" aria-expanded="false">☰ MENU</a>
    </div>
  `;
}

/* ── view head ─────────────────────────────────────────────────────── */

export interface ViewHeadOpts {
  num: string;
  title: string;
  hl?: string;
  meta?: Array<{ k: string; v: string }>;
}

export function viewHead(opts: ViewHeadOpts): SafeHtml {
  const titleHtml =
    opts.hl && opts.title.includes(opts.hl)
      ? raw(
          escape(opts.title).replace(escape(opts.hl), `<span class="hl">${escape(opts.hl)}</span>`),
        )
      : html`${opts.title}`;
  const meta = (opts.meta ?? []).map((m) => html`<span><b>${m.k}</b> ${m.v}</span>`);
  const metaBlock = meta.length > 0 ? html`<div class="meta">${meta}</div>` : raw('');
  return html`
    <header class="view-head">
      <div class="lead">
        <h1>${titleHtml}</h1>
      </div>
      ${metaBlock}
    </header>
  `;
}

/**
 * Back link rendered as the first element of the page content, immediately
 * after `viewHead()`. Sub-pages (detail views) drop one in to give the
 * operator a one-click way back to the parent list.
 */
export function backLink(opts: { href: string; label: string }): SafeHtml {
  return html` <a class="view-back" href="${opts.href}">← ${opts.label}</a> `;
}

/* ── stat card ─────────────────────────────────────────────────────── */

export interface StatCardOpts {
  k: string;
  v: number | string | SafeHtml;
  tone?: 'fg' | 'lime' | 'warn' | 'danger' | 'dim';
  sub?: SafeHtml | string;
  href?: string;
}

export function statCard(opts: StatCardOpts): SafeHtml {
  const tone = opts.tone ?? 'fg';
  const toneClass = tone === 'fg' ? '' : ` ${tone}`;
  const bulletTone =
    tone === 'fg'
      ? ''
      : tone === 'lime'
        ? ''
        : tone === 'warn'
          ? 'warn'
          : tone === 'danger'
            ? 'danger'
            : 'dim';
  const inner = html`
    <div class="stat-k">
      <span class="bn ${bulletTone}"></span>
      ${opts.k}
    </div>
    <div class="stat-v${toneClass}">${opts.v}</div>
    ${opts.sub ? html`<div class="stat-n">${opts.sub}</div>` : raw('')}
  `;
  return opts.href
    ? html`<a class="stat" href="${opts.href}">${inner}</a>`
    : html`<div class="stat">${inner}</div>`;
}

/* ── kv (smaller stat used in detail pages) ────────────────────────── */

export interface KvOpts {
  k: string;
  v: SafeHtml | string | number;
  tone?: 'fg' | 'lime' | 'warn' | 'danger' | 'dim';
  mono?: boolean;
}

export function kv(opts: KvOpts): SafeHtml {
  const tone = opts.tone ?? 'fg';
  const toneClass = tone === 'fg' ? '' : tone;
  const monoClass = opts.mono ? ' mono' : '';
  const bulletTone =
    tone === 'fg'
      ? ''
      : tone === 'lime'
        ? ''
        : tone === 'warn'
          ? 'warn'
          : tone === 'danger'
            ? 'danger'
            : 'dim';
  return html`
    <div class="kv">
      <div class="k">
        <span class="bn ${bulletTone}"></span>
        ${opts.k}
      </div>
      <div class="v ${toneClass}${monoClass}">${opts.v}</div>
    </div>
  `;
}

export function kvGrid(items: SafeHtml[]): SafeHtml {
  return html`<div class="kv-grid">${items}</div>`;
}

/* ── section bar ───────────────────────────────────────────────────── */

export interface SectionBarOpts {
  name: string;
  meta?: SafeHtml | string;
  more?: SafeHtml | string;
}

export function sectionBar(opts: SectionBarOpts): SafeHtml {
  return html`
    <div class="section-bar">
      <span class="bn"></span>
      <span class="name">${opts.name}</span>
      ${opts.meta ? html`<span>${opts.meta}</span>` : raw('')}
      ${opts.more ? html`<span class="more">${opts.more}</span>` : raw('')}
    </div>
  `;
}

/* ── buttons + link-buttons ────────────────────────────────────────── */

export type BtnVariant = 'primary' | 'secondary' | 'warn' | 'danger';

export interface BtnOpts {
  variant?: BtnVariant;
  size?: 'sm';
  label: string;
  href?: string;
  type?: 'submit' | 'button';
  disabled?: boolean;
}

export function btn(opts: BtnOpts): SafeHtml {
  const variant = opts.variant ?? 'secondary';
  const sizeClass = opts.size === 'sm' ? ' sm' : '';
  const cls = `btn ${variant}${sizeClass}`;
  if (opts.href) {
    return html`<a class="${cls}" href="${opts.href}">${opts.label}</a>`;
  }
  return html`<button
    class="${cls}"
    type="${opts.type ?? 'submit'}"
    ${opts.disabled ? ' disabled' : ''}
  >
    ${opts.label}
  </button>`;
}

/* ── flash ─────────────────────────────────────────────────────────── */

export type FlashTone = 'lime' | 'warn' | 'danger' | 'success' | 'error';

export function flash(opts: { tone: FlashTone; label: string; body: SafeHtml | string }): SafeHtml {
  return html`
    <div class="flash ${opts.tone}">
      <span class="lab">${opts.label}</span>
      <span>${opts.body}</span>
    </div>
  `;
}

/* ── filters bar ───────────────────────────────────────────────────── */

export interface SelOption {
  value: string;
  label: string;
  selected?: boolean;
}

export function sel(name: string, options: SelOption[], opts?: { grow?: boolean }): SafeHtml {
  const inner = options.map((o) =>
    raw(
      `<option value="${escape(o.value)}"${o.selected ? ' selected' : ''}>${escape(o.label)}</option>`,
    ),
  );
  return html`<select name="${name}" class="sel${opts?.grow ? ' grow' : ''}">
    ${inner}
  </select>`;
}

export function inp(
  name: string,
  value: string,
  placeholder: string,
  opts?: { type?: string; grow?: boolean; autofocus?: boolean; size?: 'lg' },
): SafeHtml {
  const cls = `inp${opts?.size === 'lg' ? ' lg' : ''}${opts?.grow ? ' grow' : ''}`;
  return raw(
    `<input class="${cls}" type="${escape(opts?.type ?? 'text')}" name="${escape(name)}" value="${escape(value)}" placeholder="${escape(placeholder)}"${opts?.autofocus ? ' autofocus' : ''}>`,
  );
}

export function filtersBar(children: SafeHtml[]): SafeHtml {
  return html`<form class="filters" method="get">${children}</form>`;
}

/* ── pager ─────────────────────────────────────────────────────────── */

export interface PagerOpts {
  page: number;
  hasMore: boolean;
  pageHrefBuilder: (page: number) => string;
  totalLabel?: string;
}

export function pager(opts: PagerOpts): SafeHtml {
  return html`
    <div class="pager">
      <span>PAGE ${opts.page + 1}${opts.totalLabel ? ` · ${opts.totalLabel}` : ''}</span>
      <span class="pages">
        ${opts.page > 0
          ? html`<a href="${opts.pageHrefBuilder(opts.page - 1)}">‹ PREV</a>`
          : raw('')}
        ${opts.hasMore
          ? html`<a href="${opts.pageHrefBuilder(opts.page + 1)}">NEXT ›</a>`
          : raw('')}
      </span>
    </div>
  `;
}

/** Standard page size for all paginated dashboard listings. */
export const PAGE_SIZE = 10;

/**
 * Build a URL that preserves every search param of `currentUrl` except
 * `page`, which is replaced with the given index. Use it to make
 * `pager()` round-trip the active filters.
 */
export function urlWithPage(currentUrl: string, page: number): string {
  const u = new URL(currentUrl);
  if (page <= 0) u.searchParams.delete('page');
  else u.searchParams.set('page', String(page));
  return u.pathname + (u.search ? u.search : '');
}

/* ── sparkline (inline SVG) ───────────────────────────────────────── */

export function sparkline(data: number[]): SafeHtml {
  if (!data.length) return raw('<span class="spark">·</span>');
  const w = 64;
  const h = 16;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? w / (data.length - 1) : 0;
  const pts = data
    .map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)
    .join(' ');
  return raw(
    `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" aria-hidden="true"><polyline fill="none" stroke="currentColor" stroke-width="1.5" points="${pts}"/></svg>`,
  );
}

/* ── table empty state ─────────────────────────────────────────────── */

export function tblEmpty(message: string): SafeHtml {
  return html`<div class="tbl-empty">${message}</div>`;
}
