import type { Repositories } from '@rembric/db';
import { ListChecks } from 'lucide-react';
import Link from 'next/link';

import {
  PAGE_SIZE,
  pageParam,
  relativeTime,
  shortId,
  truncate,
} from '@/components/dashboard/support';
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
 * The consolidation journal, in the v0 composition.
 *
 * Everything here is state, never a control: the sweep runs on session start and
 * from `/mcp` + `/api`, and reverting an op is a mutation whose Server Action
 * boundary is a separate slice. The view therefore renders the run history, the
 * op counts and the latest run's journal entries, and offers no dead button.
 */
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

/** The two judgment windows the sweep enforces, read the way the sweep reads them. */
function orphanThresholds(): { afterMs: number; deadlineMs: number } {
  return {
    afterMs: envInt('JUDGMENT_ORPHAN_AFTER_MS', 86_400_000, 60_000, 30 * 86_400_000),
    deadlineMs: envInt('JUDGMENT_ORPHAN_DEADLINE_MS', 14 * 86_400_000, 3_600_000, 365 * 86_400_000),
  };
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** `global`, `maintenance`, or the slug behind a `project:<id>` tuple. */
function scopeLabel(repos: Repositories, scope: string): string {
  if (!scope.startsWith('project:')) return scope;
  return repos.projects.adminFindById(scope.slice('project:'.length))?.slug ?? scope;
}

/** The journal's own clock: `H` below two days, `D` above. */
function formatWindow(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  return hours >= 48 ? `${Math.round(hours / 24)}D` : `${hours}H`;
}

export default async function ConsolidationPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const page = pageParam(params['page']);
  const offset = page * PAGE_SIZE;

  const { repos } = getServices();
  const nowMs = Date.now();

  const runsRaw = repos.consolidation.adminListRuns(PAGE_SIZE + 1, offset);
  const hasMore = runsRaw.length > PAGE_SIZE;
  const runs = runsRaw.slice(0, PAGE_SIZE);
  const total = repos.consolidation.adminCountRuns();

  const lastRun = repos.consolidation.adminListRuns(1, 0).at(0) ?? null;
  const lastRunOps = lastRun ? repos.consolidation.adminListOps(lastRun.id) : [];
  const lastRunCounts = lastRun
    ? repos.consolidation.adminOpCounts(lastRun.id)
    : { total: 0, reverted: 0 };
  const orphanedPendings = repos.relations.adminCountByStatus('orphaned');
  const pendingJudgments = repos.relations.adminCountByStatus('pending');
  const thresholds = orphanThresholds();

  return (
    <Page>
      <PageHead
        icon={ListChecks}
        eyebrow="Memory maintenance"
        title="Consolidation"
        description="A quiet queue for turning repeated context into durable, searchable memory."
        aside={<span className="text-[11px] text-muted-foreground)">{total} runs journaled</span>}
      />

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatTile
          label="Last run"
          value={lastRun ? 'OK' : '—'}
          tone={lastRun ? 'lime' : 'dim'}
          hint={
            lastRun ? (
              <>
                <Time value={lastRun.finishedAt ?? lastRun.startedAt} /> ·{' '}
                {scopeLabel(repos, lastRun.scope)}
              </>
            ) : (
              'Never run'
            )
          }
        />
        <StatTile
          label="Processed"
          value={lastRunCounts.total}
          hint={`${lastRunCounts.reverted} reverted`}
        />
        <StatTile
          label="Queued"
          value={pendingJudgments}
          tone={pendingJudgments > 0 ? 'amber' : 'dim'}
          hint={`${orphanedPendings} orphaned`}
        />
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-2">
        <article className="rounded-2xl border border-border bg-muted p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] tracking-[.14em] text-primary uppercase">Context</p>
              <h2 className="mt-2 text-base font-medium">Sweep behavior</h2>
            </div>
            <span className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground">
              deterministic
            </span>
          </div>
          <p className="mt-3 max-w-lg text-xs leading-5 text-muted-foreground">
            The sweep applies decay and deadline orphaning. It does not call an LLM and needs no
            cron job: it runs throttled on session start, and from the `/mcp` and `/api` routes.
          </p>
          <p className="mt-5 text-[11px] text-muted-foreground">
            Orphan after {formatWindow(thresholds.afterMs)} · deadline{' '}
            {formatWindow(thresholds.deadlineMs)}
          </p>
        </article>
        <article className="rounded-2xl border border-border bg-muted p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] tracking-[.14em] text-primary uppercase">Context</p>
              <h2 className="mt-2 text-base font-medium">Undoable work</h2>
            </div>
            <span className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground">
              journaled
            </span>
          </div>
          <p className="mt-3 max-w-lg text-xs leading-5 text-muted-foreground">
            Every consolidation operation is recorded with its affected memory ids, the id it
            created and the reasoning attached by the sweep, so a change can be inspected and
            reversed.
          </p>
          <Link
            href="/dashboard/maintenance"
            className="mt-5 inline-block text-[11px] text-primary hover:text-primary"
          >
            Database maintenance →
          </Link>
        </article>
      </section>

      <Panel className="mt-6">
        <PanelHead
          eyebrow="Pipeline"
          title="Recent maintenance"
          action={`${runs.length} of ${total}`}
        />
        {runs.length === 0 ? (
          <EmptyNote>No consolidation run has been recorded yet.</EmptyNote>
        ) : (
          <Rows>
            {runs.map((run) => {
              const counts = repos.consolidation.adminOpCounts(run.id);
              return (
                <Row key={run.id} columns="md:grid-cols-[auto_1.3fr_1fr_auto_auto]">
                  <span className="grid size-7 place-items-center rounded-lg bg-primary/10 text-[10px] text-primary">
                    <ListChecks className="size-3.5" />
                  </span>
                  <div>
                    <p className="text-sm text-foreground">{scopeLabel(repos, run.scope)}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {truncate(run.summary, 120) || 'no summary'}
                    </p>
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    <Time value={run.startedAt} />
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {counts.total} ops · {counts.reverted} reverted
                  </span>
                  <Pill tone={run.finishedAt ? 'lime' : 'amber'}>
                    {run.finishedAt ? 'complete' : 'running'}
                  </Pill>
                </Row>
              );
            })}
          </Rows>
        )}
        {hasMore || page > 0 ? (
          <div className="flex items-center justify-between gap-3 px-5 py-4 text-[11px] text-muted-foreground md:px-6">
            {page > 0 ? (
              <Link
                href={`/dashboard/consolidation?page=${page - 1}`}
                className="rounded-lg border border-border px-3 py-2 transition-colors hover:bg-accent hover:text-foreground"
              >
                ← Previous
              </Link>
            ) : (
              <span />
            )}
            <span>Page {page + 1}</span>
            {hasMore ? (
              <Link
                href={`/dashboard/consolidation?page=${page + 1}`}
                className="rounded-lg border border-border px-3 py-2 transition-colors hover:bg-accent hover:text-foreground"
              >
                Next →
              </Link>
            ) : (
              <span />
            )}
          </div>
        ) : null}
      </Panel>

      <Panel className="mt-6">
        <PanelHead
          eyebrow="Journal"
          title={
            lastRun
              ? `Operations in the latest run (${scopeLabel(repos, lastRun.scope)})`
              : 'Operations'
          }
          action={lastRun ? <Time value={lastRun.startedAt} /> : 'no run yet'}
        />
        {lastRunOps.length === 0 ? (
          <EmptyNote>No operation was journaled in the latest run.</EmptyNote>
        ) : (
          <Rows>
            {lastRunOps.map((op) => (
              <Row key={op.id} columns="md:grid-cols-[1fr_1.4fr_auto_auto]">
                <div>
                  <p className="text-sm text-foreground">{op.opType}</p>
                  <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                    {shortId(op.id)}
                  </p>
                </div>
                <p className="text-[11px] leading-5 text-muted-foreground">
                  {truncate(op.reasoning, 140) || `${op.affectedIds.length} affected`}
                </p>
                <span className="text-[11px] text-muted-foreground">
                  {relativeTime(op.appliedAt, nowMs)}
                </span>
                <Pill tone={op.revertedAt ? 'amber' : 'lime'}>
                  {op.revertedAt ? 'reverted' : 'applied'}
                </Pill>
              </Row>
            ))}
          </Rows>
        )}
      </Panel>
    </Page>
  );
}
