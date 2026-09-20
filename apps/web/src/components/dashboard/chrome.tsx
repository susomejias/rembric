'use client';

import { ChevronsUpDown, Menu, Moon, MoreHorizontal, Sun, X } from 'lucide-react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';

import { EYEBROW } from './ui';

import { NAV, NAV_GROUPS, navEntryForPath } from '@/lib/nav';
import { cn } from '@/lib/utils';

export interface ChromeProject {
  readonly slug: string;
  readonly name: string;
}

/**
 * The dashboard frame: a fixed 238px rail with the project-scope selector, the
 * two nav groups, the theme toggle and the workspace footer, and a content
 * column that reserves the rail's width with `lg:pl-[238px]`.
 *
 * Three things are deliberately *not* state here:
 *
 * - **The active nav item.** It is derived from the pathname, so a deep link and
 *   a click agree, and the topbar title cannot drift from the highlighted row.
 * - **The theme.** `.dark` on `<html>` (server-rendered) and `.light` (swapped in
 *   before first paint) are the only theme state; the toggle flips the class and
 *   records the choice. Reading it in React would be one frame too late, so the
 *   icon is selected by the `dark:`/`light:` variants instead.
 * - **The project scope label.** The rail's dropdown carries real projects and
 *   writes the choice into the URL, where the memories view reads it as its
 *   `project` filter — the same param the retired sidebar's scope pin fed. The
 *   label therefore starts at the neutral value on every navigation rather than
 *   claiming a scope the current view is not filtered by.
 *
 * `/dashboard/login` renders without the frame: the sign-in screen covers the
 * viewport and has no chrome. No layout can opt out of its parent, so the check
 * lives here.
 */
export function DashboardChrome({
  children,
  projects,
  liveSessions,
  version,
  themeStorageKey,
}: {
  children: ReactNode;
  projects: readonly ChromeProject[];
  liveSessions: number;
  version: string;
  themeStorageKey: string;
}) {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scopeOpen, setScopeOpen] = useState(false);

  if (pathname === '/dashboard/login') return <>{children}</>;

  const active = navEntryForPath(pathname)?.label ?? 'Overview';

  return (
    <main className="min-h-screen bg-(--surface-page) text-(--body-ink)">
      <aside
        className={cn(
          'fixed inset-y-0 left-0 z-20 flex w-[238px] flex-col overflow-y-auto border-r border-(--ink)/[7%] bg-(--surface-rail) px-4 py-5 transition-transform lg:translate-x-0',
          mobileOpen ? 'translate-x-0' : '-translate-x-full',
        )}
      >
        <div className="flex items-center justify-between px-2">
          <Link
            href="/dashboard"
            aria-label="Rembric"
            className="flex items-center gap-2 text-[17px] font-semibold tracking-[-.05em]"
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
          <button
            type="button"
            className="lg:hidden"
            onClick={() => {
              setMobileOpen(false);
            }}
            aria-label="Close navigation"
          >
            <X className="size-5" />
          </button>
        </div>

        <ScopeSelector projects={projects} open={scopeOpen} onOpenChange={setScopeOpen} />

        <nav className="mt-4 flex flex-col gap-1">
          {NAV_GROUPS.map((group) => (
            <div
              key={group.key}
              className={cn('flex flex-col gap-1', group.key === 'admin' && 'mt-7')}
            >
              <p className={cn('px-3 pb-3 text-(--ink)/38 font-semibold', EYEBROW)}>
                {group.heading}
              </p>
              {NAV.filter((entry) => entry.group === group.key).map((entry) => {
                const isActive = entry.label === active;
                return (
                  <Link
                    key={entry.key}
                    href={entry.href}
                    onClick={() => {
                      setMobileOpen(false);
                    }}
                    aria-current={isActive ? 'page' : undefined}
                    className={cn(
                      'flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm',
                      isActive
                        ? 'bg-(--accent-ink)/10 text-(--accent-ink)'
                        : 'text-(--ink)/50 hover:bg-(--ink)/[4%]',
                    )}
                  >
                    <entry.icon className="size-4" />
                    {entry.label}
                    {entry.key === 'sessions' && liveSessions > 0 ? (
                      <span className="ml-auto text-[10px] text-(--accent-ink-strong)">
                        {liveSessions} live
                      </span>
                    ) : null}
                  </Link>
                );
              })}
            </div>
          ))}
        </nav>

        <Link
          href="/dashboard/login"
          className="mt-4 flex w-full items-center gap-2 border-t border-(--ink)/[7%] pt-4 text-left transition-colors hover:text-(--accent-ink)"
        >
          <div className="grid size-7 place-items-center rounded-full bg-[#334938] text-[10px] text-(--accent-ink)">
            R
          </div>
          <div>
            <p className="text-xs">Rembric workspace</p>
            <p className="text-[10px] text-(--ink)/45">v{version}</p>
          </div>
          <MoreHorizontal className="ml-auto size-4 text-(--ink)/38" />
        </Link>
      </aside>

      <div className="lg:pl-[238px]">
        <header className="flex min-h-[56px] flex-wrap items-center justify-between gap-3 border-b border-(--ink)/[6%] bg-(--surface-topbar) px-5 py-3 md:px-8">
          <div className="flex items-center gap-3">
            <button
              type="button"
              className="lg:hidden"
              onClick={() => {
                setMobileOpen(true);
              }}
              aria-label="Open navigation"
            >
              <Menu className="size-5" />
            </button>
            <span className="text-sm font-medium">{active}</span>
            <span className="hidden text-xs text-(--ink)/25 sm:block">/ Personal workspace</span>
          </div>
          <ThemeToggle storageKey={themeStorageKey} />
        </header>
        {children}
      </div>
    </main>
  );
}

/**
 * The project-scope selector. Selecting a project navigates to the memories
 * view's `project` filter — the one listing that resolve a scope today — so the
 * control is a real read rather than a label the app cannot honor.
 */
function ScopeSelector({
  projects,
  open,
  onOpenChange,
}: {
  projects: readonly ChromeProject[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();

  return (
    <div className="relative mt-4">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-label="Change project scope"
        onClick={() => {
          onOpenChange(!open);
        }}
        className="flex w-full items-center gap-2 rounded-lg border border-(--ink)/[6.5%] bg-(--ink)/[3.5%] px-3 py-2 text-left transition-colors hover:bg-(--ink)/[6%]"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-medium text-(--ink)/85">All projects</span>
          <span className="block text-[9px] text-(--ink)/38">Project scope</span>
        </span>
        <ChevronsUpDown className="size-3.5 text-(--ink)/38" />
      </button>
      {open ? (
        <div
          role="listbox"
          aria-label="Project scope options"
          className="absolute inset-x-0 top-[calc(100%+8px)] z-30 overflow-hidden rounded-xl border border-(--ink)/[10%] bg-(--surface-rail) p-1 shadow-2xl shadow-black/40"
        >
          <button
            type="button"
            role="option"
            aria-selected="true"
            onClick={() => {
              onOpenChange(false);
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
                onOpenChange(false);
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
      className="grid size-8 place-items-center rounded-lg border border-(--ink)/[12%] text-(--ink)/65 transition-colors hover:bg-(--ink)/[6%] hover:text-(--ink)"
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
