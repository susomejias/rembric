import Link from 'next/link';
import type { ReactNode } from 'react';

import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';

/**
 * One stat in the overview strip — the React replacement for
 * `components.ts::statCard`. The same card is an anchor when it links to the
 * filtered view it counts.
 */
export function StatCard({
  label,
  value,
  hint,
  href,
  tone = 'fg',
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  href?: string;
  tone?: 'fg' | 'accent' | 'warn' | 'dim';
}) {
  const toneClass =
    tone === 'accent'
      ? 'text-brand-accent'
      : tone === 'warn'
        ? 'text-warn'
        : tone === 'dim'
          ? 'text-muted-foreground'
          : 'text-foreground';

  const body = (
    <CardContent className="flex flex-col gap-1">
      <span className="font-mono text-[0.66rem] tracking-[0.12em] text-muted-foreground uppercase">
        {label}
      </span>
      <span className={cn('font-display text-3xl font-semibold tabular-nums', toneClass)}>
        {value}
      </span>
      {hint ? <span className="font-mono text-xs text-muted-foreground">{hint}</span> : null}
    </CardContent>
  );

  return (
    <Card className={cn('gap-0 py-4', href && 'transition-colors hover:border-primary/50')}>
      {href ? (
        <Link href={href} className="block">
          {body}
        </Link>
      ) : (
        body
      )}
    </Card>
  );
}
