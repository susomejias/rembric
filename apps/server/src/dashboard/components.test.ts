import { Hono, type Context } from 'hono';
import { describe, expect, it } from 'vitest';

import { DomainError } from '../services/errors.js';
import type { SessionsService } from '../services/sessions.js';
import { REMBRIC_VERSION } from '../version.js';

import {
  backLink,
  btn,
  domainErrorPage,
  filterGroup,
  flash,
  flashErrorPage,
  getSession,
  inp,
  kv,
  kvGrid,
  NAV,
  navEntry,
  mdBody,
  pager,
  PAGE_SIZE,
  pageParam,
  projectOptions,
  renderMarkdown,
  renderMobileBar,
  renderSidebar,
  sectionBar,
  sel,
  sparkline,
  statCard,
  tblEmpty,
  truncate,
  urlWithPage,
  viewHead,
} from './components.js';
import { raw } from './templates.js';
import type { ResolvedSession } from './types.js';

describe('PAGE_SIZE', () => {
  it('is the standard 50 across all paginated listings', () => {
    expect(PAGE_SIZE).toBe(50);
  });
});

describe('pageParam', () => {
  const p = (q: string) => pageParam(new URL(`http://x/dashboard/memories${q}`));

  it('defaults to 0 and floors garbage to 0', () => {
    for (const q of ['', '?page=0', '?page=-5', '?page=abc', '?page=NaN', "?page=' OR 1=1 --"]) {
      expect(p(q)).toBe(0);
    }
  });

  it('reads a normal page index', () => {
    expect(p('?page=3')).toBe(3);
  });

  it('clamps so page * PAGE_SIZE stays a safe integer', () => {
    expect(Number.isSafeInteger(p('?page=99999999999999999999') * PAGE_SIZE)).toBe(true);
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

  it('drops the retired project sentinel instead of echoing it into the href', () => {
    expect(urlWithPage('http://x/dashboard/sessions?project=__global__&status=active', 1)).toBe(
      '/dashboard/sessions?status=active&page=1',
    );
    // Control: a real slug is preserved, so the rule is narrow.
    expect(urlWithPage('http://x/dashboard/sessions?project=demo', 1)).toBe(
      '/dashboard/sessions?project=demo&page=1',
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

  it('renders "PAGE X OF Y" when total is provided', () => {
    const out = pager({ page: 1, hasMore: true, pageHrefBuilder: () => '#', total: 123 });
    expect(out.__html).toContain('PAGE 2 OF 3');
  });

  it('shows "PAGE 1 OF 1" for a zero-row total', () => {
    const out = pager({ page: 0, hasMore: false, pageHrefBuilder: () => '#', total: 0 });
    expect(out.__html).toContain('PAGE 1 OF 1');
  });

  it('omits "OF Y" when total is not provided', () => {
    const out = pager({ page: 0, hasMore: false, pageHrefBuilder: () => '#' });
    expect(out.__html).not.toContain('OF');
  });

  it('combines "PAGE X OF Y" with totalLabel', () => {
    const out = pager({
      page: 0,
      hasMore: true,
      pageHrefBuilder: () => '#',
      total: 100,
      totalLabel: '50 ROWS',
    });
    expect(out.__html).toContain('PAGE 1 OF 2 · 50 ROWS');
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

describe('truncate', () => {
  it('leaves short strings untouched', () => {
    expect(truncate('short', 10)).toBe('short');
  });

  it('truncates with an ellipsis past max', () => {
    expect(truncate('a very long string indeed', 10)).toBe('a very lo…');
  });

  it('returns empty string for null/undefined', () => {
    expect(truncate(null, 10)).toBe('');
    expect(truncate(undefined, 10)).toBe('');
  });
});

describe('projectOptions', () => {
  it('leads with "all scopes" and then offers only projects', () => {
    const opts = projectOptions([{ slug: 'proj-a' }], '');
    expect(opts).toEqual([
      { value: '', label: 'all scopes', selected: true },
      { value: 'proj-a', label: 'proj-a', selected: false },
    ]);
  });

  it('offers no option for a scope that no longer exists', () => {
    const opts = projectOptions([{ slug: 'proj-a' }, { slug: 'default' }], '');
    expect(opts.map((o) => o.value)).not.toContain('__global__');
    expect(opts.map((o) => o.label)).not.toContain('global only');
  });

  it('marks the selected project slug', () => {
    const opts = projectOptions([{ slug: 'proj-a' }, { slug: 'proj-b' }], 'proj-b');
    expect(opts.find((o) => o.value === 'proj-b')?.selected).toBe(true);
    expect(opts.find((o) => o.value === 'proj-a')?.selected).toBe(false);
  });
});

describe('sel + id', () => {
  it('emits the id attribute when provided', () => {
    const out = sel('status', [{ value: 'active', label: 'active' }], { id: 'f-status' });
    expect(out.__html).toContain('id="f-status"');
  });

  it('omits the id attribute by default', () => {
    const out = sel('status', [{ value: 'active', label: 'active' }]);
    expect(out.__html).not.toContain(' id=');
  });
});

describe('inp + id', () => {
  it('emits the id attribute when provided', () => {
    const out = inp('q', '', 'search', { id: 'f-q' });
    expect(out.__html).toContain('id="f-q"');
  });
});

describe('filterGroup', () => {
  it('wraps the control in a labelled .group span with a for-bound label', () => {
    const out = filterGroup(
      'STATUS',
      'f-status',
      sel('status', [{ value: 'active', label: 'active' }], {
        id: 'f-status',
      }),
    );
    expect(out.__html).toContain('<span class="group">');
    expect(out.__html).toContain('<label class="k" for="f-status">STATUS</label>');
    expect(out.__html).toContain('id="f-status"');
  });

  it('appends an extra class when opts.className is given', () => {
    const out = filterGroup('SEARCH', 'f-q', inp('q', '', 'x', { id: 'f-q' }), {
      className: 'search',
    });
    expect(out.__html).toContain('<span class="group search">');
  });
});

describe('getSession', () => {
  it('returns the session set on the context', async () => {
    const app = new Hono();
    const fake = { tokenId: 'tk1' } as unknown as ResolvedSession;
    app.get('/', (c: Context) => {
      c.set('session' as never, fake as never);
      return c.json({ same: getSession(c) === fake });
    });
    const res = await app.request('/');
    expect(await res.json()).toEqual({ same: true });
  });

  it('returns null when no session is set', async () => {
    const app = new Hono();
    app.get('/', (c: Context) => c.json({ session: getSession(c) }));
    const res = await app.request('/');
    expect(await res.json()).toEqual({ session: null });
  });
});

describe('flashErrorPage + domainErrorPage', () => {
  async function withSessionApp(handler: (c: Context, sessions: SessionsService) => Response) {
    const { randomBytes } = await import('node:crypto');
    const { createRepositories } = await import('../db/repositories/index.js');
    const { SessionsService } = await import('../services/sessions.js');
    const { TokensService } = await import('../services/tokens.js');
    const { createTestDb } = await import('../test/db.js');

    const t = createTestDb();
    const repos = createRepositories(t.handle.db);
    const sessions = new SessionsService(repos, randomBytes(32));
    const tokens = new TokensService(repos, t.handle.db);
    const admin = tokens.create({ name: 'admin', scope: '*' });
    const created = sessions.create(admin.token.id);
    const resolved: ResolvedSession = {
      session: created.session,
      sessions,
      tokenId: admin.token.id,
    };

    const app = new Hono();
    app.use('*', (c: Context, next) => {
      c.set('session' as never, resolved as never);
      return next();
    });
    app.get('/', (c: Context) => handler(c, sessions));
    const res = await app.request('/');
    t.cleanup();
    return res;
  }

  it('flashErrorPage renders the flash-error markup at the given status (default 400)', async () => {
    const res = await withSessionApp((c, sessions) =>
      flashErrorPage(c, sessions, 'boom', { title: 'Widgets', activeNav: 'memories' }),
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('<p class="flash error">boom</p>');
  });

  it('flashErrorPage honors an explicit status override', async () => {
    const res = await withSessionApp((c, sessions) =>
      flashErrorPage(c, sessions, 'not here', { title: 'Widgets', activeNav: 'memories' }, 404),
    );
    expect(res.status).toBe(404);
  });

  it('domainErrorPage defaults to 400 with no statusFor', async () => {
    const res = await withSessionApp((c, sessions) =>
      domainErrorPage(c, sessions, new DomainError('conflict', 'already active'), {
        title: 'Memory',
        activeNav: 'memories',
      }),
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('already active');
  });

  it('domainErrorPage applies statusFor to resolve a code-specific status', async () => {
    const res = await withSessionApp((c, sessions) =>
      domainErrorPage(
        c,
        sessions,
        new DomainError('session_not_found', 'no such session'),
        { title: 'Sessions', activeNav: 'sessions' },
        (code) => (code === 'session_not_found' ? 404 : 400),
      ),
    );
    expect(res.status).toBe(404);
  });
});

describe('NAV', () => {
  it('exposes 10 entries in MAIN + ADMIN groups', () => {
    expect(NAV).toHaveLength(10);
    expect(NAV.filter((n) => n.group === 'MAIN')).toHaveLength(7);
    expect(NAV.filter((n) => n.group === 'ADMIN')).toHaveLength(3);
  });

  it('navEntry(key) returns the matching entry', () => {
    expect(navEntry('home').href).toBe('/dashboard');
    expect(navEntry('memories').num).toBe('02');
    expect(navEntry('prompts').href).toBe('/dashboard/prompts');
    expect(navEntry('maintenance').href).toBe('/dashboard/maintenance');
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

  it('shows the needs-review badge on the MEMORIES entry when counter > 0', () => {
    const out = renderSidebar({
      active: 'home',
      counters: { needsReview: 5 },
      collapsed: false,
      csrf,
    });
    expect(out.__html).toMatch(/href="\/dashboard\/memories"[\s\S]*?<span class="badge">5<\/span>/);
  });

  it('omits the needs-review badge when counter is 0 or absent', () => {
    const zero = renderSidebar({
      active: 'home',
      counters: { needsReview: 0 },
      collapsed: false,
      csrf,
    });
    expect(zero.__html).not.toContain('class="badge"');
    const absent = renderSidebar({ active: 'home', counters: {}, collapsed: false, csrf });
    expect(absent.__html).not.toContain('class="badge"');
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
    expect(out.__html).toContain(`v${REMBRIC_VERSION}`);
    expect(out.__html).not.toContain('SELF-HOSTED');
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

  it('renders the update badge next to the brand when provided', () => {
    const out = renderSidebar({
      active: 'home',
      counters: {},
      collapsed: false,
      csrf,
      update: raw('<a class="sb-update" href="/dashboard/update">UPDATE v0.22.0</a>'),
    });
    expect(out.__html).toMatch(/sb-brand[\s\S]*?sb-update[\s\S]*?sb-section/);
    expect(out.__html).toContain('UPDATE v0.22.0');
  });

  it('renders no update badge by default', () => {
    const out = renderSidebar({ active: 'home', counters: {}, collapsed: false, csrf });
    expect(out.__html).not.toContain('sb-update');
  });
});

describe('renderMobileBar', () => {
  it('renders REMBRIC + version + the ☰ MENU toggle', () => {
    const out = renderMobileBar('home');
    expect(out.__html).toContain('REMBRIC');
    expect(out.__html).toContain(`v${REMBRIC_VERSION}`);
    expect(out.__html).not.toContain('SELF-HOSTED');
    expect(out.__html).toContain('☰ MENU');
    expect(out.__html).toContain('class="mob-toggle"');
  });

  it('renders the update badge when provided, none by default', () => {
    const withBadge = renderMobileBar('home', raw('<a class="sb-update" href="/x">UPD</a>'));
    expect(withBadge.__html).toContain('sb-update');
    expect(renderMobileBar('home').__html).not.toContain('sb-update');
  });
});

describe('renderMarkdown', () => {
  it('renders bold, inline code, fenced code, and lists as HTML', () => {
    const out = renderMarkdown('**bold** and `code`\n\n- one\n- two\n\n```\nfenced\n```').__html;
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('<code>code</code>');
    expect(out).toContain('<ul>');
    expect(out).toContain('<li>one</li>');
    expect(out).toContain('<pre><code>fenced\n</code></pre>');
    // raw Markdown markers must not survive as visible source
    expect(out).not.toContain('**bold**');
  });

  it('escapes raw HTML in content (html:false) instead of injecting it', () => {
    const out = renderMarkdown('hello <script>alert(1)</script> world').__html;
    expect(out).not.toContain('<script>');
    expect(out).toContain('&lt;script&gt;');
  });

  it('does not emit a clickable javascript: link', () => {
    const out = renderMarkdown('[click](javascript:alert(1))').__html;
    expect(out).not.toContain('href="javascript:');
  });

  it('renders an ordinary http link as an anchor', () => {
    const out = renderMarkdown('[rembric](https://example.com)').__html;
    expect(out).toContain('<a href="https://example.com">rembric</a>');
  });
});

describe('mdBody', () => {
  it('wraps rendered Markdown with a copy-raw button and a hidden raw source', () => {
    const out = mdBody('**bold** and `code`').__html;
    expect(out).toContain('class="md-block"');
    expect(out).toContain('data-md-copy');
    expect(out).toContain('class="md-body"');
    expect(out).toContain('<strong>bold</strong>');
    expect(out).toContain('class="md-raw" hidden');
    // icon-only button: carries the copy + done SVG icons, no "COPY" text label
    expect(out).toContain('class="ic ic-copy"');
    expect(out).toContain('class="ic ic-done"');
    expect(out).toContain('<svg');
    expect(out).not.toContain('>COPY<');
  });

  it('stores the raw source escaped (round-trips via textContent), never as live markup', () => {
    const out = mdBody('line one\n<script>alert(1)</script>').__html;
    const raw = out.slice(out.indexOf('<pre class="md-raw"'), out.indexOf('</pre>'));
    // raw source is HTML-escaped inside the hidden <pre>; no live script tag
    expect(raw).toContain('&lt;script&gt;');
    expect(raw).not.toContain('<script>');
    // newline from the source is preserved verbatim in the <pre>
    expect(raw).toContain('line one\n');
  });
});
