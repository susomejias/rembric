import type { AdminRelationWithContent } from '@rembric/db';
import Link from 'next/link';

import { VerdictBadge } from '@/components/dashboard/badges';
import { EmptyState } from '@/components/dashboard/empty-state';
import { truncate } from '@/components/dashboard/format';
import { SectionCard } from '@/components/dashboard/overview-section';
import { RelativeTime } from '@/components/dashboard/overview-time';
import { Button } from '@/components/ui/button';

/**
 * The `RECENT JUDGMENTS` tile — the left tile of the overview's second row: the
 * four most recently judged relations (`status = 'judged'`, `judged_at DESC`),
 * the same read the retired home performed.
 *
 * Each row keeps the shared verdict badge (never wrapped in an anchor, so the
 * memory links inside the row stay clickable) and offers `VIEW →` as its only
 * path to the judgment detail. Pending and orphaned rows are excluded by the
 * repository read, not here.
 */
export function OverviewRecentJudgments({ rows }: { rows: AdminRelationWithContent[] }) {
  return (
    <SectionCard name="RECENT JUDGMENTS" meta="NEWEST FIRST" moreHref="/dashboard/judgments">
      {rows.length === 0 ? (
        <div className="p-4">
          <EmptyState>NO JUDGMENTS YET</EmptyState>
        </div>
      ) : (
        <ul className="flex flex-col divide-y">
          {rows.map((row) => (
            <li key={row.id} className="flex items-start justify-between gap-4 p-4">
              <div className="flex min-w-0 flex-col gap-1.5">
                <div className="flex flex-wrap items-center gap-2 font-mono text-[0.66rem] tracking-[0.12em] uppercase">
                  <VerdictBadge kind={row.relation} />
                  <span className="text-muted-foreground">
                    <RelativeTime value={row.judgedAt} />
                  </span>
                  {row.markedByKind ? (
                    <span className="text-muted-foreground/70">{row.markedByKind}</span>
                  ) : null}
                </div>
                <Link
                  href={`/dashboard/memories/${row.sourceId}`}
                  className="truncate text-sm underline-offset-4 hover:underline"
                >
                  {truncate(row.sourceTitle, 70)}
                </Link>
                <div className="flex min-w-0 items-center gap-1.5 text-sm">
                  <span aria-hidden className="text-muted-foreground">
                    ↳
                  </span>
                  <Link
                    href={`/dashboard/memories/${row.targetId}`}
                    className="truncate underline-offset-4 hover:underline"
                  >
                    {truncate(row.targetTitle, 70)}
                  </Link>
                </div>
              </div>
              <Button asChild size="sm" className="shrink-0">
                <Link href={`/dashboard/judgments/${row.id}`}>VIEW →</Link>
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
