import { LogOut } from 'lucide-react';
import Link from 'next/link';

import { cn } from '@/lib/utils';
import { REMBRIC_VERSION } from '@/lib/version';

/**
 * The bottom of the rail — Midday's `team-dropdown` slot. Rembric has no teams
 * and no per-user settings to hang off an account menu, so the slot carries the
 * brand block instead: the mark, the wordmark and the running version.
 *
 * The mark is the 28px lime tile with the initial, not the transparent lime PNG
 * the login card uses — a lime glyph on a lime tile would disappear.
 *
 * The name and the version fade in with the rail and are clipped to zero width
 * while it is collapsed (`min-w-0` + `truncate`), which is what keeps their
 * invisible boxes from overflowing the 70px rail.
 *
 * Sign-out is the row below, not a menu on the brand: a plain form `POST` to
 * `/dashboard/logout`, the same request the retired sidebar made
 * (`dashboard/components.ts::renderSidebar`). It stays a form rather than a link
 * because logout mutates — it deletes the `dashboard_sessions` row — and it
 * carries no CSRF token because the retired handler verified none.
 */
export function NavUser({ isExpanded }: { isExpanded: boolean }) {
  return (
    <div data-slot="sidebar-brand" className="w-full px-4">
      <Link href="/dashboard" title="REMBRIC — go to the overview" className="flex items-center">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-primary font-display text-xs font-extrabold text-primary-foreground">
          R
        </span>
        <span
          className={cn(
            'ml-2.5 flex min-w-0 flex-col leading-tight transition-opacity duration-150 delay-100',
            isExpanded ? 'opacity-100' : 'opacity-0',
          )}
        >
          <span className="truncate font-display text-[0.8rem] font-semibold tracking-[0.18em]">
            REMBRIC
          </span>
          <span className="truncate font-mono text-[0.65rem] text-muted-foreground">
            v{REMBRIC_VERSION}
          </span>
        </span>
      </Link>
      <form action="/dashboard/logout" method="post">
        <button
          type="submit"
          title="Sign out"
          className={cn(
            'mt-2 flex h-8 w-full items-center gap-2 rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground',
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
