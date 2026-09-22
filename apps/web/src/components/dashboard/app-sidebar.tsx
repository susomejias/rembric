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
  SidebarMenuBadge,
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

export function SidebarFrame({
  children,
  counters = {},
  version,
  updater,
}: {
  children: ReactNode;
  counters?: NavBadgeCounters;
  version: string;
  updater: UpdaterInput;
}) {
  const pathname = usePathname();

  if (isChromeFreePath(pathname)) return <>{children}</>;

  return (
    <TooltipProvider>
      <SidebarProvider>
        <AppSidebar counters={counters} version={version} updater={updater} />
        <SidebarInset className="min-w-0">
          <SiteHeader />
          <div className="w-full min-w-0 px-4 py-5">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

export function AppSidebar({
  counters = {},
  version,
  updater,
}: {
  counters?: NavBadgeCounters;
  version: string;
  updater: UpdaterInput;
}) {
  const activeKey = navEntryForPath(usePathname())?.key;

  return (
    <Sidebar collapsible="icon" className="border-r border-sidebar-border">
      <SidebarHeader>
        <BrandBlock version={version} />
        <UpdaterSlot updater={updater} />
      </SidebarHeader>

      <SidebarContent>
        {NAV_GROUPS.map((group) => {
          const entries = NAV.filter((entry) => entry.group === group.key);
          if (entries.length === 0) return null;

          return (
            <SidebarGroup key={group.key}>
              <SidebarGroupLabel className="gap-2 text-[10px] tracking-[.18em]">
                <span aria-hidden="true" className="size-[6px] shrink-0 bg-primary" />
                {group.heading}
              </SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu className="gap-1">
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

function BrandBlock({ version }: { version: string }) {
  return (
    <Link
      href="/dashboard"
      title="REMBRIC · Go to the overview"
      className="flex w-full items-center gap-3 group-data-[collapsible=icon]:justify-center"
    >
      <img
        src="/dashboard/assets/logo-transparent.png"
        alt=""
        aria-hidden="true"
        className="size-7 shrink-0"
      />
      <span className="flex min-w-0 flex-col group-data-[collapsible=icon]:hidden">
        <span className="truncate text-sm font-semibold uppercase">Rembric</span>
        <span className="truncate text-xs text-muted-foreground">v{version}</span>
      </span>
      <span className="sr-only">Rembric — go to the overview</span>
    </Link>
  );
}

export interface UpdaterInput {
  readonly enabled: boolean;
  readonly latestVersion: string | null;
  readonly lastCheckedAt: Date | null;
}

export type UpdaterReadState =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'available'; readonly latestVersion: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'checked' };

export function updaterReadState(input: UpdaterInput): UpdaterReadState {
  if (!input.enabled) return { kind: 'disabled' };
  if (input.latestVersion !== null) {
    return { kind: 'available', latestVersion: input.latestVersion };
  }
  return input.lastCheckedAt === null ? { kind: 'unknown' } : { kind: 'checked' };
}

function UpdaterSlot({ updater }: { updater: UpdaterInput }) {
  const state = updaterReadState(updater);

  const available = state.kind === 'available';
  const label = available
    ? `Update v${state.latestVersion}`
    : state.kind === 'disabled'
      ? 'Check off'
      : state.kind === 'checked'
        ? 'No newer release known'
        : 'Not checked yet';
  const title = available
    ? `Update available: v${state.latestVersion}`
    : state.kind === 'disabled'
      ? 'Release status and updates — the daily check is off'
      : 'Release status and updates';

  return (
    <Link
      href="/dashboard/update"
      title={title}
      className={cn(
        'flex items-center gap-2 border px-2 py-1.5 font-mono text-xs tracking-wide uppercase',
        'group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0',
        available
          ? 'border-primary text-primary hover:bg-primary hover:text-primary-foreground'
          : 'border-border text-muted-foreground hover:border-foreground hover:text-foreground',
      )}
    >
      <span
        aria-hidden="true"
        className={cn('size-1.5 shrink-0', available ? 'bg-primary' : 'bg-muted-foreground')}
      />
      <span className="truncate group-data-[collapsible=icon]:sr-only">{label}</span>
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
        tooltip={entry.label}
        className={cn(
          'font-mono text-xs uppercase tracking-[.08em]',
          'h-9 [&_svg]:size-[18px]',
          badge !== null && 'pr-8',
          'data-active:text-primary',
        )}
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
      {isActive ? (
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-1 left-0 w-[3px] bg-primary"
        />
      ) : null}
      {badge !== null ? (
        <SidebarMenuBadge
          title={badge.title}
          className="pointer-events-auto top-1/2! h-4 min-w-4 -translate-y-1/2 font-mono text-[10px] text-warn"
        >
          {badge.count}
        </SidebarMenuBadge>
      ) : null}
    </SidebarMenuItem>
  );
}
