import { Activity } from 'lucide-react';
import Link from 'next/link';

import { relativeTime } from '@/components/dashboard/support';
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
  TableEmpty,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

type Signal = {
  id: string;
  kind: 'memory' | 'judgment' | 'session' | 'consolidation';
  title: string;
  detail: string;
  at: Date;
  href: string;
  tone: 'lime' | 'amber' | 'dim';
};

export default function ActivityPage() {
  const { repos } = getServices();
  const nowMs = Date.now();

  const memories = repos.memory.adminList({ status: 'active', limit: 20, offset: 0 });
  const judgments = repos.relations.adminRecentJudged(15);
  const sessions = repos.agentSessions.adminRecent(15);
  const runs = repos.consolidation.adminListRuns(10, 0);

  const projectSlug = new Map(repos.projects.adminListAll().map((p) => [p.id, p.slug]));

  const signals: Signal[] = [
    ...memories.map((memory) => ({
      id: `memory-${memory.id}`,
      kind: 'memory' as const,
      title: memory.title,
      detail: `${memory.type} · ${memory.projectId ? (projectSlug.get(memory.projectId) ?? 'project') : 'global scope'}`,
      at: memory.createdAt,
      href: `/dashboard/memories/${memory.id}`,
      tone: 'lime' as const,
    })),
    ...judgments.map((relation) => ({
      id: `judgment-${relation.id}`,
      kind: 'judgment' as const,
      title: `${relation.sourceTitle} → ${relation.relation ?? 'pending'}`,
      detail: relation.reason ?? 'verdict recorded',
      at: relation.judgedAt ?? relation.createdAt,
      href: `/dashboard/memories/${relation.sourceId}`,
      tone: 'lime' as const,
    })),
    ...sessions.map((session) => ({
      id: `session-${session.id}`,
      kind: 'session' as const,
      title: session.projectSlug ?? session.agent,
      detail: `${session.agent} · ${session.status} · ${session.memCount} memories`,
      at: session.startedAt,
      href: `/dashboard/sessions/${session.id}`,
      tone: session.status === 'active' ? ('lime' as const) : ('dim' as const),
    })),
    ...runs.map((run) => {
      const counts = repos.consolidation.adminOpCounts(run.id);
      return {
        id: `run-${run.id}`,
        kind: 'consolidation' as const,
        title: `Consolidation · ${run.scope}`,
        detail: `${counts.total} operations · ${counts.reverted} reverted`,
        at: run.startedAt,
        href: '/dashboard/consolidation',
        tone: run.finishedAt ? ('dim' as const) : ('amber' as const),
      };
    }),
  ].sort((a, b) => b.at.getTime() - a.at.getTime());

  const memoryWrites = signals.filter((signal) => signal.kind === 'memory').length;
  const judgedToday = signals.filter(
    (signal) => signal.kind === 'judgment' && nowMs - signal.at.getTime() < 86_400_000,
  ).length;
  const liveSessions =
    repos.agentSessions.adminCountByStatus().find((row) => row.status === 'active')?.count ?? 0;
  const pending = repos.relations.adminCountByStatus('pending');

  return (
    <Page>
      <ViewHead
        num="11"
        title="Rembric Activity."
        hl="Rembric"
        meta={[{ k: 'SIGNALS', v: signals.length }]}
      />

      <StatGrid className="mt-6 sm:grid-cols-3 xl:grid-cols-3">
        <StatCard
          k="RECENT WRITES"
          v={memoryWrites}
          tone="lime"
          sub={<span>ACTIVE MEMORIES SAMPLED</span>}
        />
        <StatCard k="JUDGED IN 24H" v={judgedToday} sub={<span>{pending} STILL PENDING</span>} />
        <StatCard
          k="LIVE SESSIONS"
          v={liveSessions}
          tone={liveSessions > 0 ? 'lime' : 'dim'}
          sub={<span>OPEN RIGHT NOW</span>}
        />
      </StatGrid>

      <div className="mt-6 grid gap-3 md:grid-cols-2">
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
                SIGNAL POLICY
              </p>
              <h2 className="mt-2 text-base font-medium">Meaningful changes only</h2>
            </div>
            <span className="rounded-full border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.12em] text-muted-foreground">
              no event table
            </span>
          </div>
          <p className="mt-3 max-w-lg text-xs leading-5 text-muted-foreground">
            Activity is composed at read time from memory writes, judged relations, session starts
            and consolidation runs — not from a stream Rembric would have to retain and prune.
          </p>
        </div>
        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
                STORAGE MODEL
              </p>
              <h2 className="mt-2 text-base font-medium">The audit trail is the data</h2>
            </div>
            <span className="rounded-full border border-border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.12em] text-muted-foreground">
              SQLite
            </span>
          </div>
          <p className="mt-3 max-w-lg text-xs leading-5 text-muted-foreground">
            Every row this page shows is the record itself: append-only memories, the
            `consolidation_ops` journal, and the session rows.
          </p>
        </div>
      </div>

      <div className="mt-8">
        <SectionBar name="Signal log" meta={`${signals.length} SIGNALS IN THIS WINDOW`} />
      </div>
      {signals.length === 0 ? (
        <TableEmpty>
          NOTHING HAS HAPPENED YET — save a memory from a connected client and it appears here
        </TableEmpty>
      ) : (
        <DataTable>
          <DataHead>
            <DataTh>kind</DataTh>
            <DataTh>signal</DataTh>
            <DataTh>when</DataTh>
          </DataHead>
          <DataBody>
            {signals.slice(0, 40).map((signal) => (
              <DataTr key={signal.id}>
                <DataTd>
                  <Pill tone={signal.tone}>{signal.kind}</Pill>
                </DataTd>
                <DataTd className="max-w-[560px] whitespace-normal">
                  <Link href={signal.href} className="transition-colors hover:text-primary">
                    {signal.title}
                  </Link>
                  <p className="mt-1 text-[11px] text-muted-foreground">{signal.detail}</p>
                </DataTd>
                <DataTd className="font-mono text-xs text-muted-foreground">
                  {relativeTime(signal.at, nowMs)}
                </DataTd>
              </DataTr>
            ))}
          </DataBody>
        </DataTable>
      )}

      <p className="mt-4 flex items-center gap-2 font-mono text-[11px] uppercase tracking-[.12em] text-muted-foreground">
        <Activity className="size-3" aria-hidden />
        NEWEST SIGNAL IN THIS READING: {signals[0] ? <Time value={signals[0].at} /> : '—'}
      </p>
    </Page>
  );
}
