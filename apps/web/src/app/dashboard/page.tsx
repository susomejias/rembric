import Link from 'next/link';
import type { ReactNode } from 'react';

import { ActivityChart } from '@/components/dashboard/activity-chart';
import { RowTooltip } from '@/components/dashboard/row-tooltip';
import { formatBytes, relativeTime, truncate } from '@/components/dashboard/support';
import { NumberTicker } from '@/components/motion/number-ticker';
import { getServices } from '@/lib/services';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const DAY_MS = 86_400_000;

type FeedItem = {
  readonly key: string;
  readonly at: number;
  readonly text: string;
  readonly href: string;
  readonly live: boolean;
};

export default function DashboardOverviewPage() {
  const { agentSessions, db, repos } = getServices();
  const nowMs = Date.now();

  const allTokens = repos.tokens.listAll();
  const activeTokens = allTokens.filter(
    (token) =>
      token.revokedAt === null && (token.expiresAt === null || token.expiresAt.getTime() > nowMs),
  );

  const activeSessions = agentSessions.adminCountByStatus().active;
  const activeSessionRows = repos.agentSessions
    .adminRecent(20)
    .filter((session) => session.status === 'active')
    .slice(0, 5);
  const recentJudgments = repos.relations.adminRecentJudged(3);

  const activityRows59 = repos.memory.adminCountCreatedByDay(new Date(nowMs - 59 * DAY_MS));
  const today = Math.floor(nowMs / DAY_MS);
  const savedLast30 = sumDayCounts(activityRows59.filter((row) => row.day >= today - 29));
  const savedPrev30 = sumDayCounts(activityRows59.filter((row) => row.day < today - 29));
  const savedDelta =
    savedPrev30 > 0 ? Math.round(((savedLast30 - savedPrev30) / savedPrev30) * 100) : null;

  const consolidationRunsRecent = repos.consolidation
    .adminListRuns(200, 0)
    .filter((run) => run.startedAt.getTime() >= nowMs - 29 * DAY_MS);
  const opsByDay = new Map<number, number>();
  for (const run of consolidationRunsRecent) {
    for (const op of repos.consolidation.adminListOps(run.id)) {
      if (op.opType === 'noop' || op.opType === 'failed') continue;
      const day = Math.floor(op.appliedAt.getTime() / DAY_MS);
      opsByDay.set(day, (opsByDay.get(day) ?? 0) + 1);
    }
  }

  const activityDays = buildDays(activityRows59, opsByDay, 30, nowMs);
  const swept30 = [...opsByDay.entries()]
    .filter(([day]) => day >= today - 29)
    .reduce((acc, [, n]) => acc + n, 0);

  const lastRun = repos.consolidation.adminListRuns(1, 0).at(0) ?? null;
  const lastRunOps = lastRun
    ? repos.consolidation.adminOpCounts(lastRun.id)
    : { total: 0, reverted: 0 };
  const orphanedPendings = repos.relations.adminCountByStatus('orphaned');
  const healthy = orphanedPendings === 0;

  const pageCount = db.raw.pragma('page_count', { simple: true }) as number;
  const pageSize = db.raw.pragma('page_size', { simple: true }) as number;
  const dbSize = formatBytes(pageCount * pageSize);
  const mcpHost = `${process.env.REMBRIC_HOST ?? '127.0.0.1'}:${process.env.REMBRIC_PORT ?? '8787'}`;

  const feed: FeedItem[] = [
    ...activeSessionRows.map((session) => ({
      key: `session-${session.id}`,
      at: session.startedAt.getTime(),
      text: `session · ${session.agent}${session.summary ? ` · ${truncate(session.summary, 48)}` : ''}`,
      href: `/dashboard/sessions/${session.id}`,
      live: session.status === 'active',
    })),
    ...recentJudgments.map((relation) => ({
      key: `judgment-${relation.id}`,
      at: (relation.judgedAt ?? relation.createdAt).getTime(),
      text: `judgment · ${relation.relation ?? 'pending'} · ${truncate(relation.sourceTitle, 40)}`,
      href: `/dashboard/judgments/${relation.id}`,
      live: false,
    })),
  ].sort((a, b) => b.at - a.at);

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-4">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Overview</h1>
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_460px]">
        <WidgetCard
          order="order-2 lg:order-1"
          label="MEMORY ACTIVITY"
          labelExtra={
            <span className="flex items-center gap-3">
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true" className="size-1.5 rounded-[2px] bg-primary" />
                <span className="font-mono text-[10px] text-muted-foreground">saves</span>
              </span>
              <span className="flex items-center gap-1.5">
                <span aria-hidden="true" className="size-1.5 rounded-[2px] bg-warn" />
                <span className="font-mono text-[10px] text-muted-foreground">sweep ops</span>
              </span>
              <span className="font-mono text-[10px] text-muted-foreground">30d</span>
            </span>
          }
          link={{ href: '/dashboard/memories', label: 'memories →' }}
        >
          <div className="flex items-center gap-3 px-5 pt-1">
            <NumberTicker
              value={savedLast30}
              locale
              className="text-2xl font-semibold text-foreground"
            />
            <span className="text-sm text-muted-foreground">saved</span>
            {savedDelta !== null && savedPrev30 >= 10 ? <DeltaChip value={savedDelta} /> : null}
            {swept30 > 0 ? (
              <span className="text-sm text-muted-foreground">· {swept30} swept</span>
            ) : null}
          </div>
          <ActivityChart days={activityDays} />
        </WidgetCard>

        <WidgetCard
          order="order-1 lg:order-2"
          label="ACTIVE SESSIONS"
          labelExtra={
            activeSessions > 0 ? (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[9px] font-semibold text-primary">
                {activeSessions} LIVE
              </span>
            ) : null
          }
          link={{ href: '/dashboard/sessions', label: 'view all →' }}
          featured
        >
          <div className="px-5 pt-1">
            <NumberTicker
              value={activeSessions}
              className="text-2xl font-semibold text-foreground"
            />
          </div>
          <ul className="mt-3 flex flex-col">
            {activeSessionRows.length === 0 ? (
              <li className="px-5 py-3 text-sm text-muted-foreground">
                No active sessions right now
              </li>
            ) : (
              activeSessionRows.map((session, index) => (
                <li key={session.id}>
                  <RowTooltip
                    placement={index === 0 ? 'bottom' : 'top'}
                    tooltip={
                      <div className="flex flex-col gap-1">
                        <p className="whitespace-pre-line text-xs leading-relaxed text-foreground">
                          {session.summary ?? 'No summary yet'}
                        </p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {session.agent} · {session.projectSlug ?? 'global'} · {session.memCount}{' '}
                          mems
                        </p>
                      </div>
                    }
                  >
                    <Link
                      href={`/dashboard/sessions/${session.id}`}
                      className="flex items-center gap-3 rounded-lg px-5 py-2 hover:bg-accent/50"
                    >
                      <span className="w-20 shrink-0 whitespace-nowrap rounded bg-primary/15 px-1.5 py-0.5 text-center font-mono text-[9px] uppercase text-primary">
                        {session.agent}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {session.summary ?? session.projectSlug ?? '—'}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {relativeTime(session.startedAt, nowMs)}
                      </span>
                    </Link>
                  </RowTooltip>
                </li>
              ))
            )}
            {activeSessions > activeSessionRows.length ? (
              <li className="px-5 pt-2 font-mono text-[10px] text-muted-foreground">
                +{activeSessions - activeSessionRows.length} more active · view all →
              </li>
            ) : null}
          </ul>
        </WidgetCard>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[440fr_180fr_628fr]">
        <WidgetCard
          label="LATEST JUDGMENTS"
          link={{ href: '/dashboard/judgments', label: 'view all →' }}
        >
          <ul className="mt-1 flex flex-col">
            {recentJudgments.length === 0 ? (
              <li className="px-5 py-3 text-sm text-muted-foreground">No judgments yet</li>
            ) : (
              recentJudgments.map((relation, index) => (
                <li key={relation.id}>
                  <RowTooltip
                    placement={index === 0 ? 'bottom' : 'top'}
                    tooltip={
                      <div className="flex flex-col gap-1">
                        <p className="text-xs text-foreground">{relation.sourceTitle}</p>
                        <p className="text-xs text-muted-foreground">↳ {relation.targetTitle}</p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {relation.relation ?? 'pending'} ·{' '}
                          {relativeTime(relation.judgedAt ?? relation.createdAt, nowMs)}
                        </p>
                      </div>
                    }
                  >
                    <Link
                      href={`/dashboard/judgments/${relation.id}`}
                      className="flex items-center gap-3 rounded-lg px-5 py-2.5 hover:bg-accent/50"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          index === 0 ? 'bg-primary' : 'bg-chart-4',
                        )}
                      />
                      <span
                        className={cn(
                          'min-w-0 flex-1 truncate text-sm',
                          index === 0 ? 'text-foreground' : 'text-muted-foreground',
                        )}
                      >
                        {truncate(relation.sourceTitle, 34)}
                      </span>
                      {relation.relation !== null ? (
                        <span
                          className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 font-mono text-[9px]',
                            index === 0
                              ? 'bg-primary/15 text-primary'
                              : 'bg-input text-muted-foreground',
                          )}
                        >
                          {relation.relation}
                        </span>
                      ) : null}
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {relativeTime(relation.judgedAt ?? relation.createdAt, nowMs)}
                      </span>
                    </Link>
                  </RowTooltip>
                </li>
              ))
            )}
          </ul>
        </WidgetCard>

        <WidgetCard label="ACTIVE TOKENS" link={{ href: '/dashboard/tokens', label: 'tokens →' }}>
          <div className="flex items-center gap-2 px-5 pt-1">
            <NumberTicker
              value={activeTokens.length}
              className="text-4xl font-semibold text-foreground"
            />
            <span className="text-sm text-muted-foreground">of {allTokens.length}</span>
          </div>
        </WidgetCard>

        <WidgetCard
          label="CONSOLIDATION HEALTH"
          labelExtra={
            <span
              className={cn(
                'font-mono text-[10px] font-semibold',
                healthy ? 'text-primary' : 'text-warn',
              )}
            >
              {healthy ? 'healthy' : 'attention'}
            </span>
          }
          link={{ href: '/dashboard/consolidation', label: 'consolidation →' }}
        >
          <div className="grid grid-cols-2 gap-x-4 gap-y-3 px-5 pt-1 sm:grid-cols-4">
            <Metric value={lastRunOps.total} label="OPS APPLIED" />
            <Metric
              value={lastRun ? relativeTime(lastRun.finishedAt ?? lastRun.startedAt, nowMs) : '—'}
              label="LAST SWEEP"
            />
            <Metric value={lastRunOps.reverted} label="REVERTED" />
            <Metric value={orphanedPendings} label="ORPHANED" tone={healthy ? 'lime' : 'warn'} />
          </div>
          <div className="px-5 pt-4">
            <div className="h-1 overflow-hidden rounded-full bg-input">
              <div
                className="h-full rounded-full bg-primary/50"
                style={{
                  width:
                    lastRunOps.total > 0
                      ? `${Math.round(((lastRunOps.total - lastRunOps.reverted) / lastRunOps.total) * 100)}%`
                      : '100%',
                }}
              />
            </div>
          </div>
        </WidgetCard>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[1fr_400px]">
        <WidgetCard
          label="LIVE AGENT ACTIVITY"
          featured
          labelExtra={
            activeSessions > 0 ? (
              <span className="rounded-full bg-primary/15 px-2 py-0.5 font-mono text-[9px] font-semibold text-primary">
                LIVE
              </span>
            ) : null
          }
          link={{ href: '/dashboard/sessions', label: 'view all →' }}
        >
          <ul className="mt-1 flex flex-col">
            {feed.length === 0 ? (
              <li className="px-5 py-3 text-sm text-muted-foreground">No activity yet</li>
            ) : (
              feed.map((item) => (
                <li key={item.key}>
                  <RowTooltip
                    tooltip={
                      <div className="flex flex-col gap-1">
                        <p className="text-xs text-foreground">{item.text}</p>
                        <p className="font-mono text-[10px] text-muted-foreground">
                          {new Date(item.at).toLocaleString('en-GB', {
                            dateStyle: 'medium',
                            timeStyle: 'short',
                          })}
                        </p>
                      </div>
                    }
                  >
                    <Link
                      href={item.href}
                      className="flex items-center gap-3 rounded-lg px-5 py-2.5 hover:bg-accent/50"
                    >
                      <span
                        aria-hidden="true"
                        className={cn(
                          'size-2 shrink-0 rounded-full',
                          item.live ? 'animate-pulse bg-primary' : 'bg-chart-4',
                        )}
                      />
                      <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                        {item.text}
                      </span>
                      <span className="shrink-0 font-mono text-[11px] text-muted-foreground">
                        {relativeTime(new Date(item.at), nowMs)}
                      </span>
                    </Link>
                  </RowTooltip>
                </li>
              ))
            )}
          </ul>
        </WidgetCard>

        <WidgetCard label="SYSTEM HEALTH">
          <div className="flex flex-col px-5 pt-1">
            <HealthRow label="MCP endpoint" value={mcpHost} tone="lime" />
            <HealthRow label="FTS index" value="memory_fts · contentless" />
            <HealthRow label="Node" value={process.versions.node} />
            <HealthRow label="DB size" value={dbSize} />
          </div>
          <div className="px-5 pt-4">
            <Link
              href="/dashboard/maintenance"
              className="flex h-10 items-center justify-center rounded-lg bg-input text-sm text-foreground transition-colors hover:bg-accent"
            >
              Run maintenance…
            </Link>
          </div>
        </WidgetCard>
      </div>
    </div>
  );
}

