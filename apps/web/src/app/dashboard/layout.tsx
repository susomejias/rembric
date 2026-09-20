import type { ReactNode } from 'react';

import { AppSidebar } from '@/components/dashboard/app-sidebar';
import { CommandPalette } from '@/components/dashboard/command-palette';
import { loadPaletteMemories } from '@/components/dashboard/palette-data';
import { SiteHeader } from '@/components/dashboard/site-header';
import { SidebarProvider } from '@/components/ui/sidebar';

/**
 * The dashboard shell — Midday's `(app)/(sidebar)/layout.tsx` shape: a relative
 * frame holding the rail, then one content column that reserves the rail's
 * collapsed width.
 *
 * Three design lines live in the class strings below rather than in a component:
 *
 *  - **The rail overlays** (`md:ml-[70px]`). The rail is `fixed` and the column
 *    reserves its *collapsed* 70px, so hovering the rail expands it over the page
 *    instead of reflowing the content under the pointer.
 *  - **No gap element.** `SidebarProvider` is kept for one thing only: it owns the
 *    narrow-viewport sheet that `SiteHeader`'s trigger opens, which is the only
 *    navigation path on a phone. Its desktop `Sidebar`/`SidebarInset`/`SidebarRail`
 *    are deliberately unused — the rail is Midday's raw `aside`
 *    (`app-sidebar.tsx`), which paints its own gap as a margin on the column.
 *    `SidebarProvider` is also the reason the wrapper is `flex`: the column is its
 *    only in-flow child, because the rail is `fixed`.
 *  - **Sheets for detail views.** The `@modal` slot is the intercepted route's
 *    carrier: clicking a memory or session row renders the detail inside a `Sheet`
 *    *here*, leaving `children` — the list — mounted behind it. A direct link to
 *    the same detail URL renders through `children` as a page.
 */
export default function DashboardLayout({
  children,
  modal,
}: {
  children: ReactNode;
  /** The `@modal` parallel slot: the detail sheets, empty for every other route. */
  modal: ReactNode;
}) {
  return (
    <SidebarProvider defaultOpen={false} className="min-h-svh">
      <AppSidebar />
      <div className="flex min-h-svh flex-1 flex-col md:ml-[70px]">
        <SiteHeader />
        <div className="flex flex-1 flex-col gap-4 p-4 md:p-6">{children}</div>
      </div>
      {modal}
      <CommandPalette memories={loadPaletteMemories()} />
    </SidebarProvider>
  );
}
