'use client';

import { useRouter } from 'next/navigation';
import type { ReactNode } from 'react';

import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';

/**
 * The slide-over carrier for a detail view (Midday's "detail as a Sheet"): the
 * list stays rendered and scrollable behind the panel, and the panel's own URL
 * is still the item's real route — this component is what the *intercepted*
 * route renders, so the address bar and the panel agree.
 *
 * Closing is a navigation, not a local `open` flag: `router.back()` restores the
 * list URL the operator came from (filters, page and all) instead of guessing a
 * parent path. A deep link straight to `/dashboard/memories/[id]` never reaches
 * this component — the intercepting route only matches a client-side navigation
 * from the list — so there is always a list entry to return to.
 */
export function DetailSheet({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  children: ReactNode;
}) {
  const router = useRouter();

  return (
    <Sheet
      open
      onOpenChange={(open) => {
        if (!open) router.back();
      }}
    >
      <SheetContent side="right" className="w-full gap-0 overflow-y-auto p-0 sm:max-w-3xl">
        <SheetHeader className="glass-chrome sticky top-0 z-10 gap-1 border-b px-4 py-3">
          <SheetTitle className="pr-8 font-display text-lg font-semibold tracking-tight">
            {title}
          </SheetTitle>
          {/* Radix requires a description on every dialog; it is the panel's
              one-line summary when the caller has one, and otherwise only a
              label for assistive tech rather than a visible empty row. */}
          <SheetDescription
            className={subtitle ? 'font-mono text-xs break-all text-muted-foreground' : 'sr-only'}
          >
            {subtitle ?? 'Detail panel'}
          </SheetDescription>
        </SheetHeader>
        <div className="p-4 md:p-6">{children}</div>
      </SheetContent>
    </Sheet>
  );
}
