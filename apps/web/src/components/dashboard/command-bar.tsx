'use client';

import { LogOut, Menu } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Fragment, useState, type ReactNode } from 'react';

import { updaterReadState, type UpdaterInput } from './app-sidebar';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import {
  badgeTooltip,
  isChromeFreePath,
  NAV,
  navEntryForPath,
  type NavBadgeCounters,
  type NavEntry,
} from '@/lib/nav';
import { cn } from '@/lib/utils';

const PRIMARY_KEYS = new Set([
  'overview',
  'memories',
  'sessions',
  'judgments',
  'entities',
  'projects',
  'tokens',
]);

function badgeFor(entry: NavEntry, counters: NavBadgeCounters): number {
  const breakdown = entry.badgeKey ? counters[entry.badgeKey] : undefined;
  if (!entry.badgeKey || !breakdown || breakdown.total <= 0) return 0;
  return breakdown.total;
}

function badgeTitle(entry: NavEntry, counters: NavBadgeCounters): string | undefined {
  const breakdown = entry.badgeKey ? counters[entry.badgeKey] : undefined;
  if (!entry.badgeKey || !breakdown || breakdown.total <= 0) return undefined;
  return badgeTooltip(entry.badgeKey, breakdown);
}

export function CommandFrame({
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
    <CommandBar counters={counters} version={version} updater={updater}>
      <main
        key={pathname}
        className="mx-auto w-full max-w-6xl animate-in px-4 pt-28 pb-12 fade-in duration-300 motion-reduce:animate-none sm:px-6"
      >
        {children}
      </main>
      <footer className="mx-auto w-full max-w-6xl px-4 pb-8 sm:px-6">
        <div className="flex flex-col items-center justify-between gap-2 border-t border-border pt-5 text-xs text-muted-foreground sm:flex-row">
          <div className="flex items-center gap-2">
            <img
              src="/dashboard/assets/logo-transparent.png"
              alt=""
              aria-hidden="true"
              className="size-4"
            />
            <span className="font-medium text-foreground">rembric</span>
            <span className="font-mono text-[10px]">v{version}</span>
          </div>
          <span>Persistent memory for coding agents · © {new Date().getFullYear()}</span>
        </div>
      </footer>
    </CommandBar>
  );
}

function CommandBar({
  children,
  counters,
  version,
  updater,
}: {
  children: ReactNode;
  counters: NavBadgeCounters;
  version: string;
  updater: UpdaterInput;
}) {
  const pathname = usePathname();
  const activeKey = navEntryForPath(pathname)?.key;
  const [mobileOpen, setMobileOpen] = useState(false);

  const primary = NAV.filter((entry) => PRIMARY_KEYS.has(entry.key));
  const more = NAV.filter((entry) => !PRIMARY_KEYS.has(entry.key));
  const updaterState = updaterReadState(updater);
  const updaterAvailable = updaterState.kind === 'available';

  return (
    <TooltipProvider delayDuration={100}>
      <div className="min-h-screen bg-background">
        <div
          aria-hidden="true"
          className="pointer-events-none fixed inset-x-0 top-0 z-0 h-80 bg-[radial-gradient(640px_260px_at_50%_-60px,rgba(198,242,78,0.09),transparent_70%)]"
        />
        <div className="pointer-events-none fixed inset-x-0 top-0 z-30 flex justify-center px-4 pt-4">
          <header className="pointer-events-auto flex h-13 w-full max-w-4xl items-center gap-1 rounded-2xl border border-border bg-card/90 px-2.5 shadow-lg shadow-black/20 backdrop-blur">
            <Link
              href="/dashboard"
              className="flex shrink-0 items-center rounded-lg px-2 py-2"
              title="Rembric — go to the overview"
            >
              <img
                src="/dashboard/assets/logo-transparent.png"
                alt="Rembric"
                className="size-6 shrink-0"
              />
            </Link>

            <nav aria-label="Primary" className="hidden min-w-0 items-center gap-0.5 md:flex">
              {primary.map((entry) => {
                const badge = badgeFor(entry, counters);
                const badgeText = badgeTitle(entry, counters);
                const isActive = entry.key === activeKey;
                const link = (
                  <Link
                    href={entry.href}
                    prefetch
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm transition-colors',
                      isActive
                        ? 'bg-accent font-medium text-foreground'
                        : 'text-muted-foreground hover:text-foreground',
                    )}
                  >
                    {entry.label}
                    {badge > 0 ? <NavBadge count={badge} /> : null}
                  </Link>
                );
                if (badgeText === undefined) return <Fragment key={entry.key}>{link}</Fragment>;
                return (
                  <Tooltip key={entry.key}>
                    <TooltipTrigger asChild>{link}</TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      sideOffset={10}
                      collisionPadding={16}
                      className="flex w-fit max-w-md flex-col items-stretch gap-1 rounded-lg border border-border bg-popover px-3 py-2 text-left text-foreground shadow-lg shadow-black/40 [&>svg]:hidden"
                    >
                      <BadgeTooltipText text={badgeText} />
                    </TooltipContent>
                  </Tooltip>
                );
              })}
              <NavMoreMenu
                entries={more}
                activeKey={activeKey}
                counters={counters}
                version={version}
              />
            </nav>

            <div className="ml-auto flex items-center gap-1">
              <UpdaterDot state={updaterState} available={updaterAvailable} />
              <LogoutMenu version={version} />
              <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
                <SheetTrigger
                  aria-label="Open navigation"
                  className="flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground md:hidden"
                >
                  <Menu aria-hidden="true" className="size-5" />
                </SheetTrigger>
                <SheetContent side="right" className="w-72 border-border bg-card p-0">
                  <SheetHeader className="border-b border-border px-4 py-4">
                    <SheetTitle className="flex items-center gap-2 text-sm font-semibold">
                      {' '}
                      <img
                        src="/dashboard/assets/logo-transparent.png"
                        alt=""
                        aria-hidden="true"
                        className="size-5 shrink-0"
                      />
                      rembric
                    </SheetTitle>
                  </SheetHeader>
                  <MobileNav
                    entries={NAV}
                    activeKey={activeKey}
                    counters={counters}
                    onNavigate={() => setMobileOpen(false)}
                  />
                </SheetContent>
              </Sheet>
            </div>
          </header>
        </div>
        {children}
      </div>
    </TooltipProvider>
  );
}

