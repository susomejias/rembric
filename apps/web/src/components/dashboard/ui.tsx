import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { utcStamp } from './support';

import { cn } from '@/lib/utils';

/**
 * The dashboard's presentation vocabulary, in one file: the shared frame for a
 * panel, the metric tile, the state pill, the row grid. Every class here is a
 * default shadcn semantic token (`bg-card`, `text-muted-foreground`,
 * `border-border`, `text-primary`) or a stock Tailwind palette entry for the
 * warning tone, which the shadcn theme does not declare.
 *
 * The yellow/amber tone is the one role shadcn has no token for: the theme
 * declares `--destructive` and nothing between it and the accent. Warning
 * states use Tailwind's stock amber, with a `dark:` pair because the same ink
 * cannot clear contrast on both canvases.
 *
 * Nothing here reads the request or the database.
 */

export type Tone = 'lime' | 'amber' | 'dim' | 'danger';

const TONE_TEXT: Record<Tone, string> = {
  lime: 'text-primary',
  amber: 'text-amber-600 dark:text-amber-400',
  dim: 'text-muted-foreground',
  danger: 'text-destructive',
};

const TONE_PILL: Record<Tone, string> = {
  lime: 'bg-primary/10 text-primary',
  amber: 'bg-amber-500/10 text-amber-700 dark:text-amber-400',
  dim: 'bg-muted text-muted-foreground',
  danger: 'bg-destructive/10 text-destructive',
};

const TONE_TILE: Record<Tone, string> = {
  lime: 'border-primary/30 bg-primary/5',
  amber: 'border-amber-500/30 bg-amber-500/5',
  dim: 'border-border bg-card',
  danger: 'border-destructive/30 bg-destructive/5',
};

/** The eyebrow label every page and panel carries: uppercase, tracked, muted. */
export const EYEBROW = 'text-[10px] tracking-[.14em] uppercase';

/** The page column: one max width, one padding rhythm, for every view. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto max-w-[1320px] px-5 py-5 md:px-8 md:py-6', className)}>
      {children}
    </div>
  );
}

export function Eyebrow({ icon: Icon, children }: { icon: LucideIcon; children: ReactNode }) {
  return (
    <div className={cn('flex items-center gap-2 text-primary', EYEBROW)}>
      <Icon className="size-3" />
      {children}
    </div>
  );
}

export function PageHead({
  icon,
  eyebrow,
  title,
  description,
  aside,
}: {
  icon: LucideIcon;
  eyebrow: string;
  title: string;
  description?: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-4">
      <div>
        <Eyebrow icon={icon}>{eyebrow}</Eyebrow>
        <h1 className="mt-2 text-2xl font-medium tracking-[-.06em] md:text-3xl">{title}</h1>
        {description ? (
          <p className="mt-2 max-w-2xl text-xs leading-5 text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {aside}
    </div>
  );
}

/** The header row of a panel: an uppercase eyebrow over a title, plus an action slot. */
export function PanelHead({
  eyebrow,
  title,
  action,
  className,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-4 md:px-6',
        className,
      )}
    >
      <div>
        <p className={cn('text-muted-foreground', EYEBROW)}>{eyebrow}</p>
        <h2 className="mt-1 text-base font-medium">{title}</h2>
      </div>
      {typeof action === 'string' ? (
        <span className="text-[11px] text-muted-foreground">{action}</span>
      ) : (
        action
      )}
    </div>
  );
}

/** A panel — the one frame every view stacks its content in. */
export function Panel({
  children,
  className,
  padded = false,
}: {
  children: ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section
      className={cn(
        'overflow-hidden rounded-xl border border-border bg-card',
        padded && 'p-5 md:p-6',
        className,
      )}
    >
      {children}
    </section>
  );
}

/** A row container with the default theme's hairline separators. */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('divide-y divide-border', className)}>{children}</div>;
}

export function Row({
  children,
  className,
  columns = 'md:grid-cols-[minmax(260px,1.5fr)_1fr_auto_auto]',
}: {
  children: ReactNode;
  className?: string;
  columns?: string;
}) {
  return (
    <div
      className={cn(
        'grid w-full gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/50 md:items-center md:px-6',
        columns,
        className,
      )}
    >
      {children}
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = 'dim',
  className,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn('rounded-xl border px-4 py-4', TONE_TILE[tone], className)}>
      <p className={cn('text-muted-foreground', EYEBROW)}>{label}</p>
      <p className={cn('mt-2 text-2xl font-medium tracking-[-.05em]', TONE_TEXT[tone])}>{value}</p>
      {hint ? <p className="mt-1 text-[10px] text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

export function Pill({ children, tone = 'dim' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span className={cn('w-fit rounded-full px-2 py-1 text-[10px]', TONE_PILL[tone])}>
      {children}
    </span>
  );
}

/** The square bordered chip — the shape for a scope. */
export function Chip({ children, tone = 'lime' }: { children: ReactNode; tone?: Tone }) {
  const border =
    tone === 'lime'
      ? 'border-primary/40 text-primary'
      : tone === 'danger'
        ? 'border-destructive/40 text-destructive'
        : 'border-border text-muted-foreground';
  return (
    <span className={cn('w-fit border px-2 py-1 text-[10px] tracking-[.12em] uppercase', border)}>
      {children}
    </span>
  );
}

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-border bg-card px-4 py-3">
      <p className={cn('text-muted-foreground', EYEBROW)}>{label}</p>
      <p className="mt-2 text-sm">{value}</p>
    </div>
  );
}

export function Bar({ percent, tone = 'lime' }: { percent: number; tone?: 'lime' | 'amber' }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
      <div
        className={cn('h-full rounded-full', tone === 'lime' ? 'bg-primary' : 'bg-amber-500')}
        style={{ width: `${clamped}%` }}
      />
    </div>
  );
}

export function Notice({
  tone = 'lime',
  badge,
  children,
  className,
}: {
  tone?: Tone;
  badge: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const accent =
    tone === 'amber'
      ? 'border-amber-500/30 bg-amber-500/5'
      : tone === 'danger'
        ? 'border-destructive/30 bg-destructive/5'
        : 'border-primary/30 bg-primary/5';
  return (
    <div className={cn('rounded-xl border px-4 py-3 text-sm', accent, className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(TONE_TEXT[tone], EYEBROW)}>{badge}</span>
        <span className="text-xs text-muted-foreground">{children}</span>
      </div>
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="px-5 py-10 text-center md:px-6">
      <p className="text-xs text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * The dashboard's single timestamp renderer. The UTC string is the fallback,
 * not the contract: `data-rembric-ts` is what the layout's inline script
 * upgrades to the viewer's timezone, so a server render and a hydrated render
 * never disagree about the text node before that upgrade runs.
 */
export function Time({
  value,
  className,
}: {
  value: Date | string | number | null | undefined;
  className?: string;
}) {
  if (value === null || value === undefined) return <>—</>;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return <>—</>;
  const iso = date.toISOString();
  return (
    <time dateTime={iso} data-rembric-ts className={className}>
      {utcStamp(date)}
    </time>
  );
}
