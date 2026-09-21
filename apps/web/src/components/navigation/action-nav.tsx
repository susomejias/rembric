'use client';

import { Moon, Sun } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useMemo } from 'react';

import {
  ExpandableActionBar,
  type ExpandableActionBarItem,
} from '@/components/motion/expandable-action-bar';
import { NAV, navEntryForPath } from '@/lib/nav';
import { cn } from '@/lib/utils';

/** Counts the bar paints as a badge, each keyed to the one nav entry that resolves it. */
export interface NavBadges {
  readonly liveSessions?: number;
  readonly needsReview?: number;
  readonly pendingJudgments?: number;
}

const BADGE_SOURCE: Record<string, keyof NavBadges> = {
  sessions: 'liveSessions',
  memories: 'needsReview',
  judgments: 'pendingJudgments',
};

const NAV_BY_KEY = new Map(NAV.map((entry) => [entry.key, entry]));

/**
 * The bar is `fixed`, so it is out of flow and cannot clear the content by
 * itself; the spacer rendered after it is what does. Header and spacer repeat
 * the same literal class because the only failure here is the two drifting
 * apart, which overlaps the first row of a view with the bar and nothing else.
 */
const BAR_BOX = 'h-[68px]';

/**
 * The dashboard navigation: Spectrum UI's expandable action bar, fixed to the
 * top of the viewport, with the brand mark at its left and the theme toggle at
 * its right.
 *
 * The active entry and the navigation target both come from `lib/nav`: the item
 * `id` is the nav entry's `key`, so the highlighted action and the route a click
 * resolves to cannot disagree with the table.
 *
 * It also owns the content column, and that is deliberate rather than an
 * oversight: `/dashboard/login` is a full-bleed screen that must keep rendering
 * without the frame, and no layout can opt out of its parent or read the
 * pathname, so the only place the exception can live is here.
 */
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
        badge: badgeCount(entry.key, badges),
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

  // The sign-in screen covers the viewport and has no chrome, content column
  // included: its own `min-h-screen` main is the whole page, and padding it
  // would inset it against the page canvas and add a scrollbar.
  if (pathname === '/dashboard/login') return <>{children}</>;

  return (
    <>
      <header
        className={cn(
          BAR_BOX,
          'fixed inset-x-0 top-0 z-30 border-b border-border bg-background/95 backdrop-blur',
        )}
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

function badgeCount(key: string, badges: NavBadges): string | undefined {
  const source = BADGE_SOURCE[key];
  const count = source ? badges[source] : undefined;
  return count === undefined || count <= 0 ? undefined : String(count);
}

/**
 * `.dark` on `<html>` is the only theme state; this button removes it and
 * records the choice. There is deliberately no React state and no `useEffect`
 * read of the class: the icon is selected by the `dark:` variant, so the server
 * and the client always render the same markup and the button cannot hydrate
 * against a theme the document already has.
 */
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
  } catch {
    // A storage that refuses to be written (private mode, disabled cookies) must
    // not break the toggle: the class is already applied, only the preference is
    // lost on the next load.
  }
}
