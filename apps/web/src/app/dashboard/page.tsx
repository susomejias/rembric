import Link from 'next/link';

import { resolveDataDir } from '@/app/dashboard/maintenance/data';
import { formatBytes, relativeTime, shortId } from '@/components/dashboard/support';
import {
  DataBody,
  DataHead,
  DataTable,
  DataTd,
  DataTh,
  DataTr,
  Page,
  Pill,
  SectionBar,
  StatCard,
  StatGrid,
  StatusPill,
  TableEmpty,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The overview — the operator's whole-corpus view, in the production
 * dashboard's composition: the six stat cards, the recent-judgments and
 * recent-sessions tiles, the consolidation-health strip, and the activity and
 * system cards.
 *
 * Every read is the retired Hono home's own (`apps/server/src/server/dashboard-
 * router.ts`'s `GET /`): the same repository methods, the same limits, the same
 * unfiltered scope.
 */
export const dynamic = 'force-dynamic';

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
const DAY_MS = 86_400_000;

export default function DashboardOverviewPage() {
  const { agentSessions, db, repos } = getServices();
  const now = new Date();
  const nowMs = now.getTime();

  const memoriesByStatus = repos.memory.countRowsByStatus();
  const totalMemories = memoriesByStatus.reduce((acc, row) => acc + row.count, 0);
  const activeMemories = memoriesByStatus.find((row) => row.status === 'active')?.count ?? 0;
  const archivedMemories = memoriesByStatus.find((row) => row.status === 'archived')?.count ?? 0;
  const supersededMemories = Math.max(0, totalMemories - activeMemories - archivedMemories);

  const projects = repos.projects.count();
  const archivedProjects = repos.projects.adminCountArchived();
  const activeSessions = agentSessions.adminCountByStatus().active;
  const orphanedPendings = repos.relations.adminCountByStatus('orphaned');

  // The same seven-day window the ported overview charted, rebuilt from the
  // repository's own UTC day buckets so the two views cannot disagree.
  const activity = sevenDayActivity(
    repos.memory.adminCountCreatedByDay(new Date(nowMs - 6 * DAY_MS)),
  );

  const recentJudgments = repos.relations.adminRecentJudged(4);
  const recentSessions = repos.agentSessions.adminRecent(5);

  const lastRun = repos.consolidation.adminListRuns(1, 0).at(0) ?? null;
  const lastRunOps = lastRun ? repos.consolidation.adminListOps(lastRun.id) : [];
  const lastRunReverted = lastRunOps.filter((op) => op.revertedAt !== null).length;

  const pageCount = db.raw.pragma('page_count', { simple: true }) as number;
  const pageSize = db.raw.pragma('page_size', { simple: true }) as number;
  const dbSize = formatBytes(pageCount * pageSize);
  const dbPath = `${resolveDataDir()}/data.db`;
  const host = `${process.env.REMBRIC_HOST ?? '127.0.0.1'}:${process.env.REMBRIC_PORT ?? '8787'}`;

  return (
    <Page>
      <ViewHead num="01" title="Rembric Overview." hl="Rembric" />

      <StatGrid className="mt-6">
        <StatCard
          k="TOTAL MEMORIES"
          v={totalMemories}
          sub={<span>LAST 7 DAYS</span>}
          href="/dashboard/memories"
        />
        <StatCard
          k="ACTIVE MEMORIES"
          v={activeMemories}
          tone="lime"
          sub={<span>{pctOfTotal(activeMemories, totalMemories)} RECALLABLE</span>}
          href="/dashboard/memories?status=active"
        />
        <StatCard
          k="SUPERSEDED MEMORIES"
          v={supersededMemories}
          tone={supersededMemories > 0 ? 'amber' : 'lime'}
          sub={<span>SAFE TO ARCHIVE</span>}
          href="/dashboard/memories?status=superseded"
        />
        <StatCard
          k="ARCHIVED MEMORIES"
          v={archivedMemories}
          tone="dim"
          sub={<span>DECAYED</span>}
          href="/dashboard/memories?status=archived"
        />
        <StatCard
          k="PROJECTS"
          v={projects}
          tone="lime"
          sub={<span>{archivedProjects} ARCHIVED</span>}
          href="/dashboard/projects"
        />
        <StatCard
          k="ACTIVE SESSIONS"
          v={activeSessions}
          tone={activeSessions > 0 ? 'lime' : 'dim'}
          sub={<span>CONNECTED NOW</span>}
          href="/dashboard/sessions"
        />
      </StatGrid>

      <div className="mt-8 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <div>
          <SectionBar
            name="Recent judgments"
            meta="NEWEST FIRST"
            more={<OpenAll href="/dashboard/judgments" />}
          />
          {recentJudgments.length === 0 ? (
            <TableEmpty>NO JUDGMENTS YET</TableEmpty>
          ) : (
            <DataTable>
              <DataHead>
                <DataTh>verdict</DataTh>
                <DataTh>source → target</DataTh>
                <DataTh>judged</DataTh>
                <DataTh>actions</DataTh>
              </DataHead>
              <DataBody>
                {recentJudgments.map((relation) => (
                  <DataTr key={relation.id}>
                    <DataTd>
                      <Pill tone={relation.relation === null ? 'dim' : 'lime'}>
                        {relation.relation ?? 'pending'}
                      </Pill>
                    </DataTd>
                    <DataTd className="max-w-[360px] truncate">
                      <Link
                        href={`/dashboard/memories/${relation.sourceId}`}
                        className="transition-colors hover:text-primary"
                      >
                        {relation.sourceTitle}
                      </Link>
                      <span className="mx-2 text-muted-foreground">→</span>
                      <Link
                        href={`/dashboard/memories/${relation.targetId}`}
                        className="transition-colors hover:text-primary"
                      >
                        {relation.targetTitle}
                      </Link>
                    </DataTd>
                    <DataTd className="font-mono text-xs text-muted-foreground">
                      <Time value={relation.judgedAt ?? relation.createdAt} />
                    </DataTd>
                    <DataTd>
                      <Link
                        href={`/dashboard/judgments/${relation.id}`}
                        className="font-mono text-[11px] uppercase tracking-[.14em] hover:text-primary"
                      >
                        View →
                      </Link>
                    </DataTd>
                  </DataTr>
                ))}
              </DataBody>
            </DataTable>
          )}
        </div>

        <div>
          <SectionBar
            name="Recent sessions"
            meta="NEWEST FIRST"
            more={<OpenAll href="/dashboard/sessions" />}
          />
          {recentSessions.length === 0 ? (
            <TableEmpty>NO SESSIONS YET</TableEmpty>
          ) : (
            <DataTable>
              <DataHead>
                <DataTh>when</DataTh>
                <DataTh>agent</DataTh>
                <DataTh>project</DataTh>
                <DataTh>memories</DataTh>
                <DataTh>status</DataTh>
              </DataHead>
              <DataBody>
                {recentSessions.map((session) => (
                  <DataTr key={session.id}>
                    <DataTd className="font-mono text-xs text-muted-foreground">
                      <Time value={session.startedAt} />
                    </DataTd>
                    <DataTd>
                      <Link
                        href={`/dashboard/sessions/${session.id}`}
                        className="transition-colors hover:text-primary"
                      >
                        {session.agent}
                      </Link>
                    </DataTd>
                    <DataTd className="text-muted-foreground">{session.projectSlug ?? '—'}</DataTd>
                    <DataTd className="font-mono text-xs text-muted-foreground">
                      {session.memCount}
                    </DataTd>
                    <DataTd>
                      <StatusPill status={session.status} />
                    </DataTd>
                  </DataTr>
                ))}
              </DataBody>
            </DataTable>
          )}
        </div>
      </div>

      <div className="mt-8">
        <SectionBar
          name="Consolidation health"
          meta={lastRun ? `LAST RUN · ${shortId(lastRun.id)}` : 'NO RUN YET'}
          more={
            lastRun ? (
              <Link
                href={`/dashboard/consolidation/${lastRun.id}`}
                className="font-mono text-[11px] uppercase tracking-[.14em] text-primary hover:underline"
              >
                Open run →
              </Link>
            ) : undefined
          }
        />
        <div className="grid border-t border-l border-border sm:grid-cols-2 xl:grid-cols-4">
          <HealthCell
            label="Last run"
            value={lastRun ? 'OK' : '—'}
            tone={lastRun ? 'lime' : 'dim'}
            sub={
              lastRun ? `${relativeTime(lastRun.finishedAt ?? lastRun.startedAt, nowMs)}` : 'NEVER'
            }
          />
          <HealthCell
            label="Ops applied"
            value={lastRunOps.length}
            sub={`${lastRunReverted} REVERTED`}
          />
          <HealthCell
            label="Orphaned pendings"
            value={orphanedPendings}
            tone={orphanedPendings > 0 ? 'amber' : 'lime'}
            sub="ORPHANED BY THE SWEEP"
          />
          <HealthCell label="Trigger" value="ON SESSION START" sub="THROTTLED PER SCOPE" mono />
        </div>
      </div>

      <div className="mt-8 grid gap-6 xl:grid-cols-[1.4fr_1fr]">
        <div>
          <SectionBar name="Activity · 7 days" meta="MEMORIES CREATED · PER DAY" />
          <div
            className="flex items-end gap-2 border border-border bg-card p-5"
            aria-label="Memories created per day, last seven days"
          >
            {activity.days.map((day, index) => (
              <div key={day.day} className="flex flex-1 flex-col items-center gap-2">
                <div className="flex h-24 w-full items-end bg-muted">
                  <div
                    className="w-full bg-primary"
                    style={{
                      height: `${Math.max(4, Math.round((day.count / activity.peak) * 100))}%`,
                    }}
                    title={`${day.count} memories`}
                  />
                </div>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {WEEKDAYS[index]}
                </span>
              </div>
            ))}
          </div>
        </div>

        <div>
          <SectionBar name="System" meta="SQLITE · NODE · MCP" />
          <div className="flex flex-col gap-3 border border-border bg-card p-5">
            <SystemRow label="DB FILE" value={dbPath} tone="lime" />
            <SystemRow label="DB SIZE" value={dbSize} />
            <SystemRow label="FTS INDEX" value="memory_fts · contentless" />
            <SystemRow label="MCP SERVER" value={host} tone="lime" />
            <SystemRow label="NODE" value={process.versions.node} />
          </div>
        </div>
      </div>
    </Page>
  );
}

function OpenAll({ href }: { href: string }) {
  return (
    <Link
      href={href}
      className="font-mono text-[11px] uppercase tracking-[.14em] text-primary hover:underline"
    >
      OPEN ALL ›
    </Link>
  );
}

function HealthCell({
  label,
  value,
  tone,
  sub,
  mono = false,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'lime' | 'amber' | 'dim';
  sub: string;
  mono?: boolean;
}) {
  const toneClass =
    tone === 'lime' ? 'text-primary' : tone === 'amber' ? 'text-amber-600 dark:text-amber-400' : '';
  return (
    <div className="flex flex-col gap-2 border-r border-b border-border px-5 py-4">
      <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
        <span aria-hidden="true" className="inline-block size-[0.55em] bg-primary" />
        {label}
      </span>
      <span
        className={
          mono
            ? 'font-mono text-sm'
            : `font-display text-2xl font-bold tracking-[-.02em] ${toneClass}`
        }
      >
        {value}
      </span>
      <span className="font-mono text-[10px] uppercase tracking-[.12em] text-muted-foreground">
        {sub}
      </span>
    </div>
  );
}

function SystemRow({
  label,
  value,
  tone,
}: {
  label: string;
  value: React.ReactNode;
  tone?: 'lime' | 'dim';
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border pb-3 last:border-0 last:pb-0 text-xs">
      <span className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
        {label}
      </span>
      <span
        className={`max-w-[60%] truncate font-mono ${tone === 'lime' ? 'text-primary' : 'text-muted-foreground'}`}
      >
        {value}
      </span>
    </div>
  );
}

function pctOfTotal(part: number, total: number): string {
  if (total <= 0) return '0%';
  return `${Math.round((part / total) * 100)}%`;
}

function sevenDayActivity(rows: readonly { readonly day: number; readonly n: number }[]): {
  days: { day: number; count: number }[];
  peak: number;
} {
  const byDay = new Map(rows.map((row) => [row.day, row.n]));
  const today = Math.floor(Date.now() / DAY_MS);
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = today - 6 + index;
    return { day, count: byDay.get(day) ?? 0 };
  });
  return { days, peak: Math.max(1, ...days.map((entry) => entry.count)) };
}
