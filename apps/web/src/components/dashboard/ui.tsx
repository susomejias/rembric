import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import type { ReactNode } from 'react';

import { NumberTicker } from '@/components/motion/number-ticker';
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
 * the state pill, the flash. Every colour is a semantic token the theme
 * declares (`bg-card`, `text-muted-foreground`, `border-border`, `text-primary`,
 * `text-warn`).
 *
 * Nothing here reads the request or the database.
 */

/**
 * `fg` is main's neutral tone: a bright value over the default lime bullet
 * (`.bn` in `styles/core/atoms.css`). `amber` is the theme's `--warn`; the key
 * keeps its historical name so call sites outside this file do not churn.
 */
export type Tone = 'fg' | 'lime' | 'amber' | 'dim' | 'danger';

const TONE_TEXT: Record<Tone, string> = {
  fg: 'text-foreground',
  lime: 'text-primary',
  amber: 'text-warn',
  dim: 'text-muted-foreground',
  danger: 'text-destructive',
};

const TONE_DOT: Record<Tone, string> = {
  fg: 'bg-primary',
  lime: 'bg-primary',
  amber: 'bg-warn',
  dim: 'bg-muted-foreground',
  danger: 'bg-destructive',
};

const TONE_BORDER: Record<Tone, string> = {
  fg: 'border-border text-foreground',
  lime: 'border-primary/40 text-primary',
  amber: 'border-warn/40 text-warn',
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

/**
 * The page column. It takes the full width the shell's content column offers
 * rather than capping itself: a wide viewport has the rail on the left and real
 * estate to spare, and a cap here only re-created the void the shell stopped
 * leaving. Readable-content widths are owned by the content that needs them
 * (markdown panels, forms), not by the page. Vertical rhythm belongs to the
 * shell's content column, so a page nested in the shell never pays for both.
 */
export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('w-full min-w-0 px-5 md:px-8', className)}>{children}</div>;
}

export function ViewHead({
  title,
  hl,
  titleVisible = false,
}: {
  /** No longer rendered: the per-page number was dropped. Kept so call sites stay put. */
  num?: string;
  title: string;
  hl?: string;
  /**
   * Accepted and deliberately not rendered. The top-right strip it described was
   * removed from every page: a list's count already lives in its stat cards and
   * its section bars, and the strip left a ruled gap above the content of a page
   * whose own heading is not on screen. Kept in the props type because call sites
   * still pass it, exactly like `num` above.
   */
  meta?: ReadonlyArray<{ k: string; v: ReactNode }>;
  /**
   * Detail views pass `true`: the record's own title heads the page and there is
   * no breadcrumb entry that names it. A listing or the overview leaves it
   * `false` — the shell breadcrumb already names the page — and the heading
   * stays in the DOM as the single `sr-only` `h1` instead of repeating on
   * screen.
   */
  titleVisible?: boolean;
}) {
  const parts = hl && title.includes(hl) ? title.split(hl) : null;
  const heading = (
    <h1
      className={cn(
        'font-display text-2xl font-semibold tracking-[-.03em] uppercase md:text-3xl',
        !titleVisible && 'sr-only',
      )}
    >
      {parts ? (
        <>
          {parts[0]}
          <span className="bg-primary px-[.18em] pb-[.04em] text-primary-foreground">{hl}</span>
          {parts[1]}
        </>
      ) : (
        title
      )}
    </h1>
  );
  // A page whose heading is off screen renders the heading and nothing else, so
  // it never gains an empty bordered strip — or the vertical space one left.
  if (!titleVisible) return heading;
  return <header className="min-w-0 border-b border-border pb-4">{heading}</header>;
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
  compact?: boolean;
}

/**
 * One metric: a labelled value with a mono sub line, the production
 * dashboard's `statCard` hierarchy. Renders as a link when `href` is set.
 */
export function StatCard({ k, v, tone = 'dim', sub, href, className, compact }: StatOpts) {
  const inner = (
    <>
      <div className={cn('flex items-center gap-2 text-muted-foreground', LABEL)}>
        <Bullet tone={tone} />
        {k}
      </div>
      <div
        className={cn(
          'font-display leading-none font-bold tracking-[-.025em]',
          compact ? 'text-3xl' : 'text-4xl',
          TONE_TEXT[tone],
        )}
      >
        {typeof v === 'number' ? <NumberTicker value={v} /> : v}
      </div>
      {sub ? (
        <div className={cn('mt-auto flex items-center justify-between gap-3', LABEL)}>{sub}</div>
      ) : null}
    </>
  );
  const box = cn(
    'flex flex-col border border-border bg-card transition-colors',
    compact ? 'min-h-[92px] gap-1.5 p-4' : 'min-h-[132px] gap-3 p-5',
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

/**
 * The stat strip: one contiguous grid, its cells separated by a 1px gap that
 * shows the grid's own background, so every divider is a single hairline and
 * the strip needs one border instead of one per cell.
 *
 * `variant="cards"` is main's auto-fill kind grid: individually bordered
 * cards on the page background, so empty trailing slots stay invisible
 * instead of painting the frame grey.
 */
export function StatGrid({
  children,
  className,
  variant = 'frame',
}: {
  children: ReactNode;
  className?: string;
  variant?: 'frame' | 'cards';
}) {
  return (
    <div
      className={cn(
        variant === 'frame' &&
          'grid grid-cols-2 gap-px border border-border bg-border [&>*]:border-0! md:grid-cols-3 xl:grid-cols-6',
        variant === 'cards' &&
          'grid [grid-template-columns:repeat(auto-fill,minmax(148px,1fr))] [&>*]:-ml-px! [&>*]:-mt-px!',
        className,
      )}
    >
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
          tone === 'lime' ? 'bg-primary' : tone === 'amber' ? 'bg-warn' : 'bg-muted-foreground',
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
          ? 'border-warn/40'
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

export { Time } from './time';
