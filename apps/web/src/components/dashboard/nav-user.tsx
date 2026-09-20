import Link from 'next/link';

import { SidebarMenu, SidebarMenuButton, SidebarMenuItem } from '@/components/ui/sidebar';
import { REMBRIC_VERSION } from '@/lib/version';

/**
 * The adopted sidebar block calls this slot `nav-user`. Rembric's user area is
 * the brand block — the mark, the wordmark and the running version — because
 * the dashboard has no per-user settings to hang off an account menu.
 *
 * The mark is a flat lime PNG on transparency, so it needs an ink tile to read
 * on the light chrome; `--primary-foreground` is the ink half of the brand pair
 * and keeps the same value in both modes.
 */
export function NavUser() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <SidebarMenuButton size="lg" asChild>
          <Link href="/dashboard" title="REMBRIC — go to the overview">
            <span className="flex aspect-square size-8 shrink-0 items-center justify-center rounded-md bg-primary-foreground">
              {/* A plain `<img>` on purpose: `next/image` needs `sharp` for
                  production optimisation, `sharp` is explicitly denied in this
                  repository's build allowlist, and a fixed 20px mark gains
                  nothing from the optimiser. */}
              <img
                src="/dashboard/assets/logo-transparent.png"
                alt=""
                width={20}
                height={20}
                className="size-5"
              />
            </span>
            <span className="grid flex-1 text-left leading-tight">
              <span className="truncate font-display text-sm font-semibold tracking-[0.18em]">
                REMBRIC
              </span>
              <span className="truncate font-mono text-xs text-muted-foreground">
                v{REMBRIC_VERSION}
              </span>
            </span>
          </Link>
        </SidebarMenuButton>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
