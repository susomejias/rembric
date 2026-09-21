import Link from 'next/link';
import type { ReactNode } from 'react';

import { resolveDataDir } from '@/app/dashboard/maintenance/data';
import { formatBytes, relativeTime, shortId, truncate } from '@/components/dashboard/support';
import {
  LABEL,
  Page,
  Pill,
  SectionBar,
  StatCard,
  StatGrid,
  StatusPill,
  TableEmpty,
  ViewHead,
} from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { getServices } from '@/lib/services';
import { cn } from '@/lib/utils';

/**
 * The overview — the operator's whole-corpus view, in the production
 * dashboard's composition: the six-cell stat strip, the recent-judgments and
 * recent-sessions rows, the consolidation-health strip, and the activity and
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
  const lastRunOps = lastRun
    ? repos.consolidation.adminOpCounts(lastRun.id)
    : { total: 0, reverted: 0 };

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
          tone="fg"
          sub={
            <>
              <Sparkline data={activity.days.map((day) => day.count)} />
              <span>LAST 7 DAYS</span>
            </>
          }
          href="/dashboard/memories"
        />
        <StatCard
          k="ACTIVE MEMORIES"
          v={activeMemories}
          tone="lime"
          sub={
            <>
              <span>{pctOfTotal(activeMemories, totalMemories)}</span>
              <span>OF TOTAL</span>
            </>
          }
          href="/dashboard/memories?status=active"
        />
        <StatCard
          k="SUPERSEDED MEMORIES"
          v={supersededMemories}
          tone={supersededMemories > 0 ? 'amber' : 'lime'}
          sub={
            <>
              <span>SAFE TO ARCHIVE</span>
              <span aria-hidden="true">›</span>
            </>
          }
          href="/dashboard/memories?status=superseded"
        />
        <StatCard
          k="ARCHIVED MEMORIES"
          v={archivedMemories}
          tone="fg"
          sub={
            <>
              <span>DECAYED</span>
              <span aria-hidden="true">›</span>
            </>
          }
          href="/dashboard/memories?status=archived"
        />
        <StatCard
          k="PROJECTS"
          v={projects}
          tone="lime"
          sub={
            <>
              <span>{archivedProjects}</span>
              <span>ARCHIVED</span>
            </>
          }
          href="/dashboard/projects"
        />
        <StatCard
          k="ACTIVE SESSIONS"
          v={activeSessions}
          tone={activeSessions > 0 ? 'lime' : 'fg'}
          sub={
            <>
              <span>CONNECTED NOW</span>
              <span aria-hidden="true">›</span>
            </>
          }
          href="/dashboard/sessions"
        />
      </StatGrid>

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0">
          <SectionBar
            name="Recent judgments"
            meta="NEWEST FIRST"
            more={<OpenAll href="/dashboard/judgments" />}
          />
          {recentJudgments.length === 0 ? (
            <TableEmpty>NO JUDGMENTS YET</TableEmpty>
          ) : (
            <div className="border border-border">
              {recentJudgments.map((relation) => (
                <div
                  key={relation.id}
                  className="grid gap-4 border-b border-border px-5 py-4 last:border-b-0 md:grid-cols-[1fr_220px]"
                >
                  <div className="flex min-w-0 flex-col gap-2">
                    <div className="flex flex-wrap items-baseline gap-3">
                      <Pill tone={relation.relation === null ? 'dim' : 'lime'}>
                        {relation.relation ?? 'pending'}
                      </Pill>
                      <span className={cn('text-muted-foreground', LABEL)}>
                        {relativeTime(relation.judgedAt ?? relation.createdAt, nowMs)}
                      </span>
                      {relation.markedByKind ? (
                        <span className={cn('text-muted-foreground', LABEL)}>
                          · {relation.markedByKind}
                        </span>
                      ) : null}
                    </div>
                    <div className="flex min-w-0 items-baseline gap-3">
                      <Link
                        href={`/dashboard/memories/${relation.sourceId}`}
                        className="min-w-0 truncate text-xs text-primary hover:underline"
                      >
                        {truncate(relation.sourceTitle, 70)}
                      </Link>
                    </div>
                    <div className="flex min-w-0 items-baseline gap-3">
                      <span aria-hidden="true" className="font-mono text-xs text-primary">
                        ↳
                      </span>
                      <Link
                        href={`/dashboard/memories/${relation.targetId}`}
                        className="min-w-0 truncate text-xs text-primary hover:underline"
                      >
                        {truncate(relation.targetTitle, 70)}
                      </Link>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-start gap-2 md:justify-end">
                    <Button asChild size="sm">
                      <Link href={`/dashboard/judgments/${relation.id}`} className="font-mono">
                        <span className="text-xs">VIEW →</span>
                      </Link>
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <div className="min-w-0">
          <SectionBar
            name="Recent sessions"
            meta="NEWEST FIRST"
            more={<OpenAll href="/dashboard/sessions" />}
          />
          {recentSessions.length === 0 ? (
            <TableEmpty>NO SESSIONS YET</TableEmpty>
          ) : (
            <div className="border border-border">
              {recentSessions.map((session) => (
                <Link
                  key={session.id}
                  href={`/dashboard/sessions/${session.id}`}
                  className="grid gap-1 border-b border-border px-4 py-3 last:border-b-0 hover:bg-muted/50 md:grid-cols-[130px_1fr_auto] md:items-baseline md:gap-4"
                >
                  <span className={cn('text-muted-foreground uppercase', LABEL)}>
                    {relativeTime(session.startedAt, nowMs)}
                  </span>
                  <span className="flex min-w-0 flex-wrap items-baseline gap-3">
                    <span className={cn('text-foreground uppercase', LABEL)}>
                      ▸ {session.agent}
                    </span>
                    <span className={cn('text-muted-foreground', LABEL)}>
                      / {session.projectSlug ?? '—'}
                    </span>
                    <span className="min-w-0 truncate text-xs text-foreground">
                      {truncate(session.summary ?? '—', 60)}
                    </span>
                    {session.summary && !session.summaryFinal ? <Pill tone="dim">raw</Pill> : null}
                  </span>
                  <span className={cn('flex flex-wrap items-baseline gap-3', LABEL)}>
                    <span className="text-muted-foreground">
                      <b className="font-semibold text-primary tabular-nums">{session.memCount}</b>{' '}
                      MEM
                    </span>
                    <StatusPill status={session.status === 'active' ? 'active' : 'judged'} />
                  </span>
                </Link>
              ))}
            </div>
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
            value={lastRunOps.total}
            sub={`${lastRunOps.reverted} REVERTED`}
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

      <div className="mt-8 grid gap-6 lg:grid-cols-[1.4fr_1fr]">
        <div className="min-w-0">
          <SectionBar name="Activity · 7 days" meta="MEMORIES CREATED · PER DAY" />
          <div
            className="flex items-end gap-2 border border-border bg-card p-5"
            aria-label="Memories created per day, last seven days"
          >
            {activity.days.map((day, index) => (
              <div
                key={day.day}
                className="flex flex-1 flex-col items-center gap-2"
                title={`${new Date(day.day * DAY_MS).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })} · ${day.count} memories`}
              >
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

        <div className="min-w-0">
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

/** Main's `.stat-n` sparkline: the same 64x16 polyline over the seven real buckets. */
function Sparkline({ data }: { data: ReadonlyArray<number> }) {
  if (data.length === 0) return <span>·</span>;
  const width = 64;
  const height = 16;
  const max = Math.max(...data, 1);
  const step = data.length > 1 ? width / (data.length - 1) : 0;
  const points = data
    .map((value, index) => {
      const x = (index * step).toFixed(1);
      const y = (height - (value / max) * height).toFixed(1);
      return `${x},${y}`;
    })
    .join(' ');
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      aria-hidden="true"
      className="text-muted-foreground"
    >
      <polyline fill="none" stroke="currentColor" strokeWidth={1.5} points={points} />
    </svg>
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
  value: ReactNode;
  tone?: 'lime' | 'amber' | 'dim';
  sub: string;
  mono?: boolean;
}) {
  const toneClass = tone === 'lime' ? 'text-primary' : tone === 'amber' ? 'text-warn' : '';
  return (
    <div className="flex flex-col gap-2 border-r border-b border-border px-5 py-4">
      <span className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
        <span aria-hidden="true" className="inline-block size-[0.55em] bg-primary" />
        {label}
      </span>
      <span
        className={
          mono
            ? 'font-mono text-xs'
            : `font-display text-xl font-bold tracking-[-.02em] ${toneClass}`
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
  value: ReactNode;
  tone?: 'lime' | 'dim';
}) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border pb-3 text-xs last:border-0 last:pb-0">
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
