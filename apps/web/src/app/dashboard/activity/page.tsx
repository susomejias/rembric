import { Activity, BrainCircuit, Gavel, ListChecks, Radio } from 'lucide-react';
import Link from 'next/link';

import { relativeTime } from '@/components/dashboard/support';
import {
  EmptyNote,
  Page,
  PageHead,
  Panel,
  PanelHead,
  Pill,
  Row,
  Rows,
  StatTile,
  Time,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * Activity — the v0 "signal log" view, derived from the corpus rather than from
 * an event stream. Rembric keeps no event table on purpose: this page composes
 * the four records that *are* durable — memory writes, judged relations, session
 * starts and consolidation runs — into one chronological reading.
 *
 * The mockup's Activity view is a static list with the same shape; what changed
 * here is only where the rows come from. It needed no new repository method: the
 * four reads are the same admin* queries the other views already run.
 */
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
      <PageHead
        icon={Activity}
        eyebrow="System signals"
        title="Activity"
        description="A lightweight view of meaningful changes without storing a full event stream."
      />

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Recent writes"
          value={memoryWrites}
          tone="lime"
          hint="active memories sampled"
        />
        <StatTile label="Judged in 24h" value={judgedToday} hint={`${pending} still pending`} />
        <StatTile label="Live sessions" value={liveSessions} hint="open right now" />
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-2">
        <article className="rounded-2xl border border-border bg-muted p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] tracking-[.14em] text-primary uppercase">Signal policy</p>
              <h2 className="mt-2 text-base font-medium">Meaningful changes only</h2>
            </div>
            <span className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground">
              no event table
            </span>
          </div>
          <p className="mt-3 max-w-lg text-xs leading-5 text-muted-foreground">
            Activity is composed at read time from memory writes, judged relations, session starts
            and consolidation runs — not from a stream Rembric would have to retain and prune.
          </p>
        </article>
        <article className="rounded-2xl border border-border bg-muted p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] tracking-[.14em] text-primary uppercase">Storage model</p>
              <h2 className="mt-2 text-base font-medium">The audit trail is the data</h2>
            </div>
            <span className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground">
              SQLite
            </span>
          </div>
          <p className="mt-3 max-w-lg text-xs leading-5 text-muted-foreground">
            Every row this page shows is the record itself: append-only memories, the
            `consolidation_ops` journal, and the session rows.
          </p>
        </article>
      </section>

      <Panel className="mt-6">
        <PanelHead
          eyebrow="Signal log"
          title="Recent changes"
          action={`${signals.length} signals in this window`}
        />
        {signals.length === 0 ? (
          <EmptyNote>
            Nothing has happened yet. Save a memory from a connected client and it appears here.
          </EmptyNote>
        ) : (
          <Rows>
            {signals.slice(0, 40).map((signal) => (
              <Row key={signal.id} columns="md:grid-cols-[auto_1.5fr_1fr_auto]">
                <span className="grid size-7 place-items-center rounded-lg bg-accent text-muted-foreground">
                  <SignalIcon kind={signal.kind} />
                </span>
                <div className="min-w-0">
                  <Link href={signal.href} className="text-sm text-foreground hover:text-primary">
                    {signal.title}
                  </Link>
                  <p className="mt-1 text-[10px] text-muted-foreground">{signal.detail}</p>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {relativeTime(signal.at, nowMs)}
                </span>
                <Pill tone={signal.tone}>{signal.kind}</Pill>
              </Row>
            ))}
          </Rows>
        )}
      </Panel>

      <p className="mt-4 text-[11px] text-muted-foreground">
        Newest signal in this reading: {signals[0] ? <Time value={signals[0].at} /> : '—'}
      </p>
    </Page>
  );
}

function SignalIcon({ kind }: { kind: Signal['kind'] }) {
  if (kind === 'memory') return <BrainCircuit className="size-3.5" />;
  if (kind === 'judgment') return <Gavel className="size-3.5" />;
  if (kind === 'session') return <Radio className="size-3.5" />;
  return <ListChecks className="size-3.5" />;
}
