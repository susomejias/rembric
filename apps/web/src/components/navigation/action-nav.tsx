'use client';

import { ChevronsUpDown, Moon, Sun } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import {
  ExpandableActionBar,
  type ExpandableActionBarItem,
} from '@/components/motion/expandable-action-bar';
import { NAV, navEntryForPath } from '@/lib/nav';
import { cn } from '@/lib/utils';

export interface NavProject {
  readonly slug: string;
  readonly name: string;
}

/** Counts the rail paints as a badge, each keyed to the one nav entry that resolves it. */
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
 * top of the viewport, with the brand mark at its left and the scope selector
 * and theme toggle at its right.
 *
 * The active entry and the navigation target both come from `lib/nav`: the item
 * `id` is the nav entry's `key`, so the highlighted action and the route a click
 * resolves to cannot disagree with the sidebar-era table.
 *
 * It also owns the content column, and that is deliberate rather than an
 * oversight: `/dashboard/login` is a full-bleed screen that must keep rendering
 * without the frame, and no layout can opt out of its parent or read the
 * pathname, so the only place the exception can live is here.
 */
export function ActionNav({
  children,
  projects,
  version,
  themeStorageKey,
  badges = {},
}: {
  children: ReactNode;
  projects: readonly NavProject[];
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
          'fixed inset-x-0 top-0 z-30 border-b border-(--ink)/[7%] bg-(--surface-topbar)/95 backdrop-blur',
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
          <span className="hidden text-[10px] text-(--ink)/38 sm:block">v{version}</span>

          <ExpandableActionBar
            items={items}
            activeId={activeKey}
            onAction={onAction}
            expandOnHover
            collapseDelay={300}
            className="min-w-0 flex-1"
          />

          <ScopeSelector projects={projects} />
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
 * The project-scope selector. Selecting a project navigates to the memories
 * view's `project` filter — the one listing that resolves a scope today — so the
 * control is a real read rather than a label the app cannot honor. The label
 * starts at the neutral value on every navigation rather than claiming a scope
 * the current view is not filtered by.
 */
function ScopeSelector({ projects }: { projects: readonly NavProject[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative shrink-0">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Change project scope"
        onClick={() => {
          setOpen(!open);
        }}
        className="flex items-center gap-2 rounded-lg border border-(--ink)/[6.5%] bg-(--ink)/[3.5%] px-3 py-1.5 text-left transition-colors hover:bg-(--ink)/[6%]"
      >
        <span className="hidden sm:block">
          <span className="block text-[11px] font-medium text-(--ink)/85">All projects</span>
          <span className="block text-[9px] text-(--ink)/38">Project scope</span>
        </span>
        <ChevronsUpDown className="size-3.5 text-(--ink)/38" />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="Project scope options"
          className="absolute right-0 top-[calc(100%+8px)] z-40 w-64 overflow-hidden rounded-xl border border-(--ink)/[10%] bg-(--surface-rail) p-1 shadow-2xl shadow-black/40"
        >
          <button
            type="button"
            role="option"
            aria-selected="true"
            onClick={() => {
              setOpen(false);
              router.push('/dashboard/memories');
            }}
            className="flex w-full items-center rounded-lg px-3 py-2 text-left text-xs text-(--accent-ink) transition-colors hover:bg-(--ink)/[5%]"
          >
            All projects
            <span className="ml-auto text-[10px] text-(--ink)/25">Active</span>
          </button>
          {projects.map((project) => (
            <button
              key={project.slug}
              type="button"
              role="option"
              aria-selected="false"
              onClick={() => {
                setOpen(false);
                router.push(`/dashboard/memories?project=${encodeURIComponent(project.slug)}`);
              }}
              className="flex w-full items-center rounded-lg px-3 py-2 text-left text-xs text-(--ink)/55 transition-colors hover:bg-(--ink)/[5%] hover:text-(--ink)/85"
            >
              <span className="truncate">{project.name}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/**
 * `.dark` on `<html>` is the only theme state; this button swaps it for `.light`
 * and records the choice. There is deliberately no React state and no `useEffect`
 * read of the class: the icon is selected by the `dark:`/`light:` variants, so
 * the server and the client always render the same markup and the button cannot
 * hydrate against a theme the document already has.
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
      className="grid size-8 shrink-0 place-items-center rounded-lg border border-(--ink)/[12%] text-(--ink)/65 transition-colors hover:bg-(--ink)/[6%] hover:text-(--ink)"
    >
      <Moon aria-hidden className="size-4 light:hidden" />
      <Sun aria-hidden className="hidden size-4 light:block" />
    </button>
  );
}

function toggleTheme(storageKey: string): void {
  const root = document.documentElement;
  const next = root.classList.contains('dark') ? 'light' : 'dark';
  root.classList.remove('dark', 'light');
  root.classList.add(next);
  try {
    localStorage.setItem(storageKey, next);
  } catch {
    // A storage that refuses to be written (private mode, disabled cookies) must
    // not break the toggle: the class is already applied, only the preference is
    // lost on the next load.
  }
}
