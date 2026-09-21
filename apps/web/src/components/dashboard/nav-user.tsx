import { LogOut } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * The bottom of the rail — main's `.sb-foot`, which holds the sign-out and the
 * collapse toggle. The collapse half is the primitive's `SidebarRail` plus its
 * ⌘B shortcut, so this carries the sign-out alone.
 *
 * Sign-out is a plain form `POST` to `/dashboard/logout` — the same request main
 * makes, and the route `middleware.ts` lists as public precisely so a session that
 * has already been deleted can still reach it. It stays a form rather than a link
 * because logout mutates (it deletes the `dashboard_sessions` row).
 *
 * Main hides this control entirely in icons-only mode (`.sb.is-collapsed
 * .sb-foot-text { display: none }`), which leaves a collapsed rail with no way
 * out. Both glyphs are therefore always rendered and the mode decides which one
 * paints: main's `→ LOGOUT` while there is room for it, and an icon when there is
 * not. `justify-center` and the dropped padding are what keep that icon on the
 * rail's centre line.
 */
export function NavUser() {
  return (
    <form action="/dashboard/logout" method="post" className="w-full">
      <button
        type="submit"
        title="Sign out"
        className={cn(
          'flex h-8 w-full items-center gap-2 px-2 font-mono text-[0.6rem]',
          'tracking-[0.14em] text-muted-foreground uppercase transition-colors hover:text-primary',
          'group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0',
        )}
      >
        <span aria-hidden="true" className="shrink-0 group-data-[collapsible=icon]:hidden">
          →
        </span>
        <LogOut
          aria-hidden="true"
          className="hidden size-4 shrink-0 group-data-[collapsible=icon]:block"
        />
        <span className="truncate group-data-[collapsible=icon]:sr-only">Logout</span>
      </button>
    </form>
  );
}
