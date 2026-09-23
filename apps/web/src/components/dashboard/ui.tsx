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

function Bullet({ tone = 'lime', className }: { tone?: Tone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-[0.55em] shrink-0', TONE_DOT[tone], className)}
    />
  );
}

export const LABEL = 'font-mono text-[11px] uppercase tracking-[.14em]';

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('w-full min-w-0 px-5 md:px-8', className)}>{children}</div>;
}

export function ViewHead({
  title,
  hl,
  titleVisible = false,
}: {
  num?: string;
  title: string;
  hl?: string;
  meta?: ReadonlyArray<{ k: string; v: ReactNode }>;
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
  if (!titleVisible) return heading;
  return <header className="min-w-0 border-b border-border pb-4">{heading}</header>;
}

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

export interface StatOpts {
  k: string;
  v: ReactNode;
  tone?: Tone;
  sub?: ReactNode;
  href?: string;
  className?: string;
  compact?: boolean;
}

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
  abandoned: 'amber',
  ended: 'dim',
};

const TONE_PILL: Record<Tone, { border: string; bg: string; text: string; dot: string }> = {
  lime: {
    border: 'border-primary/40',
    bg: 'bg-primary/10',
    text: 'text-primary',
    dot: 'bg-primary',
  },
  fg: {
    border: 'border-border',
    bg: 'bg-accent',
    text: 'text-foreground',
    dot: 'bg-foreground',
  },
  amber: {
    border: 'border-warn/40',
    bg: 'bg-warn/10',
    text: 'text-warn',
    dot: 'bg-warn',
  },
  danger: {
    border: 'border-destructive/40',
    bg: 'bg-destructive/10',
    text: 'text-destructive',
    dot: 'bg-destructive',
  },
  dim: {
    border: 'border-border',
    bg: 'bg-input/60',
    text: 'text-muted-foreground',
    dot: 'bg-muted-foreground',
  },
};

export function StatusPill({ status }: { status: string }) {
  const tone = TONE_PILL[STATUS_TONE[status] ?? 'dim'];
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize',
        tone.border,
        tone.bg,
        tone.text,
      )}
    >
      <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', tone.dot)} />
      {status}
    </span>
  );
}

export function ReviewPill() {
  return <Pill tone="amber">needs review</Pill>;
}

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
