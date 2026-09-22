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
  readonly group: 'main' | 'admin';
  readonly num: string;
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
  readonly badgeKey?: BadgeKey;
}

export interface BadgeBreakdown {
  readonly total: number;
  readonly byProject: ReadonlyArray<{ readonly label: string; readonly count: number }>;
}

export type NavBadgeCounters = {
  readonly needsReview?: BadgeBreakdown;
  readonly pendingJudgments?: BadgeBreakdown;
};

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

export const CHROME_FREE_PATH = '/dashboard/login';

export function isChromeFreePath(pathname: string | null | undefined): boolean {
  return pathname === CHROME_FREE_PATH;
}