function BadgeTooltipText({ text }: { text: string }) {
  const [head, ...projects] = text.split('\n');
  return (
    <div className="flex flex-col gap-0.5">
      <p className="text-xs text-foreground">{head}</p>
      {projects.map((line) => (
        <p key={line} className="font-mono text-[10px] text-muted-foreground">
          {line}
        </p>
      ))}
    </div>
  );
}

function NavBadge({ count }: { count: number }) {
  return (
    <span className="rounded-full bg-primary/15 px-1.5 py-px font-mono text-[10px] leading-4 text-primary tabular-nums">
      {count}
    </span>
  );
}

function NavMoreMenu({
  entries,
  activeKey,
  counters,
  version,
}: {
  entries: readonly NavEntry[];
  activeKey: string | undefined;
  counters: NavBadgeCounters;
  version: string;
}) {
  const moreActive = entries.some((entry) => entry.key === activeKey);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'rounded-lg px-2.5 py-1.5 text-sm transition-colors',
          moreActive
            ? 'bg-accent font-medium text-foreground'
            : 'text-muted-foreground hover:text-foreground',
        )}
      >
        More
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="border-border bg-popover">
        <DropdownMenuLabel className="font-mono text-[10px] tracking-[.14em] text-muted-foreground">
          v{version}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-border" />
        {entries.map((entry) => {
          const badge = badgeFor(entry, counters);
          const Icon = entry.icon;
          return (
            <DropdownMenuItem
              key={entry.key}
              asChild
              className={cn('gap-2', entry.key === activeKey && 'text-primary')}
            >
              <Link href={entry.href} prefetch>
                <Icon aria-hidden="true" className="size-4" />
                {entry.label}
                {badge > 0 ? <NavBadge count={badge} /> : null}
              </Link>
            </DropdownMenuItem>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MobileNav({
  entries,
  activeKey,
  counters,
  onNavigate,
}: {
  entries: readonly NavEntry[];
  activeKey: string | undefined;
  counters: NavBadgeCounters;
  onNavigate: () => void;
}) {
  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5 px-3 py-3">
      {entries.map((entry) => {
        const badge = badgeFor(entry, counters);
        const Icon = entry.icon;
        const isActive = entry.key === activeKey;
        return (
          <Link
            key={entry.key}
            href={entry.href}
            prefetch
            onClick={onNavigate}
            aria-current={isActive ? 'page' : undefined}
            className={cn(
              'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm',
              isActive
                ? 'bg-accent font-medium text-primary'
                : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Icon aria-hidden="true" className="size-4" />
            {entry.label}
            {badge > 0 ? <NavBadge count={badge} /> : null}
          </Link>
        );
      })}
    </nav>
  );
}

function UpdaterDot({
  state,
  available,
}: {
  state: ReturnType<typeof updaterReadState>;
  available: boolean;
}) {
  const label =
    state.kind === 'available'
      ? `Update available: v${state.latestVersion}`
      : 'Release status and updates';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Link
          href="/dashboard/update"
          aria-label={label}
          className="flex size-9 items-center justify-center rounded-lg text-muted-foreground hover:text-foreground"
        >
          <span
            aria-hidden="true"
            className={cn(
              'size-2 rounded-full',
              available ? 'animate-pulse bg-primary' : 'bg-muted-foreground',
            )}
          />
        </Link>
      </TooltipTrigger>
      <TooltipContent
        side="bottom"
        sideOffset={10}
        className="rounded-lg border border-border bg-popover px-3 py-2 text-xs text-foreground shadow-lg shadow-black/40 [&>svg]:hidden"
      >
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

function LogoutMenu({ version }: { version: string }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="Account"
        className="mr-1 flex size-7 items-center justify-center rounded-full bg-input text-xs font-semibold text-foreground"
      >
        S
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="border-border bg-popover">
        <DropdownMenuLabel className="font-mono text-[10px] tracking-[.14em] text-muted-foreground">
          v{version}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-border" />
        <DropdownMenuItem asChild>
          <form action="/dashboard/logout" method="post" className="w-full">
            <button type="submit" className="flex w-full cursor-pointer items-center gap-2 text-sm">
              <LogOut aria-hidden="true" className="size-4" />
              Sign out
            </button>
          </form>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
