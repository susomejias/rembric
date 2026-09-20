import type { ReactNode } from 'react';

import { getUpdates } from '@/app/dashboard/update/update-service';
import { AppSidebar, type SidebarUpdate } from '@/components/dashboard/app-sidebar';
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
 *
 * The theme script is the one thing here that is not layout: it runs during HTML
 * parsing, before the column paints, because the class it sets is the difference
 * between loading dark and flashing light first. It is emitted from this layout
 * rather than the root one so the anonymous `/dashboard/login` screen — which has
 * no chrome to theme — pays nothing for it.
 *
 * `THEME_STORAGE_KEY` is declared here, in the server component that renders the
 * script, and threaded down to the toggle as a prop rather than exported from
 * `site-header.tsx`: an export of a `'use client'` module is a client reference,
 * so reading it during the server render throws instead of returning the string.
 * One declaration, one reader (the script) and one writer (the toggle).
 *
 * The release state the rail's brand block shows is resolved here for the same
 * reason: `UpdateCheckService` is a server-side singleton that reaches the
 * network, so the rail receives an already-decided value and never the service.
 */
const THEME_STORAGE_KEY = 'rembric-theme';

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
      <script>{themeScript()}</script>
      <AppSidebar update={sidebarUpdate()} />
      <div className="flex min-h-svh flex-1 flex-col md:ml-[70px]">
        <SiteHeader themeStorageKey={THEME_STORAGE_KEY} />
        <div className="flex flex-1 flex-col gap-3 p-4 md:p-6">{children}</div>
      </div>
      {modal}
      <CommandPalette memories={loadPaletteMemories()} />
    </SidebarProvider>
  );
}

/**
 * The rail's release state, read from the same service `/dashboard/update`
 * reads. `peek()` is synchronous — it answers from the cached check and kicks a
 * background refresh at most once every 24h, never blocking a render — so this
 * call costs a render nothing on the request that opens a window of the check.
 *
 * Every `/dashboard` page is `force-dynamic`, so this runs per request and never
 * during `next build`.
 */
function sidebarUpdate(): SidebarUpdate {
  const updates = getUpdates();
  if (!updates.enabled) return { state: 'disabled' };
  const info = updates.peek();
  return info ? { state: 'available', latestVersion: info.latestVersion } : { state: 'up-to-date' };
}

/**
 * Applies the stored preference to `<html>` before the first paint. Both branches
 * are explicit: an absent key (never toggled) and a `'light'` value must leave the
 * document exactly as `app/layout.tsx` rendered it, so the light default stays
 * reachable and a stored choice can also undo a choice. The `try` covers a
 * `localStorage` that throws on read.
 */
function themeScript(): string {
  return `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');if(t==='dark'){document.documentElement.classList.add('dark')}else if(t==='light'){document.documentElement.classList.remove('dark')}}catch(e){}})()`;
}
