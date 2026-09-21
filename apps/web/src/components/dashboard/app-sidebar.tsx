'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';

import { NavUser } from './nav-user';
import { SiteHeader } from './site-header';

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarRail,
} from '@/components/ui/sidebar';
import { TooltipProvider } from '@/components/ui/tooltip';
import {
  badgeTooltip,
  isChromeFreePath,
  NAV,
  NAV_GROUPS,
  navEntryForPath,
  type NavBadgeCounters,
  type NavEntry,
} from '@/lib/nav';
import { cn } from '@/lib/utils';
import { REMBRIC_VERSION } from '@/lib/version';

/**
 * The dashboard frame: the vertical rail, the content column beside it, and the
 * one route that renders with neither.
 *
 * It owns the content column for the same reason its predecessor did: no layout
 * can opt out of its parent or read the pathname, and `/dashboard/login` is a
 * full-bleed screen that must keep rendering without the frame, so the only place
 * that exception can live is a client component above the column. `lib/nav` names
 * the path once; this is its only reader.
 *
 * `TooltipProvider` is here because the rail's icons-only mode is the only
 * tooltip surface in the app, and the primitive's tooltips need a provider above
 * them — the root layout has none.
 */
export function SidebarFrame({
  children,
  counters = {},
  themeStorageKey,
}: {
  children: ReactNode;
  counters?: NavBadgeCounters;
  themeStorageKey: string;
}) {
  const pathname = usePathname();

  if (isChromeFreePath(pathname)) return <>{children}</>;

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar counters={counters} />
        <SidebarInset>
          <SiteHeader themeStorageKey={themeStorageKey} />
          <div className="mx-auto w-full max-w-[1320px] px-5 py-5">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

/**
 * The dashboard's primary navigation — the production sidebar
 * (`apps/server/src/dashboard/components.ts::renderSidebar` +
 * `styles/core/layout.css::.sb`) rebuilt on the shadcn sidebar primitives.
 *
 * Structure, not markup, is what is copied from main:
 *
 *  - **The rail is flush.** Main paints it with the page's own background
 *    (`background: var(--bg)`) and separates it with a right border, so the two
 *    read as one surface. `globals.css` points the `--sidebar*` tokens at the
 *    page's own values for exactly this.
 *  - **The brand block sits at the top**, logo then `REMBRIC` over the running
 *    version, and collapses to the logo alone.
 *  - **Two sections, `MAIN` then `ADMIN`**, each with the lime-marked caption
 *    main's `.sb-section` carries; the caption fades out in icons-only mode.
 *  - **The active item wears a lime left border** with no fill and lime ink
 *    (`.sb-item.is-active`). In icons-only mode main moves that marker to the
 *    rail's right edge, so the classes flip it with the collapse.
 *  - **The badge is main's**: the bare count in `--warn`, not a filled pill, so
 *    it stays legible against both the idle and the active row.
 *
 * Rows are the primitive's `lg` size (48px) against main's 44px minimum, and the
 * nav labels are uppercase through CSS rather than stored uppercase in `lib/nav`:
 * the table stays readable and the rail still reads as main's.
 */
export function AppSidebar({ counters = {} }: { counters?: NavBadgeCounters }) {
  const activeKey = navEntryForPath(usePathname())?.key;

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader>
        <BrandBlock />
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => {
          const entries = NAV.filter((entry) => entry.group === group.key);
          if (entries.length === 0) return null;

          return (
            <SidebarGroup key={group.key}>
              <SidebarGroupLabel className={SECTION}>{group.heading}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {entries.map((entry) => (
                    <NavItem
                      key={entry.key}
                      entry={entry}
                      isActive={entry.key === activeKey}
                      badge={badgeFor(entry, counters)}
                    />
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          );
        })}
      </SidebarContent>

      <SidebarFooter className="border-t border-sidebar-border">
        <NavUser />
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}

/** Main's `.sb-section`: the lime-marked, mono, tracked caption above a group. */
const SECTION = cn(
  'ml-2 border-l-[3px] border-l-primary pl-2 font-mono',
  'text-[0.58rem]! tracking-[0.18em] text-muted-foreground! uppercase',
);

/**
 * Main's `.sb-item`, translated to the theme's utilities. The left border is
 * always 3px wide and only ever changes colour, so the icon never shifts by a
 * pixel between the active and the idle row.
 */
const ITEM = cn(
  'gap-3! border-l-[3px] border-l-transparent pl-3 font-mono',
  'text-[0.72rem]! tracking-[0.08em] text-muted-foreground uppercase',
  'hover:text-foreground',
  'data-active:border-l-primary data-active:bg-transparent! data-active:text-primary!',
  '[&>svg]:size-5! [&>svg]:text-muted-foreground data-active:[&>svg]:text-primary',
  'group-data-[collapsible=icon]:border-l-0! group-data-[collapsible=icon]:border-r-[3px]',
  'group-data-[collapsible=icon]:border-r-transparent',
  'group-data-[collapsible=icon]:data-active:border-r-primary!',
);

/** Main's `.sb-item .badge`: bare `--warn` count, tucked into the corner when icon-only. */
const BADGE = cn(
  'pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 font-mono text-[0.58rem]',
  'font-semibold tracking-[0.12em] text-warn tabular-nums',
  'group-data-[collapsible=icon]:top-0 group-data-[collapsible=icon]:right-0.5',
  'group-data-[collapsible=icon]:translate-y-0 group-data-[collapsible=icon]:text-[0.52rem]',
);

/**
 * The rail's brand block — the mark, the wordmark and the running version, the
 * same trio main's `.sb-brand` opens with. The mark is the transparent logo the
 * login card also wears; the wordmark and the version drop out in icons-only
 * mode, where only the mark has room.
 */
function BrandBlock() {
  return (
    <Link
      href="/dashboard"
      title="REMBRIC · Go to the overview"
      className="flex w-full items-center gap-3 px-2 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0"
    >
      <img
        src="/dashboard/assets/logo-transparent.png"
        alt=""
        aria-hidden="true"
        className="size-7 shrink-0"
      />
      <span className="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden">
        <span className="truncate font-mono text-[0.72rem] font-semibold tracking-[0.12em] uppercase">
          Rembric
        </span>
        <small className="mt-0.5 truncate text-[0.6rem] tracking-[0.14em] text-muted-foreground">
          v{REMBRIC_VERSION}
        </small>
      </span>
      <span className="sr-only">Rembric — go to the overview</span>
    </Link>
  );
}

interface NavItemBadge {
  readonly count: number;
  readonly title: string;
}

function badgeFor(entry: NavEntry, counters: NavBadgeCounters): NavItemBadge | null {
  const breakdown = entry.badgeKey ? counters[entry.badgeKey] : undefined;
  if (!entry.badgeKey || !breakdown || breakdown.total <= 0) return null;
  return { count: breakdown.total, title: badgeTooltip(entry.badgeKey, breakdown) };
}

function NavItem({
  entry,
  isActive,
  badge,
}: {
  entry: NavEntry;
  isActive: boolean;
  badge: NavItemBadge | null;
}) {
  const Icon = entry.icon;

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        asChild
        isActive={isActive}
        size="lg"
        tooltip={entry.label}
        className={cn(ITEM, badge !== null && 'pr-8')}
      >
        <Link
          href={entry.href}
          prefetch
          data-nav-key={entry.key}
          aria-current={isActive ? 'page' : undefined}
          title={`§ ${entry.num} · ${entry.label}`}
        >
          <Icon aria-hidden="true" />
          <span>{entry.label}</span>
        </Link>
      </SidebarMenuButton>
      {badge !== null ? (
        <span data-slot="nav-badge" title={badge.title} className={BADGE}>
          {badge.count}
        </span>
      ) : null}
    </SidebarMenuItem>
  );
}
