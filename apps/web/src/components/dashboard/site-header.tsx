'use client';

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
import { SidebarTrigger } from '@/components/ui/sidebar';
import { navEntryForPath } from '@/lib/nav';

/**
 * The slim sticky header over the content column: the trigger, the breadcrumb and
 * the pointer affordance for the command palette (Cmd+K is the keyboard one, and
 * is what `CommandPalette` listens for globally).
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
export function SiteHeader() {
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
      <CommandPaletteTrigger className="ml-auto hidden sm:flex" />
    </header>
  );
}
