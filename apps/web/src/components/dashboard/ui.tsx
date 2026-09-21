import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { utcStamp } from './support';

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';

/**
 * The dashboard's presentation vocabulary, in one file, mirroring the
 * production dashboard's component helpers (`apps/server/src/dashboard/
 * components.ts` + `styles/core/patterns.css`) as React: the numbered view
 * head, the stat card, the section bar, the data table, the key/value grid,
 * the state pill, the flash. Every colour is a stock shadcn semantic token
 * (`bg-card`, `text-muted-foreground`, `border-border`, `text-primary`) or
 * Tailwind's stock amber for the warning tone the theme does not declare.
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

const TONE_DOT: Record<Tone, string> = {
  lime: 'bg-primary',
  amber: 'bg-amber-500',
  dim: 'bg-muted-foreground',
  danger: 'bg-destructive',
};

const TONE_BORDER: Record<Tone, string> = {
  lime: 'border-primary/40 text-primary',
  amber: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  dim: 'border-border text-muted-foreground',
  danger: 'border-destructive/40 text-destructive',
};

/** The square bullet that precedes a label, sized to the current text. */
function Bullet({ tone = 'lime', className }: { tone?: Tone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-[0.55em] shrink-0', TONE_DOT[tone], className)}
    />
  );
}

/** The mono, tracked, uppercase label every page, panel and stat carries. */
export const LABEL = 'font-mono text-[11px] uppercase tracking-[.14em]';

/** The page column: one max width, one padding rhythm, for every view. */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('mx-auto max-w-[1320px] px-5 py-6 md:px-8', className)}>{children}</div>
  );
}

export function ViewHead({
  num,
  title,
  hl,
  meta,
}: {
  num: string;
  title: string;
  hl?: string;
  meta?: ReadonlyArray<{ k: string; v: ReactNode }>;
}) {
  const parts = hl && title.includes(hl) ? title.split(hl) : null;
  return (
    <header className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-3 border-b border-border pb-4">
      <div className="flex items-baseline gap-3">
        <span className={cn('text-muted-foreground', LABEL)}>{num}</span>
        <h1 className="font-display text-2xl font-semibold tracking-[-.03em] md:text-3xl">
          {parts ? (
            <>
              {parts[0]}
              <span className="text-primary">{hl}</span>
              {parts[1]}
            </>
          ) : (
            title
          )}
        </h1>
      </div>
      {meta && meta.length > 0 ? (
        <div className="flex flex-wrap items-baseline gap-x-5 gap-y-1">
          {meta.map((m) => (
            <span key={m.k} className={cn('text-muted-foreground', LABEL)}>
              <b className="font-semibold text-foreground">{m.k}</b> {m.v}
            </span>
          ))}
        </div>
      ) : null}
    </header>
  );
}

/** Back link rendered as the first element of a detail view's content. */
export function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      className={cn(
        'inline-flex w-fit items-center gap-2 text-muted-foreground transition-colors hover:text-primary',
        LABEL,
      )}
    >
      <ArrowLeft className="size-3.5" />
      {label}
    </Link>
  );
}

/** A section divider: a lime square, an uppercase name, and optional meta/action. */
export function SectionBar({
  name,
  meta,
  more,
}: {
  name: string;
  meta?: ReactNode;
  more?: ReactNode;
}) {
  return (
    <div className="mb-4 flex flex-wrap items-baseline gap-3 border-b border-border pb-3">
      <span className={cn('flex items-center gap-2 font-semibold text-foreground', LABEL)}>
        <Bullet />
        {name}
      </span>
      {meta ? <span className={cn('text-muted-foreground', LABEL)}>{meta}</span> : null}
      {more ? <span className="ml-auto">{more}</span> : null}
    </div>
  );
}

/* ── stat cards ─────────────────────────────────────────────────────── */

export interface StatOpts {
  k: string;
  v: ReactNode;
  tone?: Tone;
  sub?: ReactNode;
  href?: string;
  className?: string;
}

/**
 * One metric: a labelled value with a mono sub line, the production
 * dashboard's `statCard` hierarchy. Renders as a link when `href` is set.
 */
export function StatCard({ k, v, tone = 'dim', sub, href, className }: StatOpts) {
  const inner = (
    <>
      <div className={cn('flex items-center gap-2 text-muted-foreground', LABEL)}>
        <Bullet tone={tone} />
        {k}
      </div>
      <div
        className={cn(
          'font-display text-4xl leading-none font-bold tracking-[-.025em]',
          TONE_TEXT[tone],
        )}
      >
        {v}
      </div>
      {sub ? (
        <div className={cn('mt-auto flex items-center justify-between gap-3', LABEL)}>{sub}</div>
      ) : null}
    </>
  );
  const box = cn(
    'flex min-h-[132px] flex-col gap-3 border border-border bg-card p-5 transition-colors',
    href && 'hover:border-primary',
    className,
  );
  return href ? (
    <Link href={href} className={box}>
      {inner}
    </Link>
  ) : (
    <div className={box}>{inner}</div>
  );
}

/** The stat strip: six columns at desktop, two at mobile, hairline separators. */
export function StatGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6', className)}>
      {children}
    </div>
  );
}

/* ── key/value grid (detail views) ──────────────────────────────────── */

export function Kv({
  k,
  v,
  tone = 'dim',
  mono = false,
}: {
  k: string;
  v: ReactNode;
  tone?: Tone;
  mono?: boolean;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 border-b border-r border-border px-5 py-4 md:min-h-[96px]">
      <div className={cn('flex items-center gap-2 text-muted-foreground', LABEL)}>
        <Bullet tone={tone} />
        {k}
      </div>
      <div
        className={cn(
          'min-w-0 break-words',
          mono
            ? 'font-mono text-sm font-medium'
            : cn('font-display text-xl font-bold tracking-[-.015em]', TONE_TEXT[tone]),
        )}
      >
        {v}
      </div>
    </div>
  );
}

