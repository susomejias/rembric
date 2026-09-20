'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState } from 'react';

import { NavUser } from '@/components/dashboard/nav-user';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { useSidebar } from '@/components/ui/sidebar';
import {
  badgeTooltip,
  NAV,
  NAV_GROUPS,
  navEntryForPath,
  type NavBadgeCounters,
  type NavEntry,
} from '@/lib/nav';
import { cn } from '@/lib/utils';
import { REMBRIC_VERSION } from '@/lib/version';

/**
 * The dashboard's primary navigation — Midday's `sidebar.tsx` + `main-menu.tsx`
 * structure (`/tmp/midday-review/apps/dashboard/src/components/`) with Rembric's
 * nav table and palette. The reference is `apps/web/mockup.html`.
 *
 * Structure, not markup, is what is copied:
 *
 *  - The rail is `fixed top-0 h-screen` and `70px` wide; hovering it is the only
 *    deskop toggle and expands it to `240px`. It overlays the content (which
 *    reserves a static `70px` to the left) instead of pushing it, so the page
 *    never reflows while the pointer travels down the nav.
 *  - The logo bar is an absolutely-positioned `70px` strip whose width follows
 *    the rail, with the mark pinned at `left-[22px]` and the wordmark at
 *    `left-[58px]` so neither moves as the rail grows under them.
 *  - Every nav item is three layers: a background div that grows from a `40px`
 *    square to the full pill width, an absolutely-positioned icon at
 *    `left-[15px]` that never moves, and an absolutely-positioned label at
 *    `left-[55px]` revealed by the expansion. A row of plain flex children would
 *    move the icon sideways as the width animates; the absolute layers are the
 *    whole point of the pattern.
 *  - The brand block *is* the logo bar: the mark, the wordmark and the running
 *    version, and nothing else. Midday keeps its brand in the bottom slot
 *    beside a team dropdown, but Rembric has no teams, and a second brand block
 *    down there only duplicated the wordmark — the bottom slot is the sign-out.
 *    The release state is deliberately NOT rendered here: two versions in the
 *    stripped rail read as broken, and `/dashboard/update` owns that status.
 *  - The two nav groups are divided by a rule rather than by the `Admin`
 *    caption alone: the caption is one of the labels that collapses away, and
 *    without the rule a collapsed rail reads as one nine-item column.
 *
 * The rail's own transition — its width plus the two theme colours — is declared
 * in `src/styles/glass.css` on `[data-slot='app-sidebar']`, beside the glass that
 * needs the colours transitioned.
 *
 * Two Rembric divergences from the reference, both deliberate: the label and the
 * icon of the active item wear `--brand-accent` rather than `--primary`, because
 * lime is a fill in this palette and `--brand-accent` is the same hue darkened
 * to clear AA as text on the light surfaces; and the nav wrapper scrolls when the
 * viewport is shorter than the nine items, so the sign-out below them cannot be
 * clipped out of reach.
 *
 * `SidebarProvider` still owns the narrow-viewport sheet (the header's trigger
 * opens it) — it is the only navigation path on a phone, where a hover-expand
 * rail has nothing to expand from. Its desktop open/collapse state is unused:
 * the rail in this file is the raw Midday one, not shadcn's `Sidebar`.
 */

/** Midday's `duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]`, named once. */
const RAIL_TRANSITION = 'duration-200 ease-[cubic-bezier(0.4,0,0.2,1)]';
const RAIL_WIDTH_TRANSITION = `transition-[width] ${RAIL_TRANSITION}`;
const PILL_TRANSITION = `transition-all ${RAIL_TRANSITION}`;

/** The label fade the reference pairs with the expansion. */
const LABEL_FADE = 'transition-opacity duration-150 delay-100';

/**
 * The release state the layout resolved from `UpdateCheckService`. It is a prop
 * and not a read of the service in this client module because the service is
 * stateful — it memoizes the GitHub response, the ETag and the 24h window on
 * `globalThis` — and reaches the network.
 *
 * The rail no longer renders it — the brand block is logo, wordmark and version
 * only. The prop stays in the contract because `dashboard/layout.tsx` is a
 * server component that resolves the release once and hands it down, and the
 * rail is not the only consumer of that resolution.
 */
