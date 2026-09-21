'use client';

import { Moon, Sun } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { navEntryForPath } from '@/lib/nav';

/**
 * The slim bar over the content column: the rail's trigger, the breadcrumb that
 * names the view, and the theme toggle.
 *
 * The trigger is the primitive's, so it routes to whatever the viewport makes
 * correct — the desktop rail's open state on a pointer device, the provider's
 * sheet on a narrow one — and it is visible at every width rather than only under
 * `md`: main puts an explicit, labelled collapse control in its rail foot, and a
 * trigger that disappears as the rail appears would leave the desktop with the
 * rail's hover edge and ⌘B as the only ways back to icons.
 *
 * The breadcrumb is a locator, not a title: every view renders its own `<ViewHead>`
 * with the numbered `h1`, and repeating that here would be the same sentence twice.
 */
export function SiteHeader({ themeStorageKey }: { themeStorageKey: string }) {
  const entry = navEntryForPath(usePathname());
  const isRoot = !entry || entry.href === '/dashboard';

  return (
    <header className="sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b border-sidebar-border bg-background px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="h-4 self-center!" />
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
      size="icon-sm"
      data-theme-toggle
      aria-label="Toggle colour theme"
      title="Toggle colour theme"
      onClick={() => {
        toggleTheme(storageKey);
      }}
    >
      <Moon aria-hidden className="size-4 dark:hidden" />
      <Sun aria-hidden className="hidden size-4 dark:block" />
    </Button>
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
