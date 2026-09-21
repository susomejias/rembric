import {
  BrainCircuit,
  FileText,
  Gavel,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Network,
  Radio,
  Wrench,
  type LucideIcon,
} from 'lucide-react';

export interface NavEntry {
  readonly key: string;
  /** Sidebar section the entry is listed under. */
  readonly group: 'main' | 'admin';
  readonly label: string;
  readonly href: string;
  readonly icon: LucideIcon;
  /** The one badge counter this entry paints, if any. */
  readonly badgeKey?: 'needsReview' | 'pendingJudgments';
}

/**
 * The navigation table is data, not markup: ordering, labels, icons and badges
 * are pinned here so the bar reads one source. The order and the two badge
 * entries mirror the production dashboard's sidebar
 * (`apps/server/src/dashboard/components.ts::NAV`) — Workspace above Admin,
 * `needsReview` on memories and `pendingJudgments` on judgments.
 */
export const NAV: readonly NavEntry[] = [
  { key: 'overview', group: 'main', label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
  {
    key: 'memories',
    group: 'main',
    label: 'Memories',
    href: '/dashboard/memories',
    icon: BrainCircuit,
    badgeKey: 'needsReview',
  },
  { key: 'sessions', group: 'main', label: 'Sessions', href: '/dashboard/sessions', icon: Radio },
  { key: 'prompts', group: 'main', label: 'Prompts', href: '/dashboard/prompts', icon: FileText },
  {
    key: 'judgments',
    group: 'main',
    label: 'Judgments',
    href: '/dashboard/judgments',
    icon: Gavel,
    badgeKey: 'pendingJudgments',
  },
  {
    key: 'consolidation',
    group: 'main',
    label: 'Consolidation',
    href: '/dashboard/consolidation',
    icon: ListChecks,
  },
  { key: 'entities', group: 'main', label: 'Entities', href: '/dashboard/entities', icon: Network },
  {
    key: 'projects',
    group: 'admin',
    label: 'Projects',
    href: '/dashboard/projects',
    icon: FileText,
  },
  { key: 'tokens', group: 'admin', label: 'Tokens', href: '/dashboard/tokens', icon: KeyRound },
  {
    key: 'maintenance',
    group: 'admin',
    label: 'Maintenance',
    href: '/dashboard/maintenance',
    icon: Wrench,
  },
];

/** The two sections, in render order, each carrying the caption the bar paints above its items. */
export const NAV_GROUPS = [
  { key: 'main', heading: 'Workspace' },
  { key: 'admin', heading: 'Admin' },
] as const;

export function navEntryForPath(pathname: string): NavEntry | undefined {
  if (pathname === '/dashboard' || pathname === '/dashboard/') return NAV[0];
  return NAV.filter((entry) => entry.href !== '/dashboard').find(
    (entry) => pathname === entry.href || pathname.startsWith(`${entry.href}/`),
  );
}
