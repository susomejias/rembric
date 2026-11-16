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

function Bullet({ tone = 'lime', className }: { tone?: Tone; className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn('inline-block size-[0.55em] shrink-0 rounded-full', TONE_DOT[tone], className)}
    />
  );
}

export const LABEL = 'font-mono text-[11px] uppercase tracking-[.14em]';

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn('w-full min-w-0', className)}>{children}</div>;
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
        'text-3xl font-semibold tracking-tight text-foreground',
        !titleVisible && 'sr-only',
      )}
    >
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
  );
  if (!titleVisible) return heading;
  return <header className="min-w-0">{heading}</header>;
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
    <div className="mb-4 flex flex-wrap items-baseline gap-3">
      <span className={cn('font-medium text-foreground', LABEL)}>{name}</span>
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
          'leading-none font-semibold tracking-tight',
          compact ? 'text-2xl' : 'text-3xl',
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
    'flex flex-col rounded-2xl border border-border bg-card transition-colors',
    compact ? 'min-h-[92px] gap-1.5 p-4' : 'min-h-[132px] gap-3 p-5',
    href && 'hover:border-primary/60',
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
        variant === 'frame' && 'grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6',
        variant === 'cards' &&
          'grid gap-3 [grid-template-columns:repeat(auto-fill,minmax(148px,1fr))]',
        className,
      )}
    >
      {children}
    </div>
  );
}

export function DataTable({ children }: { children: ReactNode }) {
  return (
    <div className="w-full overflow-hidden overflow-x-auto rounded-2xl border border-border bg-card">
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
        'rounded-2xl border border-dashed border-border px-5 py-14 text-center text-muted-foreground',
        LABEL,
      )}
    >
      {children}
    </div>
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

export function TonePill({
  tone = 'dim',
  children,
  className,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
}) {
  const style = TONE_PILL[tone];
  return (
    <span
      className={cn(
        'inline-flex w-fit items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium',
        style.border,
        style.bg,
        style.text,
        className,
      )}
    >
      <span aria-hidden="true" className={cn('size-1.5 shrink-0 rounded-full', style.dot)} />
      {children}
    </span>
  );
}

export function StatusPill({ status }: { status: string }) {
  return (
    <TonePill tone={STATUS_TONE[status] ?? 'dim'} className="capitalize">
      {status}
    </TonePill>
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
    <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
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

export { Time } from './time';