export type SidebarUpdate =
  | { readonly state: 'disabled' }
  | { readonly state: 'up-to-date' }
  | { readonly state: 'available'; readonly latestVersion: string };

export function AppSidebar({
  counters = {},
}: {
  counters?: NavBadgeCounters;
  /** Resolved server-side: `UpdateCheckService` is stateful and reaches the network. */
  update: SidebarUpdate;
}) {
  const [isExpanded, setIsExpanded] = useState(false);
  const { openMobile, setOpenMobile } = useSidebar();
  const activeKey = navEntryForPath(usePathname())?.key;

  return (
    <>
      <aside
        data-slot="app-sidebar"
        data-expanded={isExpanded}
        aria-label="Primary"
        className={cn(
          'fixed top-0 z-50 hidden h-screen shrink-0 flex-col items-center justify-between rounded-tl-[10px] rounded-bl-[10px] border-r border-border bg-background pb-4 md:flex',
          isExpanded ? 'w-[240px]' : 'w-[70px]',
        )}
        onMouseEnter={() => setIsExpanded(true)}
        onMouseLeave={() => setIsExpanded(false)}
      >
        <div
          data-slot="sidebar-logo"
          className={cn(
            'absolute top-0 left-0 z-[1] flex h-[70px] items-center justify-center overflow-hidden border-b border-border bg-background',
            RAIL_WIDTH_TRANSITION,
            isExpanded ? 'w-full' : 'w-[69px]',
          )}
        >
          <BrandMark className="absolute left-[22px]" />
          <div
            className={cn(
              'absolute inset-y-0 right-2 left-[58px] flex items-center',
              LABEL_FADE,
              isExpanded ? 'opacity-100' : 'opacity-0',
            )}
          >
            <BrandText />
          </div>
        </div>

        <div className="mb-3 flex min-h-0 w-full flex-1 flex-col overflow-y-auto border-b border-border pt-[70px]">
          <NavList isExpanded={isExpanded} activeKey={activeKey} counters={counters} />
        </div>

        <NavUser isExpanded={isExpanded} />
      </aside>

      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent side="left" className="w-[240px] gap-0 bg-background p-0">
          <SheetHeader className="sr-only">
            <SheetTitle>Navigation</SheetTitle>
            <SheetDescription>The dashboard's primary navigation.</SheetDescription>
          </SheetHeader>
          <div className="flex h-full flex-col justify-between pb-4">
            <div
              data-slot="sidebar-logo"
              className="flex h-[70px] shrink-0 items-center gap-3 overflow-hidden border-b border-border px-[22px]"
            >
              <BrandMark />
              <BrandText />
            </div>
            <div className="mt-4 flex min-h-0 w-full flex-1 flex-col overflow-y-auto">
              <NavList
                isExpanded
                activeKey={activeKey}
                counters={counters}
                onNavigate={() => setOpenMobile(false)}
              />
            </div>
            <NavUser isExpanded />
          </div>
        </SheetContent>
      </Sheet>
    </>
  );
}

/**
 * The 28px brand mark — the actual Rembric logo, the same transparent PNG the
 * login card wears, not the initial it used to be drawn as a lime tile with.
 */
function BrandMark({ className }: { className?: string }) {
  return (
    <Link
      href="/dashboard"
      title="REMBRIC — go to the overview"
      className={cn('flex size-7 shrink-0 items-center justify-center', className)}
    >
      <img
        src="/dashboard/assets/logo-transparent.png"
        alt=""
        aria-hidden="true"
        className="size-7"
      />
      <span className="sr-only">Rembric — go to the overview</span>
    </Link>
  );
}

/**
 * The wordmark and the running version — the rail's brand block, revealed with
 * the rail. It is the only brand block in the rail: the one the footer used to
 * carry is gone.
 *
 * No release state renders beside the version: a badge reading `UPDATE v0.28.8`
 * next to `v0.0.0` is two versions in a cramped strip, and the rail is the wrong
 * place to act on one — `/dashboard/update` is where the status is read and the
 * upgrade is run.
 */
