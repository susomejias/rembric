'use client';

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
import { Separator } from '@/components/ui/separator';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { navEntryForPath } from '@/lib/nav';

/**
 * The slim bar over the content column: the rail's trigger and the breadcrumb
 * that names the view.
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
export function SiteHeader() {
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
    </header>
  );
}
