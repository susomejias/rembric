import {
  BrainIcon,
  CombineIcon,
  FolderKanbanIcon,
  KeyRoundIcon,
  LayoutDashboardIcon,
  MessagesSquareIcon,
  MessageSquareQuoteIcon,
  ScaleIcon,
  WrenchIcon,
  type LucideIcon,
} from 'lucide-react';

/**
 * The two badge counters the sidebar surfaces. A project-scoped number carries
 * its per-project split so the badge tooltip can explain where the count comes
 * from without a second query.
 */
export interface NavBadgeBreakdown {
  readonly total: number;
  readonly byProject: readonly { readonly label: string; readonly count: number }[];
}

export type NavBadgeKey = 'pendingJudgments' | 'needsReview';

export type NavBadgeCounters = {
  readonly pendingJudgments?: NavBadgeBreakdown;
  readonly needsReview?: NavBadgeBreakdown;
};

export interface NavEntry {
  readonly key: string;
  /** Sidebar section the entry is listed under. */
  readonly group: 'main' | 'admin';
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
  readonly badgeKey?: NavBadgeKey;
}

/**
 * The navigation table is data, not markup: ordering, labels and badge wiring
 * are pinned here so the sidebar, the header breadcrumb and any later test read
 * one source.
 */
export const NAV: readonly NavEntry[] = [
  {
    key: 'overview',
    group: 'main',
    label: 'Overview',
    href: '/dashboard',
    icon: LayoutDashboardIcon,
  },
  {
    key: 'memories',
    group: 'main',
    label: 'Memories',
    href: '/dashboard/memories',
    icon: BrainIcon,
    badgeKey: 'needsReview',
  },
  {
    key: 'sessions',
    group: 'main',
    label: 'Sessions',
    href: '/dashboard/sessions',
    icon: MessagesSquareIcon,
  },
  {
    key: 'prompts',
    group: 'main',
    label: 'Prompts',
    href: '/dashboard/prompts',
    icon: MessageSquareQuoteIcon,
  },
  {
    key: 'judgments',
    group: 'main',
    label: 'Judgments',
    href: '/dashboard/judgments',
    icon: ScaleIcon,
    badgeKey: 'pendingJudgments',
  },
  {
    key: 'consolidation',
    group: 'main',
    label: 'Consolidation',
    href: '/dashboard/consolidation',
    icon: CombineIcon,
  },
  {
    key: 'projects',
    group: 'admin',
    label: 'Projects',
    href: '/dashboard/projects',
    icon: FolderKanbanIcon,
  },
  {
    key: 'tokens',
    group: 'admin',
    label: 'Tokens',
    href: '/dashboard/tokens',
    icon: KeyRoundIcon,
  },
  {
    key: 'maintenance',
    group: 'admin',
    label: 'Maintenance',
    href: '/dashboard/maintenance',
    icon: WrenchIcon,
  },
];

/**
 * The two sections, in render order, each carrying the uppercase caption the
 * sidebar paints above its items. `main`'s caption is `null` on purpose: the
 * section starts directly under the logo bar, where a caption would label the
 * only thing on screen — the reference (`apps/web/mockup.html`) captions
 * `Admin` alone.
 */
export const NAV_GROUPS = [
  { key: 'main', heading: null },
  { key: 'admin', heading: 'Admin' },
] as const;

export function navEntryForPath(pathname: string): NavEntry | undefined {
  if (pathname === '/dashboard' || pathname === '/dashboard/') return NAV[0];
  return NAV.filter((entry) => entry.href !== '/dashboard').find(
    (entry) => pathname === entry.href || pathname.startsWith(`${entry.href}/`),
  );
}

/** Native `title` for a sidebar badge: headline plus the per-project breakdown. */
export function badgeTooltip(key: NavBadgeKey, breakdown: NavBadgeBreakdown): string {
  const headline =
    key === 'pendingJudgments'
      ? `${breakdown.total} pending judgment candidate${breakdown.total === 1 ? '' : 's'} across all projects — resolve with memory.judge`
      : `${breakdown.total} active memor${breakdown.total === 1 ? 'y' : 'ies'} past their review TTL across all projects — re-affirm with memory.confirm`;
  const lines = [...breakdown.byProject]
    .sort((a, z) => z.count - a.count)
    .map((row) => `${row.label}: ${row.count}`);
  return lines.length > 0 ? `${headline}\n${lines.join('\n')}` : headline;
}