function BrandText() {
  return (
    <span data-slot="sidebar-brand" className="flex min-w-0 flex-col leading-tight">
      <span className="truncate font-display text-[0.8rem] font-semibold tracking-[0.18em]">
        REMBRIC
      </span>
      <span className="truncate font-mono text-[0.65rem] text-muted-foreground">
        v{REMBRIC_VERSION}
      </span>
    </span>
  );
}

function NavList({
  isExpanded,
  activeKey,
  counters,
  onNavigate,
}: {
  isExpanded: boolean;
  activeKey: string | undefined;
  counters: NavBadgeCounters;
  onNavigate?: () => void;
}) {
  return (
    <div className="mt-4 w-full">
      {NAV_GROUPS.map((group, index) => {
        const entries = NAV.filter((entry) => entry.group === group.key);
        if (entries.length === 0) return null;

        return (
          <div key={group.key}>
            {index === 0 ? null : (
              <div className="px-[15px] py-2">
                <Separator data-slot="nav-group-separator" />
              </div>
            )}
            {group.heading === null ? null : (
              <p
                data-slot="nav-heading"
                className={cn(
                  'px-[22px] pt-4 pb-1 text-[0.6rem] font-semibold tracking-[0.1em] text-muted-foreground uppercase',
                  LABEL_FADE,
                  isExpanded ? 'opacity-100' : 'opacity-0',
                )}
              >
                {group.heading}
              </p>
            )}
            <nav aria-label={group.key === 'admin' ? 'Administration' : 'Main'}>
              <ul className="flex w-full flex-col gap-2">
                {entries.map((entry) => (
                  <NavItem
                    key={entry.key}
                    entry={entry}
                    isActive={entry.key === activeKey}
                    isExpanded={isExpanded}
                    badge={badgeFor(entry, counters)}
                    onNavigate={onNavigate}
                  />
                ))}
              </ul>
            </nav>
          </div>
        );
      })}
    </div>
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
  isExpanded,
  badge,
  onNavigate,
}: {
  entry: NavEntry;
  isActive: boolean;
  isExpanded: boolean;
  badge: NavItemBadge | null;
  onNavigate?: () => void;
}) {
  const Icon = entry.icon;

  return (
    <li className="group">
      <Link
        href={entry.href}
        prefetch
        onClick={onNavigate}
        data-slot="nav-item"
        data-nav-key={entry.key}
        data-active={isActive}
        aria-current={isActive ? 'page' : undefined}
        // Named explicitly because the visible label only exists while the rail
        // is expanded: a collapsed item would otherwise be an unnamed link.
        aria-label={entry.label}
        title={badge?.title}
        className="block"
      >
        <div className="relative">
          {/* The background, from a 40px square to the full pill. */}
          <div
            data-slot="nav-bg"
            className={cn(
              'ml-[15px] mr-[15px] h-[40px] border border-transparent',
              PILL_TRANSITION,
              isActive && 'border-active-border bg-active-bg',
              isExpanded ? 'w-[calc(100%-30px)]' : 'w-[40px]',
            )}
          />

          {/* The icon, pinned to the rail's edge in both states. */}
          <div
            data-slot="nav-icon"
            className={cn(
              'pointer-events-none absolute top-0 left-[15px] flex h-[40px] w-[40px] items-center justify-center text-foreground transition-colors group-hover:text-brand-accent',
              isActive && 'text-brand-accent',
            )}
          >
            <Icon className="size-5" />
          </div>

          {isExpanded ? (
            <div
              data-slot="nav-label"
              className="pointer-events-none absolute top-0 right-[4px] left-[55px] flex h-[40px] items-center"
            >
              <span
                className={cn(
                  'overflow-hidden text-[0.8rem] font-medium whitespace-nowrap text-muted-foreground transition-colors group-hover:text-brand-accent',
                  badge !== null && 'pr-6',
                  isActive && 'text-brand-accent',
                )}
              >
                {entry.label}
              </span>
            </div>
          ) : null}

          {isExpanded && badge !== null ? (
            <div
              data-slot="nav-badge"
              className="pointer-events-none absolute top-0 right-[4px] flex h-[40px] items-center"
            >
              <span className="rounded-full bg-warn px-1.5 font-mono text-[0.6rem] font-semibold text-warn-foreground tabular-nums">
                {badge.count}
              </span>
            </div>
          ) : null}
        </div>
      </Link>
    </li>
  );
}