function WidgetCard({
  label,
  labelExtra,
  link,
  featured = false,
  order,
  children,
}: {
  label: string;
  labelExtra?: ReactNode;
  link?: { readonly href: string; readonly label: string };
  featured?: boolean;
  order?: string;
  children: ReactNode;
}) {
  return (
    <section
      className={cn(
        'flex min-w-0 flex-col rounded-2xl border pb-3 pt-4',
        featured
          ? 'border-[#2a3310] bg-[linear-gradient(180deg,#131b08,#101012)]'
          : 'border-border bg-card',
        order,
      )}
    >
      <header className="flex items-center gap-3 px-5 pb-1">
        <h2 className="font-mono text-[10px] tracking-[.14em] text-muted-foreground">{label}</h2>
        {labelExtra}
        {link ? (
          <Link
            href={link.href}
            className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground transition-colors hover:text-foreground"
          >
            {link.label}
          </Link>
        ) : null}
      </header>
      {children}
    </section>
  );
}

function DeltaChip({ value }: { value: number }) {
  const label = `${value >= 0 ? '+' : ''}${value}%`;
  return (
    <span
      className={cn(
        'rounded-md px-2 py-0.5 font-mono text-[11px] font-semibold',
        value >= 0 ? 'bg-primary/15 text-primary' : 'bg-input text-muted-foreground',
      )}
    >
      {label}
    </span>
  );
}

