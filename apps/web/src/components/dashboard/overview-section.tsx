import Link from 'next/link';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/**
 * The section bar and the glass tile the overview's recents and cards sit in —
 * the React replacement for `components.ts::sectionBar`, carrying the same
 * `name` / meta / `more` contract, including `OPEN ALL ›` as the operator's path
 * to the full list.
 *
 * The glass surface is worn by a plain element rather than by `Card`: `Card`
 * paints `bg-card` on the same element, and which of two same-property utilities
 * wins is decided by stylesheet order, not by the class list.
 */

export interface SectionHeadProps {
  name: string;
  meta?: ReactNode;
  moreHref?: string;
  moreLabel?: string;
}

function SectionHead({ name, meta, moreHref, moreLabel }: SectionHeadProps) {
  return (
    <>
      <span className="flex items-baseline gap-2 font-mono text-xs tracking-[0.18em] uppercase">
        <span aria-hidden className="size-1.5 shrink-0 self-center rounded-[2px] bg-brand-accent" />
        <span className="font-semibold">{name}</span>
        {meta ? <span className="text-muted-foreground">{meta}</span> : null}
      </span>
      {moreHref ? (
        <Link href={moreHref} className="font-mono text-xs text-brand-accent hover:underline">
          {moreLabel ?? 'OPEN ALL ›'}
        </Link>
      ) : null}
    </>
  );
}

export function SectionBar({ className, ...head }: SectionHeadProps & { className?: string }) {
  return (
    <div className={cn('flex flex-wrap items-baseline justify-between gap-2', className)}>
      <SectionHead {...head} />
    </div>
  );
}

export function SectionCard({
  children,
  className,
  ...head
}: SectionHeadProps & { children: ReactNode; className?: string }) {
  return (
    <section className={cn('glass-chrome flex min-w-0 flex-col rounded-xl border', className)}>
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b px-4 py-2.5">
        <SectionHead {...head} />
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </section>
  );
}
