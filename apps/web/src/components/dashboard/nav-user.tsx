import { LogOut } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * The bottom of the rail — Midday's `team-dropdown` slot. Rembric has no teams
 * and no per-user settings to hang off an account menu, so the slot carries the
 * one thing that belongs at the end of the rail: the sign-out.
 *
 * The brand block is deliberately NOT here. It lives in the logo bar at the top
 * of the rail (`app-sidebar.tsx`), next to the mark it belongs with, together
 * with the version line and the update slot the dashboard spec pins to it; the
 * copy that used to sit here — a second lime tile with the initial, the wordmark
 * and the version — rendered the brand twice, and the second copy is what this
 * replaces.
 *
 * Sign-out is a plain form `POST` to `/dashboard/logout`, the same request the
 * retired sidebar made (`dashboard/components.ts::renderSidebar`). It stays a
 * form rather than a link because logout mutates — it deletes the
 * `dashboard_sessions` row — and it carries no CSRF token because the retired
 * handler verified none.
 *
 * The label is dropped from the layout (`sr-only`) while the rail is collapsed
 * rather than merely faded, so its box cannot push the icon off the rail's centre
 * line; `justify-center` is what keeps the icon on that line.
 */
export function NavUser({ isExpanded }: { isExpanded: boolean }) {
  return (
    <div data-slot="sidebar-footer" className="w-full px-4">
      <form action="/dashboard/logout" method="post">
        <button
          type="submit"
          title="Sign out"
          className={cn(
            'flex h-8 w-full items-center gap-2 rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
            isExpanded ? 'px-1' : 'justify-center',
          )}
        >
          <LogOut className="size-4 shrink-0" />
          <span
            className={cn(
              'overflow-hidden text-[0.8rem] whitespace-nowrap',
              isExpanded ? 'opacity-100' : 'sr-only',
            )}
          >
            Sign out
          </span>
        </button>
      </form>
    </div>
  );
}
