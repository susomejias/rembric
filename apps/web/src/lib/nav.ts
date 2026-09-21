import {
  BrainCircuit,
  FileText,
  Folder,
  Gavel,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Network,
  Radio,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export type BadgeKey = 'needsReview' | 'pendingJudgments';

export interface NavEntry {
  readonly key: string;
  /** Sidebar section the entry is listed under. */
  readonly group: 'main' | 'admin';
  /** The section number the sidebar prints in the item's `title`: `§ 02 · Memories`. */
  readonly num: string;
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
  /** The one badge counter this entry paints, if any. */
  readonly badgeKey?: BadgeKey;
}

/**
 * One badge's server-wide total plus its per-project split. A connection resolves
 * to exactly one project, but the dashboard reads across all of them, so a badge
 * that carried only a total would say "3" where the operator needs to know *which*
 * project to open. `badgeTooltip` is what turns the split into the item's title.
 */
export interface BadgeBreakdown {
  readonly total: number;
  readonly byProject: ReadonlyArray<{ readonly label: string; readonly count: number }>;
}

/** The two counters the sidebar paints, each keyed to the one entry that resolves it. */
export type NavBadgeCounters = {
  readonly needsReview?: BadgeBreakdown;
  readonly pendingJudgments?: BadgeBreakdown;
};

/**
 * The navigation table is data, not markup: ordering, labels, icons, section
 * numbers and badges are pinned here so the sidebar reads one source. Order, `num`
 * and the two badge entries mirror the production dashboard's sidebar
 * (`apps/server/src/dashboard/components.ts::NAV`) — MAIN above ADMIN,
 * `needsReview` on memories and `pendingJudgments` on judgments.
 *
 * Every entry carries its own icon. Main's rail tints each one differently and a
 * repeated glyph there reads as a rendering bug rather than as two sections.
 */
export const NAV: readonly NavEntry[] = [
  {
    key: 'overview',
    group: 'main',
    num: '01',
    label: 'Overview',
    href: '/dashboard',
    icon: LayoutDashboard,
  },
  {
    key: 'memories',
    group: 'main',
    num: '02',
    label: 'Memories',
    href: '/dashboard/memories',
    icon: BrainCircuit,
    badgeKey: 'needsReview',
  },
  {
    key: 'sessions',
    group: 'main',
    num: '03',
    label: 'Sessions',
    href: '/dashboard/sessions',
    icon: Radio,
  },
  {
    key: 'prompts',
    group: 'main',
    num: '03b',
    label: 'Prompts',
    href: '/dashboard/prompts',
    icon: FileText,
  },
  {
    key: 'judgments',
    group: 'main',
    num: '04',
    label: 'Judgments',
    href: '/dashboard/judgments',
    icon: Gavel,
    badgeKey: 'pendingJudgments',
  },
  {
    key: 'consolidation',
    group: 'main',
    num: '05',
    label: 'Consolidation',
    href: '/dashboard/consolidation',
    icon: ListChecks,
  },
  {
    key: 'entities',
    group: 'main',
    num: '05b',
    label: 'Entities',
    href: '/dashboard/entities',
    icon: Network,
  },
  {
    key: 'projects',
    group: 'admin',
    num: '06',
    label: 'Projects',
    href: '/dashboard/projects',
    icon: Folder,
  },
  {
    key: 'tokens',
    group: 'admin',
    num: '07',
    label: 'Tokens',
    href: '/dashboard/tokens',
    icon: KeyRound,
  },
  {
    key: 'maintenance',
    group: 'admin',
    num: '08',
    label: 'Maintenance',
    href: '/dashboard/maintenance',
    icon: Wrench,
  },
];

/**
 * The two sections, in render order, each carrying the caption the sidebar paints
 * above its items. The captions are main's literal `MAIN` / `ADMIN`
 * (`components.ts::renderSidebar`) rather than prettified, because the rail is
 * meant to be the same rail on both surfaces.
 */
export const NAV_GROUPS = [
  { key: 'main', heading: 'MAIN' },
  { key: 'admin', heading: 'ADMIN' },
] as const;

export function navEntryForPath(pathname: string): NavEntry | undefined {
  if (pathname === '/dashboard' || pathname === '/dashboard/') return NAV[0];
  return NAV.filter((entry) => entry.href !== '/dashboard').find(
    (entry) => pathname === entry.href || pathname.startsWith(`${entry.href}/`),
  );
}

/**
 * Native `title` for a sidebar badge: the headline plus the per-project
 * breakdown, one project per line, biggest first. Ported from main's
 * `components.ts::badgeTip` so an operator moving between the two dashboards
 * reads the same sentence and the same resolution verb.
 */
export function badgeTooltip(key: BadgeKey, badge: BadgeBreakdown): string {
  const head =
    key === 'pendingJudgments'
      ? `${badge.total} pending judgment candidate${badge.total === 1 ? '' : 's'} across all projects — resolve with memory.judge`
      : `${badge.total} active memor${badge.total === 1 ? 'y' : 'ies'} past their review TTL across all projects — re-affirm with memory.confirm`;
  const lines = [...badge.byProject]
    .sort((a, z) => z.count - a.count)
    .map((row) => `${row.label}: ${row.count}`);
  return lines.length > 0 ? `${head}\n${lines.join('\n')}` : head;
}

/**
 * `/dashboard/login` is the one dashboard route that renders with no chrome: it
 * is a full-bleed screen carrying its own brand block, and `middleware.ts` keeps
 * it public. The path is named here, once, because the shell that has to opt out
 * of the sidebar, the header and the content column is its only reader.
 */
export const CHROME_FREE_PATH = '/dashboard/login';

export function isChromeFreePath(pathname: string | null | undefined): boolean {
  return pathname === CHROME_FREE_PATH;
}
