import { OverviewActivityCard, Sparkline } from '@/components/dashboard/overview-activity-card';
import { OverviewConsolidationHealth } from '@/components/dashboard/overview-consolidation-health';
import {
  orphanThresholds,
  readSystemInfo,
  scopeLabel,
  sevenDayActivity,
} from '@/components/dashboard/overview-data';
import { OverviewRecentJudgments } from '@/components/dashboard/overview-recent-judgments';
import { OverviewRecentSessions } from '@/components/dashboard/overview-recent-sessions';
import { OverviewSystemCard } from '@/components/dashboard/overview-system-card';
import { StatCard } from '@/components/dashboard/stat-card';
import { ViewHead } from '@/components/dashboard/view-head';
import { getServices } from '@/lib/services';

/**
 * The overview — every section the retired Hono home rendered
 * (`apps/server/src/server/dashboard-router.ts`'s `GET /`), as a server
 * component reading `@rembric/core`/`@rembric/db` directly: the six-card stat
 * strip in its declared order, the recent-judgments and recent-sessions tiles,
 * the consolidation-health strip, and the activity and system cards.
 *
 * The reads are deliberately the retired handler's own — the same repository
 * methods, the same limits (4 judgments, 5 sessions, 7 days) and the same
 * unfiltered scope, because this page is the operator's whole-corpus view.
 */
export const dynamic = 'force-dynamic';

export default function DashboardOverviewPage() {
  const { agentSessions, db, repos } = getServices();

  const memoriesByStatus = repos.memory.countRowsByStatus();
  const totalMemories = memoriesByStatus.reduce((acc, row) => acc + row.count, 0);
  const activeMemories = memoriesByStatus.find((row) => row.status === 'active')?.count ?? 0;
  const archivedMemories = memoriesByStatus.find((row) => row.status === 'archived')?.count ?? 0;
  const supersededMemories = Math.max(0, totalMemories - activeMemories - archivedMemories);
  const projects = repos.projects.count();
  const archivedProjects = repos.projects.adminCountArchived();
  const activeSessions = agentSessions.adminCountByStatus().active;

  const activity = sevenDayActivity(repos);
  const recentJudgments = repos.relations.adminRecentJudged(4);
  const recentSessions = repos.agentSessions.adminRecent(5);
  const orphanedPendings = repos.relations.adminCountByStatus('orphaned');
  const thresholds = orphanThresholds();
  const system = readSystemInfo(db.raw.name);

  const lastRunRow = repos.consolidation.adminListRuns(1, 0).at(0) ?? null;
  const lastRunCounts = lastRunRow
    ? repos.consolidation.adminOpCounts(lastRunRow.id)
    : { total: 0, reverted: 0 };
  const lastRun = lastRunRow
    ? {
        id: lastRunRow.id,
        startedAt: lastRunRow.startedAt,
        finishedAt: lastRunRow.finishedAt,
        scopeLabel: scopeLabel(repos, lastRunRow.scope),
        totalOps: lastRunCounts.total,
        revertedOps: lastRunCounts.reverted,
      }
    : null;

  return (
    <div className="flex flex-col gap-3">
      <ViewHead title="Rembric Overview." />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard
          label="Total memories"
          value={totalMemories}
          href="/dashboard/memories"
          hint={
            <span className="flex items-center gap-2">
              <Sparkline data={activity} />
              <span>LAST 7 DAYS</span>
            </span>
          }
        />
        <StatCard
          label="Active memories"
          value={activeMemories}
          tone="accent"
          href="/dashboard/memories?status=active"
          hint={`${totalMemories > 0 ? Math.round((activeMemories / totalMemories) * 100) : 0}% OF TOTAL`}
        />
        <StatCard
          label="Superseded memories"
          value={supersededMemories}
          tone={supersededMemories > 0 ? 'warn' : 'accent'}
          hint="SAFE TO ARCHIVE"
          href="/dashboard/memories?status=superseded"
        />
        <StatCard
          label="Archived memories"
          value={archivedMemories}
          tone="dim"
          hint="DECAYED"
          href="/dashboard/memories?status=archived"
        />
        <StatCard
          label="Projects"
          value={projects}
          tone="accent"
          hint={`${archivedProjects} ARCHIVED`}
          href="/dashboard/projects"
        />
        <StatCard
          label="Active sessions"
          value={activeSessions}
          tone={activeSessions > 0 ? 'accent' : 'fg'}
          hint="CONNECTED NOW"
          href="/dashboard/sessions"
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <OverviewRecentJudgments rows={recentJudgments} />
        <OverviewRecentSessions rows={recentSessions} />
      </div>

      <OverviewConsolidationHealth
        lastRun={lastRun}
        orphanedPendings={orphanedPendings}
        thresholds={thresholds}
      />

      <div className="grid gap-3 lg:grid-cols-2">
        <OverviewActivityCard data={activity} />
        <OverviewSystemCard info={system} />
      </div>
    </div>
  );
}
