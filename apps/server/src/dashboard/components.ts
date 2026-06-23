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

import MarkdownIt from 'markdown-it';

import { REMBRIC_VERSION } from '../version.js';

import { escape, html, raw, type SafeHtml } from './templates.js';

// `html: false` renders any raw HTML in the source as escaped text (no separate
// sanitizer needed); markdown-it's default validateLink drops javascript:/data:
// schemes. This is the ONLY place dashboard text content reaches raw().
const md = new MarkdownIt({ html: false, linkify: false });

export function renderMarkdown(content: string): SafeHtml {
  return raw(md.render(content));
}

/* ── icons (sidebar) ───────────────────────────────────────────────── */

const SVG_OPEN =
  '<svg width="18" height="18" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">';
const SVG_CLOSE = '</svg>';

export const NAV_ICONS = Object.freeze({
  overview: `${SVG_OPEN}<rect x="1" y="1" width="6" height="6"/><rect x="9" y="1" width="6" height="6"/><rect x="1" y="9" width="6" height="6"/><rect x="9" y="9" width="6" height="6"/>${SVG_CLOSE}`,
  memories: `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2.5C6 1.5 3.5 2 3 4C1.5 4 1 6 2.5 7C1 8 1.5 10.5 3 10.5C2.5 13 5 14 7 13L8 13"/><path d="M8 2.5C10 1.5 12.5 2 13 4C14.5 4 15 6 13.5 7C15 8 14.5 10.5 13 10.5C13.5 13 11 14 9 13L8 13"/><line x1="8" y1="2.5" x2="8" y2="13"/><path d="M5 5.8C6.2 6.4 5 7.6 6.2 8.2"/><path d="M5 9.2C6.2 9.8 5 11 6.2 11.6"/><path d="M11 5.8C9.8 6.4 11 7.6 9.8 8.2"/><path d="M11 9.2C9.8 9.8 11 11 9.8 11.6"/></svg>`,
  sessions: `${SVG_OPEN}<rect x="6" y="1" width="9" height="6" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="1" y="6" width="10" height="7"/><rect x="2" y="13" width="2" height="2"/>${SVG_CLOSE}`,
  prompts: `<svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 3 C3 3 3 6 5 6"/><path d="M5 6 C3 6 3 9 5 9"/><path d="M11 3 C13 3 13 6 11 6"/><path d="M11 6 C13 6 13 9 11 9"/><path d="M2 12.5 L4 14.5 L8 11"/></svg>`,
  judgments: `${SVG_OPEN}<rect x="6.5" y="1" width="3" height="1"/><rect x="7.4" y="2" width="1.2" height="10"/><rect x="1" y="4" width="14" height="1"/><rect x="3.4" y="5" width="1.2" height="2"/><rect x="1" y="7" width="6" height="1.2"/><rect x="11.4" y="5" width="1.2" height="2"/><rect x="9" y="7" width="6" height="1.2"/><rect x="3" y="12" width="10" height="1.4"/>${SVG_CLOSE}`,
  consolidation: `${SVG_OPEN}<polygon points="1,1 3,1 9,7 9,9 7,9 1,3"/><polygon points="13,1 15,1 15,3 9,9 7,9 7,7"/><rect x="7" y="9" width="2" height="4"/><polygon points="5,13 11,13 8,16"/>${SVG_CLOSE}`,
  projects: `${SVG_OPEN}<rect x="1" y="2.5" width="6" height="2.5"/><rect x="1" y="5" width="14" height="9" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="3.5" y="9" width="9" height="1"/>${SVG_CLOSE}`,
  tokens: `${SVG_OPEN}<rect x="1" y="5" width="6" height="6" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="3" y="7" width="2" height="2"/><rect x="7" y="7" width="8" height="2"/><rect x="11" y="9" width="1.5" height="2"/><rect x="13.5" y="9" width="1.5" height="2"/>${SVG_CLOSE}`,
  maintenance: `${SVG_OPEN}<rect x="1" y="7" width="9" height="2"/><rect x="8" y="3.5" width="6.5" height="2"/><rect x="8" y="5.5" width="2.5" height="5"/><rect x="8" y="10.5" width="6.5" height="2"/>${SVG_CLOSE}`,
} as const);

/* ── nav model ─────────────────────────────────────────────────────── */

export type NavKey =
  | 'home'
  | 'memories'
  | 'sessions'
  | 'prompts'
  | 'judgments'
  | 'consolidation'
  | 'projects'
  | 'tokens'
  | 'maintenance';

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
    key: 'prompts',
    num: '03b',
    iconKey: 'prompts',
    label: 'PROMPTS',
    href: '/dashboard/prompts',
    group: 'MAIN',
  },
  {
    key: 'judgments',
    num: '04',
    iconKey: 'judgments',
    label: 'JUDGMENTS',
    href: '/dashboard/judgments',
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
  {
    key: 'maintenance',
    num: '08',
    iconKey: 'maintenance',
    label: 'MAINTENANCE',
    href: '/dashboard/maintenance',
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
  /** Pre-rendered update badge (see `update-modal.ts::updateBadge`). */
  update?: SafeHtml | null;
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
        <img class="brand-logo" src="/dashboard/assets/logo-transparent.png" alt="" />
        <div class="label-stack">
          <div>REMBRIC</div>
          <small>v${REMBRIC_VERSION}</small>
        </div>
      </a>
      ${opts.update ?? raw('')} ${sections}
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

export function renderMobileBar(_active: NavKey | null, update?: SafeHtml | null): SafeHtml {
  return html`
    <div class="mob-bar">
      <a class="brand" href="/dashboard">
        <img class="brand-logo" src="/dashboard/assets/logo-transparent.png" alt="" />
        <div class="label-stack">
          <div>REMBRIC</div>
          <small>v${REMBRIC_VERSION}</small>
        </div>
      </a>
      ${update ?? raw('')}
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