function Metric({
  value,
  label,
  tone,
}: {
  value: ReactNode;
  label: string;
  tone?: 'lime' | 'warn';
}) {
  return (
    <div className="min-w-0">
      <div
        className={cn(
          'truncate text-lg font-semibold',
          tone === 'lime' ? 'text-primary' : tone === 'warn' ? 'text-warn' : 'text-foreground',
        )}
      >
        {value}
      </div>
      <div className="mt-0.5 font-mono text-[9px] tracking-[.12em] text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function HealthRow({ label, value, tone }: { label: string; value: string; tone?: 'lime' }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-border/60 py-2.5 last:border-0">
      <span className="text-sm text-muted-foreground">{label}</span>
      <span
        className={cn(
          'max-w-[60%] truncate font-mono text-[11px]',
          tone === 'lime' ? 'text-primary' : 'text-muted-foreground',
        )}
      >
        {value}
      </span>
    </div>
  );
}

function sumDayCounts(rows: readonly { readonly day: number; readonly n: number }[]): number {
  return rows.reduce((acc, row) => acc + row.n, 0);
}

function buildDays(
  rows: readonly { readonly day: number; readonly n: number }[],
  opsByDay: ReadonlyMap<number, number>,
  count: number,
  nowMs: number,
): { day: number; saves: number; ops: number; isToday: boolean }[] {
  const byDay = new Map(rows.map((row) => [row.day, row.n]));
  const today = Math.floor(nowMs / DAY_MS);
  return Array.from({ length: count }, (_, index) => {
    const day = today - count + 1 + index;
    return {
      day,
      saves: byDay.get(day) ?? 0,
      ops: opsByDay.get(day) ?? 0,
      isToday: day === today,
    };
  });
}
