import { describe, expect, it } from 'vitest';

import {
  backLink,
  btn,
  flash,
  inp,
  kv,
  kvGrid,
  NAV,
  navEntry,
  pager,
  PAGE_SIZE,
  renderMobileBar,
  renderSidebar,
  sectionBar,
  sel,
  sparkline,
  statCard,
  tblEmpty,
  urlWithPage,
  viewHead,
} from './components.js';
import { raw } from './templates.js';

describe('PAGE_SIZE', () => {
  it('is the standard 10 across all paginated listings', () => {
    expect(PAGE_SIZE).toBe(10);
  });
});

describe('urlWithPage', () => {
  it('replaces page param while preserving other filters', () => {
    expect(urlWithPage('http://x/dashboard/memories?status=active&type=feedback', 3)).toBe(
      '/dashboard/memories?status=active&type=feedback&page=3',
    );
  });

  it('drops the page param when navigating to page 0', () => {
    expect(urlWithPage('http://x/dashboard/memories?status=active&page=5', 0)).toBe(
      '/dashboard/memories?status=active',
    );
  });
});

describe('viewHead', () => {
  it('wraps the hl word in a lime block highlight', () => {
    const out = viewHead({ num: '02', title: 'Rembric Memories.', hl: 'Rembric' });
    expect(out.__html).toContain('<span class="hl">Rembric</span>');
    expect(out.__html).toContain('Memories.');
  });

  it('renders meta entries with <b>K</b> V', () => {
    const out = viewHead({
      num: '01',
      title: 'Rembric Overview.',
      hl: 'Rembric',
      meta: [
        { k: 'TOTAL', v: '12' },
        { k: 'AS OF', v: 'now' },
      ],
    });
    expect(out.__html).toContain('<b>TOTAL</b> 12');
    expect(out.__html).toContain('<b>AS OF</b> now');
  });

  it('omits the meta block when no entries provided', () => {
    const out = viewHead({ num: '02', title: 'Rembric Memories.', hl: 'Rembric' });
    expect(out.__html).not.toContain('class="meta"');
  });
});

describe('backLink', () => {
  it('renders a `.view-back` anchor with arrow + label', () => {
    const out = backLink({ href: '/dashboard/memories', label: 'BACK TO MEMORIES' });
    expect(out.__html).toContain('class="view-back"');
    expect(out.__html).toContain('href="/dashboard/memories"');
    expect(out.__html).toContain('← BACK TO MEMORIES');
  });
});

describe('statCard', () => {
  it('renders an anchor when href is provided', () => {
    const out = statCard({ k: 'TOTAL', v: 12, href: '/dashboard/memories' });
    expect(out.__html).toContain('<a class="stat" href="/dashboard/memories">');
    expect(out.__html).toContain('TOTAL');
    expect(out.__html).toContain('12');
  });

  it('renders a static div when no href is provided', () => {
    const out = statCard({ k: 'ACTIVE', v: 9 });
    expect(out.__html).toContain('<div class="stat">');
    expect(out.__html).not.toContain('<a class="stat"');
  });

  it('applies tone class to the value', () => {
    const out = statCard({ k: 'ARCHIVED', v: 1, tone: 'warn' });
    expect(out.__html).toContain('class="stat-v warn"');
  });
});

describe('btn', () => {
  it('renders a button by default with tone class', () => {
    const out = btn({ variant: 'primary', label: 'FILTER' });
    expect(out.__html).toContain('class="btn primary"');
    expect(out.__html).toContain('type="submit"');
    expect(out.__html).toContain('FILTER');
  });

  it('renders an anchor when href is provided', () => {
    const out = btn({ variant: 'secondary', label: 'CANCEL', href: '/dashboard' });
    expect(out.__html).toContain('<a class="btn secondary" href="/dashboard">');
  });

  it('honors size=sm', () => {
    const out = btn({ variant: 'warn', size: 'sm', label: 'ARCHIVE' });
    expect(out.__html).toContain('class="btn warn sm"');
  });
});

describe('flash', () => {
  it('emits a flash banner with tone + label + body', () => {
    const out = flash({ tone: 'danger', label: 'ERROR', body: 'something broke' });
    expect(out.__html).toContain('class="flash danger"');
    expect(out.__html).toContain('<span class="lab">ERROR</span>');
    expect(out.__html).toContain('something broke');
  });
});

describe('sectionBar', () => {
  it('renders name + optional meta + optional more', () => {
    const out = sectionBar({ name: 'OPERATIONS', meta: 'QUICK ACTIONS', more: raw('open ›') });
    expect(out.__html).toContain('<span class="name">OPERATIONS</span>');
    expect(out.__html).toContain('QUICK ACTIONS');
    expect(out.__html).toContain('<span class="more">open ›</span>');
  });
});

describe('pager', () => {
  it('shows PREV only when page > 0', () => {
    const a = pager({ page: 0, hasMore: true, pageHrefBuilder: (p) => `?page=${p}` });
    expect(a.__html).not.toContain('PREV');
    expect(a.__html).toContain('NEXT ›');

    const b = pager({ page: 2, hasMore: true, pageHrefBuilder: (p) => `?page=${p}` });
    expect(b.__html).toContain('‹ PREV');
    expect(b.__html).toContain('NEXT ›');
    expect(b.__html).toContain('href="?page=1"');
    expect(b.__html).toContain('href="?page=3"');
  });

  it('renders the totalLabel inline with the page index', () => {
    const out = pager({
      page: 0,
      hasMore: false,
      pageHrefBuilder: () => '#',
      totalLabel: '10 ROWS',
    });
    expect(out.__html).toContain('PAGE 1 · 10 ROWS');
  });
});