/** A bordered grid of `Kv` cells; pass the cells as children. */
export function KvGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        'mb-5 grid border-t border-l border-border sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6',
        className,
      )}
    >
      {children}
    </div>
  );
}

/* ── panels ─────────────────────────────────────────────────────────── */

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
    <section className={cn('border border-border bg-card', padded && 'p-5 md:p-6', className)}>
      {children}
    </section>
  );
}

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
        <p className={cn('flex items-center gap-2 text-muted-foreground', LABEL)}>
          <Bullet />
          {eyebrow}
        </p>
        <h2 className="mt-1 text-base font-medium">{title}</h2>
      </div>
      {typeof action === 'string' ? (
        <span className={cn('text-muted-foreground', LABEL)}>{action}</span>
      ) : (
        action
      )}
    </div>
  );
}

/* ── data table (the production `tbl-host` shape) ───────────────────── */

/**
 * The one table frame every list view uses. The wrapper scrolls horizontally
 * on narrow screens; the header cells carry the mono, uppercase column labels
 * the production dashboard's `.tbl thead th` set.
 */
export function DataTable({ children }: { children: ReactNode }) {
  return (
    <div className="w-full overflow-x-auto border border-border bg-card">
      <Table className="min-w-[720px]">{children}</Table>
    </div>
  );
}

export function DataHead({ children }: { children: ReactNode }) {
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">{children}</TableRow>
    </TableHeader>
  );
}

export function DataTh({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <TableHead
      className={cn(
        'h-auto bg-background px-4 py-3 font-mono text-[11px] font-medium uppercase tracking-[.14em] text-muted-foreground',
        className,
      )}
    >
      {children}
    </TableHead>
  );
}

export function DataBody({ children }: { children: ReactNode }) {
  return <TableBody>{children}</TableBody>;
}

export function DataTr({ children, className }: { children: ReactNode; className?: string }) {
  return <TableRow className={cn('hover:bg-muted/50', className)}>{children}</TableRow>;
}

export function DataTd({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <TableCell className={cn('px-4 py-3 align-middle whitespace-nowrap', className)}>
      {children}
    </TableCell>
  );
}

/** The empty state that sits where a table would be. */
export function TableEmpty({ children }: { children: ReactNode }) {
  return (
    <div
      className={cn(
        'border border-dashed border-border px-5 py-14 text-center text-muted-foreground',
        LABEL,
      )}
    >
      {children}
    </div>
  );
}

/* ── pills ──────────────────────────────────────────────────────────── */

/** The square bordered pill: an optional tone dot plus an uppercase label. */
export function Pill({ children, tone = 'dim' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-2 border bg-transparent px-2 py-0.5 font-mono text-[10px] whitespace-nowrap uppercase tracking-[.12em]',
        TONE_BORDER[tone],
      )}
    >
      <Bullet tone={tone} className="size-[7px]" />
      {children}
    </span>
  );
}

const STATUS_TONE: Record<string, Tone> = {
  active: 'lime',
  superseded: 'amber',
  archived: 'dim',
  pending: 'dim',
  orphaned: 'danger',
  judged: 'lime',
  deleted: 'danger',
};

export function StatusPill({ status }: { status: string }) {
  return <Pill tone={STATUS_TONE[status] ?? 'dim'}>{status}</Pill>;
}

export function ReviewPill() {
  return <Pill tone="amber">needs review</Pill>;
}

/** The square bordered chip — the shape for a scope or a tag. */
export function Chip({ children, tone = 'lime' }: { children: ReactNode; tone?: Tone }) {
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[.12em]',
        TONE_BORDER[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Tag({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex w-fit items-center border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[.1em] text-muted-foreground">
      {children}
    </span>
  );
}

/* ── bars, notices, flash, timestamps ──────────────────────────────── */

export function Bar({
  percent,
  tone = 'lime',
}: {
  percent: number;
  tone?: 'lime' | 'amber' | 'dim';
}) {
  const clamped = Math.min(100, Math.max(0, percent));
  return (
    <div className="mt-2 h-1.5 overflow-hidden bg-muted">
      <div
        className={cn(
          'h-full',
          tone === 'lime'
            ? 'bg-primary'
            : tone === 'amber'
              ? 'bg-amber-500'
              : 'bg-muted-foreground',
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
  return (
    <div
      className={cn(
        'flex flex-wrap items-center gap-3 border bg-card px-4 py-3',
        tone === 'amber'
          ? 'border-amber-500/40'
          : tone === 'danger'
            ? 'border-destructive/40'
            : 'border-primary/40',
        className,
      )}
    >
      <span className={cn('flex items-center gap-2 font-semibold', LABEL, TONE_TEXT[tone])}>
        <Bullet tone={tone} />
        {badge}
      </span>
      <span className="text-xs text-muted-foreground">{children}</span>
    </div>
  );
}

/** The flash banner the production `flash()` renders: a tone label + body. */
export function Flash({
  tone = 'lime',
  label,
  children,
}: {
  tone?: Tone;
  label: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        'mb-5 flex flex-wrap items-center gap-4 border bg-card px-5 py-4',
        TONE_BORDER[tone],
      )}
    >
      <span className={cn('flex items-center gap-2 font-semibold', LABEL, TONE_TEXT[tone])}>
        <Bullet tone={tone} />
        {label}
      </span>
      <span className="text-sm">{children}</span>
    </div>
  );
}

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
