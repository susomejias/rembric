'use client';

import { LogOut, Menu, MoreHorizontal } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, type ReactNode } from 'react';

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
import { TooltipProvider } from '@/components/ui/tooltip';
import { isChromeFreePath, NAV, navEntryForPath, type NavEntry } from '@/lib/nav';
import { cn } from '@/lib/utils';

function formatCompact(value: number): string {
  if (value < 1000) return String(value);
  const k = (value / 1000).toFixed(1);
  return `${k.endsWith('.0') ? k.slice(0, -2) : k}k`;
}

const PRIMARY_KEYS = new Set([
  'overview',
  'memories',
  'sessions',
  'judgments',
  'entities',
  'projects',
]);

function NavMoreMenu({
  entries,
  activeKey,
  version,
}: {
  entries: readonly NavEntry[];
  activeKey: string | undefined;
  version: string;
}) {
  const moreActive = entries.some((entry) => entry.key === activeKey);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label="More pages"
        className={cn(
          'flex size-9 items-center justify-center rounded-lg transition-colors',
          moreActive ? 'bg-accent text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <MoreHorizontal aria-hidden="true" className="size-5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="border-border bg-popover">
        <DropdownMenuLabel className="font-mono text-[10px] tracking-[.14em] text-muted-foreground">
          v{version}
        </DropdownMenuLabel>
        <DropdownMenuSeparator className="bg-border" />
        {entries.map((entry) => {
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
  onNavigate,
}: {
  entries: readonly NavEntry[];
  activeKey: string | undefined;
  onNavigate: () => void;
}) {
  return (
    <nav aria-label="Primary" className="flex flex-col gap-0.5 px-3 py-3">
      {entries.map((entry) => {
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
          </Link>
        );
      })}
    </nav>
  );
}

function UpdaterChip({
  state,
  version,
}: {
  state: ReturnType<typeof updaterReadState>;
  version: string;
}) {
  const available = state.kind === 'available';
  const label = available
    ? `Update available: v${state.latestVersion}`
    : `Running v${version} — release status and updates`;
  return (
    <Link
      href="/dashboard/update"
      title={label}
      aria-label={label}
      className={cn(
        'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-[10px] tabular-nums transition-colors',
        available
          ? 'border-primary/40 bg-primary/10 text-primary hover:bg-primary/20'
          : 'border-border text-muted-foreground hover:text-foreground',
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          'size-1.5 rounded-full',
          available ? 'animate-pulse bg-primary' : 'bg-muted-foreground',
        )}
      />
      {available ? `v${state.latestVersion}` : `v${version}`}
    </Link>
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

export function CommandFrame({
  children,
  totals = {},
  version,
  updater,
}: {
  children: ReactNode;
  totals?: Record<string, number>;
  version: string;
  updater: UpdaterInput;
}) {
  const pathname = usePathname();

  if (isChromeFreePath(pathname)) return <>{children}</>;

  return (
    <CommandBar totals={totals} version={version} updater={updater}>
      <main className="mx-auto w-full max-w-6xl animate-in px-4 pt-28 pb-12 fade-in duration-300 motion-reduce:animate-none sm:px-6">
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
  totals,
  version,
  updater,
}: {
  children: ReactNode;
  totals: Record<string, number>;
  version: string;
  updater: UpdaterInput;
}) {
  const pathname = usePathname();
  const activeKey = navEntryForPath(pathname)?.key;
  const [mobileOpen, setMobileOpen] = useState(false);

  const primary = NAV.filter((entry) => PRIMARY_KEYS.has(entry.key));
  const more = NAV.filter((entry) => !PRIMARY_KEYS.has(entry.key));
  const updaterState = updaterReadState(updater);

  return (
    <TooltipProvider delayDuration={100}>
      <div className="min-h-screen bg-background">
        <div className="pointer-events-none fixed inset-x-0 top-0 z-30 flex justify-center px-4 pt-4">
          <header className="pointer-events-auto flex h-13 w-full max-w-5xl items-center gap-1.5 rounded-2xl border border-border bg-card/90 px-2.5 shadow-lg shadow-black/20 backdrop-blur">
            <Link
              href="/dashboard"
              className="flex shrink-0 items-center gap-2 rounded-lg px-2 py-2"
              title="Rembric — go to the overview"
            >
              <img
                src="/dashboard/assets/logo-transparent.png"
                alt="Rembric"
                className="size-6 shrink-0"
              />
            </Link>

            <nav aria-label="Primary" className="hidden min-w-0 items-center gap-1 md:flex">
              {primary.map((entry) => {
                const isActive = entry.key === activeKey;
                const total = totals[entry.key];
                return (
                  <Link
                    key={entry.key}
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
                    {total !== undefined ? (
                      <span className="rounded-full bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] leading-4 text-primary tabular-nums">
                        {formatCompact(total)}
                      </span>
                    ) : null}
                  </Link>
                );
              })}
              <NavMoreMenu entries={more} activeKey={activeKey} version={version} />
            </nav>

            <div className="ml-auto flex items-center gap-1.5">
              <UpdaterChip state={updaterState} version={version} />
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
