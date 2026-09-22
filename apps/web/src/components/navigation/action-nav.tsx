'use client';

import { Moon, Sun } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useMemo } from 'react';

import {
  ExpandableActionBar,
  type ExpandableActionBarItem,
} from '@/components/motion/expandable-action-bar';
import { NAV, navEntryForPath, type NavEntry } from '@/lib/nav';
import { cn } from '@/lib/utils';

export interface NavBadges {
  readonly needsReview?: number;
  readonly pendingJudgments?: number;
}

const NAV_BY_KEY = new Map(NAV.map((entry) => [entry.key, entry]));

const BAR_BOX = 'h-[68px]';

export function ActionNav({
  children,
  version,
  themeStorageKey,
  badges = {},
}: {
  children: ReactNode;
  version: string;
  themeStorageKey: string;
  badges?: NavBadges;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const activeKey = navEntryForPath(pathname)?.key;

  const items = useMemo<ExpandableActionBarItem[]>(
    () =>
      NAV.map((entry) => ({
        id: entry.key,
        label: entry.label,
        icon: <entry.icon className="size-4" />,
        badge: badgeCount(entry, badges),
      })),
    [badges],
  );

  const onAction = useCallback(
    (item: ExpandableActionBarItem) => {
      const entry = NAV_BY_KEY.get(item.id);
      if (entry) router.push(entry.href);
    },
    [router],
  );

  if (pathname === '/dashboard/login') return <>{children}</>;

  return (
    <>
      <header
        className={cn(BAR_BOX, 'fixed inset-x-0 top-0 z-30 border-b border-border bg-background')}
      >
        <div className="mx-auto flex h-full w-full max-w-[1320px] items-center gap-3 px-5">
          <Link
            href="/dashboard"
            aria-label="Rembric"
            className="flex shrink-0 items-center gap-2 text-[15px] font-semibold tracking-[-.05em]"
          >
            <img
              src="/favicon.png"
              alt=""
              aria-hidden="true"
              className="size-6 rounded-md object-cover"
            />
            <span aria-hidden="true">embric</span>
            <span className="sr-only">Rembric</span>
          </Link>
          <span className="hidden text-[10px] text-muted-foreground sm:block">v{version}</span>

          <ExpandableActionBar
            items={items}
            activeId={activeKey}
            onAction={onAction}
            expandOnHover
            collapseDelay={300}
            className="min-w-0 flex-1"
          />

          <ThemeToggle storageKey={themeStorageKey} />
        </div>
      </header>
      <div aria-hidden="true" className={BAR_BOX} />
      <div className="mx-auto w-full max-w-[1320px] px-5 py-5">{children}</div>
    </>
  );
}

function badgeCount(entry: NavEntry, badges: NavBadges): string | undefined {
  const count = entry.badgeKey ? badges[entry.badgeKey] : undefined;
  return count === undefined || count <= 0 ? undefined : String(count);
}

function ThemeToggle({ storageKey }: { storageKey: string }) {
  return (
    <button
      type="button"
      data-theme-toggle
      aria-label="Toggle colour theme"
      title="Toggle colour theme"
      onClick={() => {
        toggleTheme(storageKey);
      }}
      className="grid size-8 shrink-0 place-items-center rounded-lg border border-border text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
    >
      <Moon aria-hidden className="size-4 dark:hidden" />
      <Sun aria-hidden className="hidden size-4 dark:block" />
    </button>
  );
}

function toggleTheme(storageKey: string): void {
  const root = document.documentElement;
  const next = root.classList.contains('dark') ? 'light' : 'dark';
  root.classList.toggle('dark', next === 'dark');
  try {
    localStorage.setItem(storageKey, next);
  } catch {}
}
