import { REVIEW_TTL_MS } from '@rembric/core';
import type { MemoryType } from '@rembric/db';
import {
  BrainCircuit,
  CheckCircle2,
  Gavel,
  LayoutDashboard,
  ShieldCheck,
  Sparkles,
} from 'lucide-react';
import Link from 'next/link';

import { formatBytes, relativeTime } from '@/components/dashboard/support';
import {
  Rows,
  Row,
  Page,
  PageHead,
  Panel,
  PanelHead,
  Pill,
  StatTile,
  Time,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The overview — the operator's whole-corpus view, in the v0 composition: the
 * live-session band, the four metric tiles, the memory-health and attention
 * panels, and the closing policy strip.
 *
 * Every read is the retired Hono home's own (`apps/server/src/server/dashboard-
 * router.ts`'s `GET /`): the same repository methods, the same limits, the same
 * unfiltered scope. `page.tsx` in the ported dashboard read them too; what
 * changed here is only the surface.
 */
export const dynamic = 'force-dynamic';

const TTL_BY_TYPE = Object.entries(REVIEW_TTL_MS).filter(
  (entry): entry is [MemoryType, number] => typeof entry[1] === 'number',
);

const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;
const DAY_MS = 86_400_000;

export default function DashboardOverviewPage() {
  const { agentSessions, db, repos } = getServices();
  const now = new Date();
  const nowMs = now.getTime();

  const memoriesByStatus = repos.memory.countRowsByStatus();
  const totalMemories = memoriesByStatus.reduce((acc, row) => acc + row.count, 0);
  const activeMemories = memoriesByStatus.find((row) => row.status === 'active')?.count ?? 0;
  const projects = repos.projects.count();
  const archivedProjects = repos.projects.adminCountArchived();
  const activeSessions = agentSessions.adminCountByStatus().active;
  const totalSessions = repos.agentSessions.adminCount({ deleted: false });
  const needsReview = repos.memory.adminCountNeedsReview({
    nowMs,
    ttlByType: TTL_BY_TYPE,
  });
  const pendingJudgments = repos.relations.adminCountByStatus('pending');
  const orphanedPendings = repos.relations.adminCountByStatus('orphaned');

  // The same seven-day window the ported overview charted, rebuilt from the
  // repository's own UTC day buckets so the two views cannot disagree.
  const activity = sevenDayActivity(
    repos.memory.adminCountCreatedByDay(new Date(nowMs - 6 * DAY_MS)),
  );

  const liveSessions = repos.agentSessions.adminList({
    deleted: false,
    status: 'active',
    activeFirst: true,
    limit: 3,
    offset: 0,
  });

  const lastRun = repos.consolidation.adminListRuns(1, 0).at(0) ?? null;
  const lastRunOps = lastRun ? repos.consolidation.adminOpCounts(lastRun.id) : null;
  const searchableShare =
    totalMemories > 0 ? Math.round((activeMemories / totalMemories) * 100) : 0;

  const pageCount = db.raw.pragma('page_count', { simple: true }) as number;
  const pageSize = db.raw.pragma('page_size', { simple: true }) as number;

  return (
    <Page>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <PageHead
          icon={LayoutDashboard}
          eyebrow="Workspace home"
          title="Your memory layer, at a glance."
        />
        <p className="max-w-md text-xs leading-5 text-(--ink)/45">
          Context between sessions, memory health, and what is running now.
        </p>
      </div>

      <section className="mt-5 rounded-2xl border border-(--accent-ink)/20 bg-(--surface-panel) shadow-[0_0_50px_rgba(196,242,63,.05)]">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-(--ink)/[7%] px-5 py-5 md:px-6">
          <div>
            <div className="flex items-center gap-2">
              <span className="size-2 rounded-full bg-lime-300 shadow-[0_0_12px_#c4f23f]" />
              <p className={`text-(--accent-ink)/70 text-[10px] tracking-[.14em] uppercase`}>
                Live now
              </p>
            </div>
            <h2 className="mt-2 text-xl font-medium tracking-[-.04em]">Sessions in progress</h2>
            <p className="mt-1 text-xs text-(--ink)/45">
              Context currently being created across your workspace.
            </p>
          </div>
          <span className="text-3xl font-medium tracking-[-.08em] text-(--accent-ink)">
            {activeSessions}
            <span className="ml-1 text-xs font-normal tracking-normal text-(--ink)/45">active</span>
          </span>
        </div>
        {liveSessions.length === 0 ? (
          <p className="px-5 py-5 text-xs text-(--ink)/45 md:px-6">
            No session is open right now. Start one from any connected client and its context
            appears here.
          </p>
        ) : (
          <div className="grid divide-y divide-(--ink)/[6%] md:grid-cols-3 md:divide-x md:divide-y-0">
            {liveSessions.map((session) => (
              <Link
                key={session.id}
                href={`/dashboard/sessions/${session.id}`}
                className="flex items-center gap-3 px-5 py-5 text-left transition-colors hover:bg-(--accent-ink)/[4%] md:px-6"
              >
                <span className="size-2 shrink-0 rounded-full bg-lime-300" />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-xs font-medium">
                    {session.projectSlug ?? session.title ?? 'Global scope'}
                  </p>
                  <p className="mt-1 truncate text-[11px] text-(--ink)/45">
                    {session.description ?? 'Session in progress'}
                  </p>
                  <p className={`mt-3 text-(--accent-ink)/60 text-[10px]`}>{session.agent}</p>
                </div>
                <span className="self-start text-[10px] text-(--ink)/25">
                  {relativeTime(session.startedAt, nowMs)}
                </span>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section className="mt-6 grid gap-3 sm:grid-cols-4">
        <StatTile
          label="Memories"
          value={totalMemories.toLocaleString('en-US')}
          hint={`${needsReview} to review`}
          tone={needsReview > 0 ? 'amber' : 'dim'}
          className="bg-(--surface-tile)"
        />
        <StatTile
          label="Sessions"
          value={totalSessions.toLocaleString('en-US')}
          hint={`${activeSessions} live`}
          className="bg-(--surface-tile)"
        />
        <StatTile
          label="Projects"
          value={projects}
          hint={`${archivedProjects} archived`}
          className="bg-(--surface-tile)"
        />
        <StatTile
          label="Storage"
          value={
            <>
              {formatBytes(pageCount * pageSize).replace(/ (B|KB|MB|GB|TB)$/, '')}
              <span className="ml-1 text-xs text-(--ink)/45">
                {formatBytes(pageCount * pageSize).replace(/^[\d.]+ /, '')}
              </span>
            </>
          }
          hint="local SQLite file"
          className="bg-(--surface-tile)"
        />
      </section>

      <section className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
        <Panel padded>
          <div className="flex items-start justify-between">
            <div>
              <p className={`text-(--ink)/38 text-[10px] tracking-[.14em] uppercase`}>
                Memory health
              </p>
              <h2 className="mt-2 text-xl font-medium tracking-[-.04em]">A clean context base</h2>
              <p className="mt-1 text-xs text-(--ink)/45">
                {activeMemories.toLocaleString('en-US')} active · {needsReview} awaiting review
              </p>
            </div>
            <BrainCircuit className="size-5 text-(--accent-ink-strong)" />
          </div>
          <div className="mt-7 flex flex-wrap items-center gap-7">
            <div
              className="relative grid size-28 shrink-0 place-items-center rounded-full"
              style={{
                background: `conic-gradient(#c4f23f 0 ${searchableShare}%, #3b463e ${searchableShare}% 100%)`,
              }}
            >
              <div className="grid size-20 place-items-center rounded-full bg-(--surface-panel)">
                <p className="text-xl font-medium">{searchableShare}%</p>
              </div>
            </div>
            <div className="flex flex-col gap-3 text-xs">
              <div>
                <p className="text-(--ink)/45">Last consolidation</p>
                <p className="mt-1 text-sm">
                  {lastRun ? <Time value={lastRun.startedAt} /> : 'Never run'}
                </p>
                {lastRunOps ? (
                  <p className="mt-1 text-[10px] text-(--ink)/38">
                    {lastRunOps.total} operation{lastRunOps.total === 1 ? '' : 's'} journaled
                  </p>
                ) : null}
              </div>
              <div>
                <p className="text-(--ink)/45">Database</p>
                <p className="mt-1 text-sm">Healthy · SQLite</p>
              </div>
            </div>
          </div>
        </Panel>

        <Panel padded>
          <div className="flex items-start justify-between">
            <div>
              <p className={`text-(--ink)/38 text-[10px] tracking-[.14em] uppercase`}>Attention</p>
              <h2 className="mt-2 text-xl font-medium tracking-[-.04em]">Worth a look</h2>
            </div>
            <ShieldCheck className="size-5 text-(--warn-ink)" />
          </div>
          <div className="mt-6 flex flex-col gap-3">
            <AttentionRow
              href="/dashboard/memories?review=needs_review"
              count={needsReview}
              label="Memories need review"
              detail="Past their review TTL — re-affirm with memory.confirm"
              tone="amber"
            />
            <AttentionRow
              href="/dashboard/judgments?status=pending"
              count={pendingJudgments}
              label="Judgments pending"
              detail="Candidate pairs waiting for a verdict"
              tone="lime"
            />
            <AttentionRow
              href="/dashboard/judgments?status=orphaned"
              count={orphanedPendings}
              label="Judgments orphaned"
              detail="Endpoints archived or superseded before a verdict"
              tone="dim"
            />
          </div>
          <div className="mt-5 flex items-center gap-3 text-xs text-(--ink)/45">
            <CheckCircle2 className="size-4 text-(--accent-ink)" />
            Append-only storage — nothing was deleted to reach this state
          </div>
        </Panel>
      </section>

      <Panel className="mt-6" padded>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Sparkles className="size-4 text-(--accent-ink-strong)" />
            <p className="text-xs text-(--ink)/45">
              Seven-day memory activity, by UTC day. Rembric organizes memory as you work.
            </p>
          </div>
          <div className="flex items-center gap-5 text-[11px] text-(--ink)/38">
            <span>Local-first</span>
            <span>Reversible</span>
            <span>Project-scoped</span>
          </div>
        </div>
        <div
          className="mt-5 flex items-end gap-2"
          aria-label="Memories created per day, last seven days"
        >
          {activity.days.map((day, index) => (
            <div key={day.day} className="flex flex-1 flex-col items-center gap-2">
              <div className="flex h-16 w-full items-end rounded-md bg-(--surface-tile)">
                <div
                  className="w-full rounded-md bg-(--accent-ink)/60"
                  style={{
                    height: `${Math.max(4, Math.round((day.count / activity.peak) * 100))}%`,
                  }}
                  title={`${day.count} memories`}
                />
              </div>
              <span className="text-[10px] text-(--ink)/25">{WEEKDAYS[index]}</span>
            </div>
          ))}
        </div>
      </Panel>

      <Panel className="mt-6">
        <PanelHead
          eyebrow="Recent signals"
          title="What changed lately"
          action={
            <Link
              href="/dashboard/activity"
              className="text-[11px] text-(--accent-ink)/75 hover:text-(--accent-ink)"
            >
              Open activity →
            </Link>
          }
        />
        <Rows>
          {repos.relations.adminRecentJudged(4).map((relation) => (
            <Row key={relation.id} columns="md:grid-cols-[auto_1.4fr_1fr_auto]">
              <span className="grid size-7 place-items-center rounded-lg bg-(--accent-ink)/[8%] text-(--accent-ink)/70">
                <Gavel className="size-3.5" />
              </span>
              <div>
                <p className="text-sm text-(--ink)/80">{relation.sourceTitle}</p>
                <p className="mt-1 text-[10px] text-(--ink)/38">
                  {relation.relation ?? 'pending'} → {relation.targetTitle}
                </p>
              </div>
              <span className="text-[11px] text-(--ink)/45">
                <Time value={relation.judgedAt ?? relation.createdAt} />
              </span>
              <Pill tone="lime">{relation.status}</Pill>
            </Row>
          ))}
        </Rows>
      </Panel>
    </Page>
  );
}

function AttentionRow({
  href,
  count,
  label,
  detail,
  tone,
}: {
  href: string;
  count: number;
  label: string;
  detail: string;
  tone: 'lime' | 'amber' | 'dim';
}) {
  const fill =
    tone === 'amber'
      ? 'bg-(--warn-surface) text-(--warn-ink)'
      : tone === 'lime'
        ? 'bg-(--accent-ink)/[8%] text-(--accent-ink)'
        : 'bg-(--ink)/[5%] text-(--ink)/55';
  return (
    <Link
      href={href}
      className="flex items-center gap-3 rounded-xl bg-(--ink)/[3%] p-3 transition-colors hover:bg-(--ink)/[6%]"
    >
      <span className={`grid size-8 shrink-0 place-items-center rounded-lg text-xs ${fill}`}>
        {count}
      </span>
      <div>
        <p className="text-xs">{label}</p>
        <p className="mt-1 text-[11px] text-(--ink)/45">{detail}</p>
      </div>
    </Link>
  );
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
