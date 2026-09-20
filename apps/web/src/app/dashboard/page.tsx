import { StatCard } from '@/components/dashboard/stat-card';
import { getServices } from '@/lib/services';

/**
 * The overview — the same counts the retired Hono home rendered, as a server
 * component reading `@rembric/core`/`@rembric/db` directly.
 *
 * This replaces the scaffold placeholder with real data. The full `dashboard-01`
 * composition (the seven-day activity sparkline, the recent-judgments and
 * recent-sessions tiles, the consolidation-health section) is phase 15 of
 * `redesign-dashboard-identity-and-port`; the stat strip is ported here in its
 * declared order because every count it needs is already available and the strip
 * is what makes the shell's navigation legible.
 */
export const dynamic = 'force-dynamic';

export default function DashboardOverviewPage() {
  const { agentSessions, repos } = getServices();

  const memoriesByStatus = repos.memory.countRowsByStatus();
  const totalMemories = memoriesByStatus.reduce((acc, row) => acc + row.count, 0);
  const activeMemories = memoriesByStatus.find((row) => row.status === 'active')?.count ?? 0;
  const archivedMemories = memoriesByStatus.find((row) => row.status === 'archived')?.count ?? 0;
  const supersededMemories = Math.max(0, totalMemories - activeMemories - archivedMemories);
  const projects = repos.projects.count();
  const archivedProjects = repos.projects.adminCountArchived();
  const activeSessions = agentSessions.adminCountByStatus().active;

  return (
    <div className="flex flex-col gap-4">
      <header className="flex flex-col gap-1">
        <p className="font-mono text-xs tracking-[0.18em] text-brand-accent uppercase">
          § 01 · Rembric operator surface
        </p>
        <h1 className="font-display text-2xl font-semibold tracking-tight">Overview</h1>
      </header>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="Total memories" value={totalMemories} href="/dashboard/memories" />
        <StatCard
          label="Active memories"
          value={activeMemories}
          tone="accent"
          href="/dashboard/memories?status=active"
        />
        <StatCard
          label="Superseded memories"
          value={supersededMemories}
          tone={supersededMemories > 0 ? 'warn' : 'accent'}
          hint="Safe to archive"
          href="/dashboard/memories?status=superseded"
        />
        <StatCard
          label="Archived memories"
          value={archivedMemories}
          tone="dim"
          hint="Decayed"
          href="/dashboard/memories?status=archived"
        />
        <StatCard
          label="Projects"
          value={projects}
          tone="accent"
          hint={`${archivedProjects} archived`}
          href="/dashboard/projects"
        />
        <StatCard
          label="Active sessions"
          value={activeSessions}
          tone={activeSessions > 0 ? 'accent' : 'fg'}
          hint="Connected now"
          href="/dashboard/sessions"
        />
      </div>
    </div>
  );
}
