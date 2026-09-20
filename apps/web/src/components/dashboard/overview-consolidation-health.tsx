import { DEFAULT_MIN_INTERVAL_MS } from '@rembric/core';

import { formatWindow, shortDisplayId } from '@/components/dashboard/overview-data';
import { SectionBar } from '@/components/dashboard/overview-section';
import { RelativeTime } from '@/components/dashboard/overview-time';
import { StatCard } from '@/components/dashboard/stat-card';

/**
 * The `CONSOLIDATION HEALTH` strip — the four cells the retired home rendered
 * under a section bar whose meta carried the last run's short id and whose
 * `OPEN RUN ›` anchor led to it.
 *
 * The trust is about the corpus, not about a page: the last run is read
 * independently of any pagination, and the op counts come from its journal.
 */

export interface OverviewLastRun {
  id: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  scopeLabel: string;
  totalOps: number;
  revertedOps: number;
}

export function OverviewConsolidationHealth({
  lastRun,
  orphanedPendings,
  thresholds,
}: {
  lastRun: OverviewLastRun | null;
  orphanedPendings: number;
  thresholds: { afterMs: number; deadlineMs: number };
}) {
  return (
    <section className="flex flex-col gap-2">
      <SectionBar
        name="CONSOLIDATION HEALTH"
        meta={lastRun ? `LAST RUN · ${shortDisplayId(lastRun.id)}` : 'NO RUN YET'}
        moreHref={lastRun ? `/dashboard/consolidation/${lastRun.id}` : undefined}
        moreLabel="OPEN RUN ›"
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Last run"
          value={lastRun ? 'OK' : '—'}
          tone={lastRun ? 'accent' : 'dim'}
          hint={
            lastRun ? (
              <>
                <RelativeTime value={lastRun.finishedAt ?? lastRun.startedAt} /> ·{' '}
                {lastRun.scopeLabel}
              </>
            ) : (
              'NEVER'
            )
          }
        />
        <StatCard
          label="Ops applied"
          value={lastRun?.totalOps ?? 0}
          hint={`${lastRun?.revertedOps ?? 0} REVERTED`}
        />
        <StatCard
          label="Orphaned pendings"
          value={orphanedPendings}
          tone={orphanedPendings > 0 ? 'warn' : 'accent'}
          hint={`RE-EXPOSED > ${formatWindow(thresholds.afterMs)} · ORPHANED > ${formatWindow(
            thresholds.deadlineMs,
          )}`}
          href="/dashboard/judgments?status=orphaned"
        />
        <StatCard
          label="Trigger"
          value={<span className="font-mono text-lg">ON SESSION START</span>}
          hint={`THROTTLED ${formatWindow(
            DEFAULT_MIN_INTERVAL_MS,
          )} / SCOPE · MANUAL FROM CONSOLIDATION`}
        />
      </div>
    </section>
  );
}
