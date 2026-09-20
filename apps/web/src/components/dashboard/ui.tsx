import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { utcStamp } from './support';

import { cn } from '@/lib/utils';

/**
 * The dashboard's presentation vocabulary, in one file, because the v0 design
 * expresses itself in long utility strings rather than in semantic tokens: a
 * `rounded-2xl` frame with a hairline border for a panel, a filled pill for a
 * state, 45%-ink body copy. Naming those once is what keeps the twelve views
 * looking like one product, and it is why no view reaches for the shadcn
 * `Card`.
 *
 * The surfaces and the text alphas are read through the role variables the
 * theme declares (`--ink`, `--surface-panel`, …) instead of the mockup's literal
 * hex and `white/45`. In the dark theme — the default — every substitution is
 * byte-identical to the value it replaces, so the mockup's rendering is
 * unchanged; in the light theme the same string resolves to the light role and
 * the view flips with the theme instead of staying dark-on-dark.
 *
 * Nothing here reads the request or the database.
 */

export type Tone = 'lime' | 'amber' | 'dim' | 'danger';

const TONE_TEXT: Record<Tone, string> = {
  lime: 'text-(--accent-ink)',
  amber: 'text-(--warn-ink)',
  dim: 'text-(--ink)/45',
  danger: 'text-(--danger-ink)',
};

const TONE_PILL: Record<Tone, string> = {
  lime: 'bg-(--accent-ink)/[8%] text-(--accent-ink)/70',
  amber: 'bg-(--warn-ink)/[10%] text-(--warn-ink)/75',
  dim: 'bg-(--ink)/[5%] text-(--ink)/55',
  danger: 'bg-(--danger-ink)/10 text-(--danger-ink)',
};

const TONE_TILE: Record<Tone, string> = {
  lime: 'border-(--accent-ink)/15 bg-(--accent-ink)/[4.5%]',
  amber: 'border-(--warn-ink)/15 bg-(--warn-surface)',
  dim: 'border-(--ink)/[6.5%] bg-(--surface-panel)',
  danger: 'border-(--danger-ink)/20 bg-(--danger-ink)/[4%]',
};

/** The eyebrow label every page and panel carries: uppercase, tracked, accent ink. */
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
    <div className={cn('flex items-center gap-2 text-(--accent-ink-strong)/70', EYEBROW)}>
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
          <p className="mt-2 max-w-2xl text-xs leading-5 text-(--ink)/45">{description}</p>
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
        'flex flex-wrap items-center justify-between gap-3 border-b border-(--ink)/[7%] px-5 py-4 md:px-6',
        className,
      )}
    >
      <div>
        <p className={cn('text-(--ink)/38', EYEBROW)}>{eyebrow}</p>
        <h2 className="mt-1 text-base font-medium">{title}</h2>
      </div>
      {typeof action === 'string' ? (
        <span className="text-[11px] text-(--ink)/38">{action}</span>
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
        'overflow-hidden rounded-2xl border border-(--ink)/[7.5%] bg-(--surface-panel)',
        padded && 'p-5 md:p-6',
        className,
      )}
    >
      {children}
    </section>
  );
}

/** A row container with the mockup's hairline separators. */
export function Rows({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('divide-y divide-(--ink)/[6%]', className)}>{children}</div>;
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
        'grid w-full gap-3 px-5 py-4 text-left transition-colors hover:bg-(--accent-ink)/[3.5%] md:items-center md:px-6',
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
      <p className={cn('text-(--ink)/38', EYEBROW)}>{label}</p>
      <p className={cn('mt-2 text-2xl font-medium tracking-[-.05em]', TONE_TEXT[tone])}>{value}</p>
      {hint ? <p className="mt-1 text-[10px] text-(--ink)/45">{hint}</p> : null}
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

/** The square bordered chip — the mockup's shape for a scope. */
export function Chip({ children, tone = 'lime' }: { children: ReactNode; tone?: Tone }) {
  const border =
    tone === 'lime'
      ? 'border-(--accent-ink)/25 text-(--accent-ink)/75'
      : tone === 'danger'
        ? 'border-(--danger-ink)/40 text-(--danger-ink)'
        : 'border-(--ink)/[10%] text-(--ink)/45';
  return (
    <span className={cn('w-fit border px-2 py-1 text-[10px] tracking-[.12em] uppercase', border)}>
      {children}
    </span>
  );
}

export function Fact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-xl border border-(--ink)/[6.5%] bg-(--surface-panel) px-4 py-3">
      <p className={cn('text-(--ink)/38', EYEBROW)}>{label}</p>
      <p className="mt-2 text-sm text-(--ink)/80">{value}</p>
    </div>
  );
}

export function Bar({ percent, tone = 'lime' }: { percent: number; tone?: 'lime' | 'amber' }) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-(--ink)/[7%]">
      <div
        className={cn(
          'h-full rounded-full',
          tone === 'lime' ? 'bg-(--accent-ink)/70' : 'bg-(--warn-ink)/70',
        )}
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
      ? 'border-(--warn-ink)/15 bg-(--warn-surface)'
      : tone === 'danger'
        ? 'border-(--danger-ink)/25 bg-(--danger-ink)/[5%]'
        : 'border-(--accent-ink)/20 bg-(--accent-ink)/[4.5%]';
  return (
    <div className={cn('rounded-xl border px-4 py-3 text-sm', accent, className)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={cn(TONE_TEXT[tone], EYEBROW)}>{badge}</span>
        <span className="text-xs text-(--ink)/70">{children}</span>
      </div>
    </div>
  );
}

export function EmptyNote({ children }: { children: ReactNode }) {
  return (
    <div className="px-5 py-10 text-center md:px-6">
      <p className="text-xs text-(--ink)/45">{children}</p>
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