describe('kv + kvGrid', () => {
  it('kv renders a tone-coloured value + lime bullet', () => {
    const out = kv({ k: 'STATUS', v: 'ACTIVE', tone: 'lime' });
    expect(out.__html).toContain('<div class="kv">');
    expect(out.__html).toContain('STATUS');
    expect(out.__html).toContain('class="v lime"');
  });

  it('kvGrid wraps the items in .kv-grid', () => {
    const out = kvGrid([kv({ k: 'A', v: 1 }), kv({ k: 'B', v: 2 })]);
    expect(out.__html).toContain('<div class="kv-grid">');
  });
});

describe('sel + inp', () => {
  it('sel marks the selected option', () => {
    const out = sel('status', [
      { value: 'active', label: 'active', selected: true },
      { value: 'archived', label: 'archived' },
    ]);
    expect(out.__html).toContain('<option value="active" selected>active</option>');
    expect(out.__html).toContain('<option value="archived">archived</option>');
  });

  it('inp emits an input with placeholder + value', () => {
    const out = inp('q', 'foo', 'search');
    expect(out.__html).toContain('name="q"');
    expect(out.__html).toContain('value="foo"');
    expect(out.__html).toContain('placeholder="search"');
  });

  it('inp html-escapes user-controlled value', () => {
    const out = inp('q', '<script>alert(1)</script>', 'search');
    expect(out.__html).not.toContain('<script>');
    expect(out.__html).toContain('&lt;script&gt;');
  });
});

describe('sparkline', () => {
  it('renders inline SVG with a polyline of N points for N data points', () => {
    const out = sparkline([0, 1, 2, 3]);
    expect(out.__html).toContain('<svg');
    expect(out.__html).toContain('<polyline');
    // 4 points = 4 space-separated coordinate pairs.
    const points = out.__html.match(/points="([^"]+)"/)?.[1] ?? '';
    expect(points.split(/\s+/)).toHaveLength(4);
  });

  it('handles empty data without crashing', () => {
    expect(sparkline([]).__html).toContain('class="spark"');
  });
});

describe('tblEmpty', () => {
  it('renders the empty-state message', () => {
    expect(tblEmpty('NO ROWS').__html).toContain('class="tbl-empty">NO ROWS<');
  });
});

describe('NAV', () => {
  it('exposes 7 entries in MAIN + ADMIN groups', () => {
    expect(NAV).toHaveLength(7);
    expect(NAV.filter((n) => n.group === 'MAIN')).toHaveLength(5);
    expect(NAV.filter((n) => n.group === 'ADMIN')).toHaveLength(2);
  });

  it('navEntry(key) returns the matching entry', () => {
    expect(navEntry('home').href).toBe('/dashboard');
    expect(navEntry('memories').num).toBe('02');
  });
});

describe('renderSidebar', () => {
  const csrf = raw('<input type="hidden" name="csrf" value="abc">');

  it('marks the active nav item with .is-active', () => {
    const out = renderSidebar({
      active: 'memories',
      counters: {},
      collapsed: false,
      csrf,
    });
    expect(out.__html).toMatch(/class="sb-item is-active"[\s\S]*?href="\/dashboard\/memories"/);
    expect(out.__html).toMatch(/class="sb-item"[\s\S]*?href="\/dashboard"/);
  });

  it('shows the pending-judgments badge when counter > 0', () => {
    const out = renderSidebar({
      active: 'home',
      counters: { pendingJudgments: 3 },
      collapsed: false,
      csrf,
    });
    expect(out.__html).toContain('<span class="badge">3</span>');
  });

  it('omits the badge when counter is 0', () => {
    const out = renderSidebar({
      active: 'home',
      counters: { pendingJudgments: 0 },
      collapsed: false,
      csrf,
    });
    expect(out.__html).not.toContain('class="badge"');
  });

  it('applies .is-collapsed and EXPAND label when collapsed', () => {
    const out = renderSidebar({
      active: 'home',
      counters: {},
      collapsed: true,
      csrf,
    });
    expect(out.__html).toContain('<aside class="sb is-collapsed">');
    expect(out.__html).toContain('EXPAND');
    expect(out.__html).toContain('››');
  });

  it('renders the brand as a link to /dashboard', () => {
    const out = renderSidebar({
      active: 'home',
      counters: {},
      collapsed: false,
      csrf,
    });
    expect(out.__html).toContain('<a class="sb-brand" href="/dashboard"');
  });

  it('renders the close button (visible only at ≤980 px via CSS)', () => {
    const out = renderSidebar({
      active: 'home',
      counters: {},
      collapsed: false,
      csrf,
    });
    expect(out.__html).toContain('class="sb-mob-close"');
  });
});

describe('renderMobileBar', () => {
  it('renders REMBRIC + SELF-HOSTED + the ☰ MENU toggle', () => {
    const out = renderMobileBar('home');
    expect(out.__html).toContain('REMBRIC');
    expect(out.__html).toContain('SELF-HOSTED');
    expect(out.__html).toContain('☰ MENU');
    expect(out.__html).toContain('class="mob-toggle"');
  });
});
