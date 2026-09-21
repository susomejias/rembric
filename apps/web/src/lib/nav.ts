import {
  BrainCircuit,
  FileText,
  Gavel,
  KeyRound,
  LayoutDashboard,
  ListChecks,
  Radio,
  RefreshCw,
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
}

/**
 * The navigation table is data, not markup: ordering, labels and icons are
 * pinned here so the bar and the topbar's page title read one source. The order
 * is the mockup's — Workspace above Admin.
 *
 * Activity and Settings are deliberately absent: neither carries a decision the
 * operator can act on here (Activity only restates what the other views show,
 * and Settings has nothing to configure yet), so listing them would be navigable
 * surface with no user value. Their routes still resolve for a bookmarked URL.
 */
export const NAV: readonly NavEntry[] = [
  { key: 'overview', group: 'main', label: 'Overview', href: '/dashboard', icon: LayoutDashboard },
  { key: 'sessions', group: 'main', label: 'Sessions', href: '/dashboard/sessions', icon: Radio },
  {
    key: 'memories',
    group: 'main',
    label: 'Memories',
    href: '/dashboard/memories',
    icon: BrainCircuit,
  },
  {
    key: 'judgments',
    group: 'main',
    label: 'Judgments',
    href: '/dashboard/judgments',
    icon: Gavel,
  },
  { key: 'prompts', group: 'main', label: 'Prompts', href: '/dashboard/prompts', icon: FileText },
  {
    key: 'consolidation',
    group: 'main',
    label: 'Consolidation',
    href: '/dashboard/consolidation',
    icon: ListChecks,
  },
  {
    key: 'maintenance',
    group: 'main',
    label: 'Maintenance',
    href: '/dashboard/maintenance',
    icon: Wrench,
  },
  { key: 'updates', group: 'main', label: 'Updates', href: '/dashboard/update', icon: RefreshCw },
  {
    key: 'projects',
    group: 'admin',
    label: 'Projects',
    href: '/dashboard/projects',
    icon: FileText,
  },
  { key: 'tokens', group: 'admin', label: 'Tokens', href: '/dashboard/tokens', icon: KeyRound },
];

/** The two sections, in render order, each carrying the caption the sidebar paints above its items. */
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
