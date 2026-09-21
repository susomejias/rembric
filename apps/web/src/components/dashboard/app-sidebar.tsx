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
 *
 * `min-w-0` on both the inset and its content column is load-bearing: the inset
 * is a flex item, so its default `min-width: auto` refuses to shrink below the
 * column's min-content width and a wide child would push the whole page past the
 * viewport. Main expressed the same rule as `min-width: 0` on `.main` (and on
 * `.app > .main`) rather than hiding the overflow.
 *
 * The content column takes the full width the inset offers — no `max-w` and no
 * `mx-auto`. A cap here left a several-hundred-pixel void on the right at a wide
 * viewport with the rail collapsed, and main's `.main` was never capped: it
 * simply filled what the rail left. Readable-content widths belong to the content
 * that needs them (markdown panels, forms), not to the dashboard frame.
 *
 * This column also owns the vertical rhythm, and owns it alone: `oauth-consent`
 * renders in this frame without a `Page`, so `Page` carries no vertical padding
 * and the two can never be added into one gap.
 *
 * `version` and `updater` are the rail's two server-side facts, resolved in
 * `dashboard/layout.tsx` and handed down rather than read here: the running
 * release identity comes off the filesystem (`lib/version`), and the update
 * read-state comes from the release-check service. Neither is importable from
 * this client module.
 */
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
          <div className="w-full min-w-0 px-5 py-6">{children}</div>
        </SidebarInset>
      </SidebarProvider>
    </TooltipProvider>
  );
}

/**
 * The dashboard's primary navigation, on the shadcn sidebar primitives.
 *
 * The rail is the primitive's, in icons-only mode, so the mouse hover edge, the
 * ⌘B shortcut and the mobile sheet all come from `SidebarProvider` rather than
 * from a second implementation.
 *
 * What is tuned is deliberately two things: the row labels wear the rail's
 * identity type (`font-mono uppercase`, main's own treatment) and the badge keeps
 * main's `--warn` ink. Everything else is the primitive's own presentation — the
 * group captions are the stock `SidebarGroupLabel`, the rows are its default
 * size, and the active row is its `data-active` fill. Main's 3px lime rule and
 * its `size="lg"` rows are gone: a 3px border on the primitive's rounded row read
 * as a bracket, and the tall rows made a ten-item rail read as a list of panels.
 *
 * The order of the three regions is main's: brand block and update slot, then
 * `MAIN` / `ADMIN`, then the sign-out and the collapse toggle in the footer.
 */
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
                {/* `gap-1` is the only spacing this rail adds to the primitive's
                    own rows: at `gap-0` a ten-item rail reads as one continuous
                    block (main's own rows sat flush too, but they carried a 44px
                    row). The rows keep the primitive's padding. */}
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

/**
 * The rail's brand block — the mark, the wordmark and the running version, the
 * trio main's `.sb-brand` opens with. The mark is the transparent logo the login
 * card also wears; the wordmark and the version drop out in icons-only mode, where
 * only the mark has room.
 *
 * `version` is a prop because it is a filesystem read (`lib/version`), which this
 * client module cannot do itself.
 */
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

/**
 * The raw release-check facts, as the layout reads them off the service. Passed
 * to the rail as data rather than as a rendered slot so the client owns the
 * wording and the branch table stays testable on its own.
 */
export interface UpdaterInput {
  /** `REMBRIC_UPDATE_CHECK=off` disables the daily check; the slot still renders. */
  readonly enabled: boolean;
  /** The release the check found, or `null` when it found none. */
  readonly latestVersion: string | null;
  /** Most recent check this process lifetime, `null` until one has run. */
  readonly lastCheckedAt: Date | null;
}

export type UpdaterReadState =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'available'; readonly latestVersion: string }
  | { readonly kind: 'unknown' }
  | { readonly kind: 'checked' };

/**
 * The slot's read-state, from the service's own public surface.
 *
 * The mapping cannot claim "up to date". `UpdateCheckService.peek()` answers
 * `null` both when a check succeeded and found nothing and when the check could
 * not reach GitHub — the failed-check flag behind that difference is private — so
 * the only reading that stays true under every outcome is that no newer release
 * is *known*. The slot says exactly that, and never `UP TO DATE`; `checked` is
 * what `lastCheckedAt` set means, and `unknown` is a process that has not
 * completed a check yet.
 *
 * A disabled check is its own state rather than an absent slot: `/dashboard/
 * update` is where the operator turns the reading over, so the rail must keep
 * pointing at it. Hiding the slot would strand the only in-app route to the page
 * that explains the setting.
 */
export function updaterReadState(input: UpdaterInput): UpdaterReadState {
  if (!input.enabled) return { kind: 'disabled' };
  if (input.latestVersion !== null) {
    return { kind: 'available', latestVersion: input.latestVersion };
  }
  return input.lastCheckedAt === null ? { kind: 'unknown' } : { kind: 'checked' };
}

/**
 * The update slot under the brand — main's `.sb-update` in the theme's utilities,
 * and a link in every state, including a disabled check, so `/dashboard/update`
 * stays reachable even when the rail has nothing to announce. An available
 * release wears the accent; the no-news states are quiet so a working rail is not
 * permanently shouting.
 *
 * In icons-only mode the label drops to `sr-only` and the box keeps its dot, the
 * same trade main makes when it hides `.sb-update .label`.
 */
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

/**
 * One rail row. The active row is the primitive's `data-active` fill, raised to
 * the accent ink (`data-active:text-primary` — the icon inherits it), plus a
 * straight lime rule at the row's left edge.
 *
 * The type and icon sizes are main's, not the primitive's defaults: main's rail
 * label is ~11.5px over an 18px icon (`.sb-item` in `styles/core/layout.css`),
 * where the stock row is 14px over 16px. `h-9` is the one addition to the
 * primitive's 32px row — main's own is 44px, which is the row this rail was
 * already trimmed away from, and the taller target is what the mobile sheet's
 * rows get too. The icons-only size is untouched: the primitive pins it with
 * `group-data-[collapsible=icon]:size-8!`.
 *
 * The rule is a detached element rather than a `border-l` on the row because the
 * stock row is rounded: a left border follows the corner radius into a bracket.
 *
 * `pr-8` is what keeps a long label from running under the badge.
 *
 * `pointer-events-auto` is the one thing the badge cannot inherit: the primitive
 * disables pointer events on it, and a `title` on an element the pointer never
 * reaches is a tooltip nobody can read. The click still bubbles to the row's own
 * link, so only the hover target changes.
 *
 * The tooltip is the primitive's, so icons-only mode still names each row.
 */
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
