import type { AdminRecentSession } from '@rembric/db';
import Link from 'next/link';

import { RawBadge, StatusBadge } from '@/components/dashboard/badges';
import { EmptyState } from '@/components/dashboard/empty-state';
import { truncate } from '@/components/dashboard/format';
import { SectionCard } from '@/components/dashboard/overview-section';
import { RelativeTime } from '@/components/dashboard/overview-time';

/**
 * The `RECENT SESSIONS` tile — the right tile of the overview's second row: the
 * five newest non-deleted sessions, the same read the retired home performed.
 *
 * The whole row is the link to the session detail (the retired view wrapped each
 * row in one anchor), and the badges it carries are spans, so the row keeps a
 * single real navigation target.
 */
export function OverviewRecentSessions({ rows }: { rows: AdminRecentSession[] }) {
  return (
    <SectionCard name="RECENT SESSIONS" meta="NEWEST FIRST" moreHref="/dashboard/sessions">
      {rows.length === 0 ? (
        <div className="p-4">
          <EmptyState>NO SESSIONS YET</EmptyState>
        </div>
      ) : (
        <ul className="flex flex-col divide-y">
          {rows.map((row) => (
            <li key={row.id}>
              <Link
                href={`/dashboard/sessions/${row.id}`}
                className="flex items-center justify-between gap-4 p-4 transition-colors hover:bg-accent/40"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <span className="font-mono text-[0.66rem] tracking-[0.12em] text-muted-foreground uppercase">
                    <RelativeTime value={row.startedAt} />
                  </span>
                  <span className="flex flex-wrap items-baseline gap-2 text-sm">
                    <span className="text-brand-accent">▸ {row.agent}</span>
                    <span className="font-mono text-xs text-muted-foreground">
                      / {row.projectSlug ?? '—'}
                    </span>
                  </span>
                  <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
                    <span className="truncate">
                      {row.summary ? truncate(row.summary, 60) : '—'}
                    </span>
                    {row.summary && !row.summaryFinal ? <RawBadge /> : null}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  <span className="font-mono text-xs">
                    <b>{row.memCount}</b> MEM
                  </span>
                  <StatusBadge status={row.status === 'active' ? 'active' : 'judged'} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
