'use client';

import { Moon, Sun } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import { CommandPaletteTrigger } from './command-palette';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { navEntryForPath } from '@/lib/nav';

/**
 * The slim sticky header over the content column: the trigger, the breadcrumb, the
 * pointer affordance for the command palette (Cmd+K is the keyboard one, and is
 * what `CommandPalette` listens for globally), and the theme toggle.
 *
 * It sits at `z-40`, one layer under the `z-50` rail, so a hover-expanded sidebar
 * slides over the header's left edge instead of the translucent header ghosting
 * through it. The header itself stays legible because `glass-chrome` carries the
 * opaque fallback for engines without `backdrop-filter` (`src/styles/glass.css`).
 *
 * The trigger is narrow-viewport only: on a pointer device the rail expands on
 * hover, so a click-to-toggle would fight the pointer state it is already in. The
 * provider routes the trigger to its mobile sheet, which is the only way to reach
 * the navigation on a phone.
 */

/**
 * The one place the preference is named. `dashboard/layout.tsx` owns this name
 * and passes it down, because a value exported from a `'use client'` module is a
 * client reference: reading it during a server render does not return the string,
 * it throws (`Attempted to call THEME_STORAGE_KEY() from the server`). One
 * declaration, one reader (the pre-paint script) and one writer (the toggle).
 */
export function SiteHeader({ themeStorageKey }: { themeStorageKey: string }) {
  const entry = navEntryForPath(usePathname());
  const isRoot = !entry || entry.href === '/dashboard';

  return (
    <header className="glass-chrome sticky top-0 z-40 flex h-14 shrink-0 items-center gap-3 border-b px-6">
      <SidebarTrigger className="-ml-2 md:hidden" />
      <Breadcrumb>
        <BreadcrumbList>
          {isRoot ? null : (
            <>
              <BreadcrumbItem className="hidden md:block">
                <BreadcrumbLink asChild>
                  <Link href="/dashboard">Rembric</Link>
                </BreadcrumbLink>
              </BreadcrumbItem>
              <BreadcrumbSeparator className="hidden md:block" />
            </>
          )}
          <BreadcrumbItem>
            <BreadcrumbPage>{entry?.label ?? 'Overview'}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-2">
        <CommandPaletteTrigger className="hidden sm:flex" />
        <ThemeToggle storageKey={themeStorageKey} />
      </div>
    </header>
  );
}

/**
 * `.dark` on `<html>` is the only theme state; this button flips it and records
 * the choice. There is deliberately no React state and no `useEffect` read of the
 * class: the icon is selected by the `dark:` variant, so the server and the client
 * always render the same markup and the button cannot hydrate against a theme the
 * document already has. The preference is applied before first paint by the script
 * in `dashboard/layout.tsx` — reading it here would be one frame too late.
 */
function ThemeToggle({ storageKey }: { storageKey: string }) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon"
      data-theme-toggle
      aria-label="Toggle dark mode"
      title="Toggle dark mode"
      onClick={() => {
        toggleTheme(storageKey);
      }}
    >
      <Sun aria-hidden className="size-4 dark:hidden" />
      <Moon aria-hidden className="hidden size-4 dark:block" />
    </Button>
  );
}

function toggleTheme(storageKey: string): void {
  const root = document.documentElement;
  const next = !root.classList.contains('dark');
  root.classList.toggle('dark', next);
  try {
    localStorage.setItem(storageKey, next ? 'dark' : 'light');
  } catch {
    // A storage that refuses to be written (private mode, disabled cookies) must
    // not break the toggle: the class is already applied, only the preference is
    // lost on the next load.
  }
}
