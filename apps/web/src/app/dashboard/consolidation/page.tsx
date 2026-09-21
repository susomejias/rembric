import type { Repositories } from '@rembric/db';
import Link from 'next/link';

import {
  PAGE_SIZE,
  pageParam,
  relativeTime,
  shortId,
  truncate,
} from '@/components/dashboard/support';
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

/**
 * The consolidation journal, in the production dashboard's composition: the
 * numbered view head, the run and queue stats, the sweep context, and the run
 * history and latest-run journal as tables.
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
      <ViewHead
        num="05"
        title="Rembric Consolidation."
        hl="Rembric"
        meta={[{ k: 'TOTAL', v: total }]}
      />

      <StatGrid className="mt-6 sm:grid-cols-3 xl:grid-cols-3">
        <StatCard
          k="LAST RUN"
          v={lastRun ? 'OK' : '—'}
          tone={lastRun ? 'lime' : 'dim'}
          sub={
            lastRun ? (
              <span>
                <Time value={lastRun.finishedAt ?? lastRun.startedAt} /> ·{' '}
                {scopeLabel(repos, lastRun.scope)}
              </span>
            ) : (
              <span>NEVER RUN</span>
            )
          }
        />
        <StatCard
          k="OPS APPLIED"
          v={lastRunCounts.total}
          sub={<span>{lastRunCounts.reverted} REVERTED</span>}
        />
        <StatCard
          k="ORPHANED PENDINGS"
          v={orphanedPendings}
          tone={orphanedPendings > 0 ? 'amber' : 'dim'}
          sub={<span>{pendingJudgments} STILL QUEUED</span>}
        />
      </StatGrid>

      <div className="mt-6 grid gap-3 md:grid-cols-2">
        <div className="border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
                CONTEXT
              </p>
              <h2 className="mt-2 text-base font-medium">Sweep behavior</h2>
            </div>
            <span className="border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-muted-foreground">
              deterministic
            </span>
          </div>
          <p className="mt-3 max-w-lg text-xs leading-5 text-muted-foreground">
            The sweep applies decay and deadline orphaning. It does not call an LLM and needs no
            cron job: it runs throttled on session start, and from the `/mcp` and `/api` routes.
          </p>
          <p className="mt-5 font-mono text-[11px] uppercase tracking-[.12em] text-muted-foreground">
            ORPHAN AFTER {formatWindow(thresholds.afterMs)} · DEADLINE{' '}
            {formatWindow(thresholds.deadlineMs)}
          </p>
        </div>
        <div className="border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
                CONTEXT
              </p>
              <h2 className="mt-2 text-base font-medium">Undoable work</h2>
            </div>
            <span className="border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-muted-foreground">
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
            className="mt-5 inline-block font-mono text-[11px] uppercase tracking-[.12em] text-primary hover:underline"
          >
            DATABASE MAINTENANCE →
          </Link>
        </div>
      </div>

      <div className="mt-8">
        <SectionBar name="Pipeline" meta={`${runs.length} OF ${total}`} />
      </div>
      {runs.length === 0 ? (
        <TableEmpty>NO CONSOLIDATION RUN HAS BEEN RECORDED YET</TableEmpty>
      ) : (
        <DataTable>
          <DataHead>
            <DataTh>started</DataTh>
            <DataTh>finished</DataTh>
            <DataTh>scope</DataTh>
            <DataTh>status</DataTh>
          </DataHead>
          <DataBody>
            {runs.map((run) => {
              const counts = repos.consolidation.adminOpCounts(run.id);
              return (
                <DataTr key={run.id}>
                  <DataTd className="font-mono text-xs text-muted-foreground">
                    <Link
                      href={`/dashboard/consolidation/${run.id}`}
                      className="hover:text-primary"
                    >
                      <Time value={run.startedAt} />
                    </Link>
                  </DataTd>
                  <DataTd className="font-mono text-xs text-muted-foreground">
                    <Time value={run.finishedAt} />
                  </DataTd>
                  <DataTd>{scopeLabel(repos, run.scope)}</DataTd>
                  <DataTd>
                    <Pill
                      tone={
                        counts.total === 0
                          ? 'dim'
                          : counts.reverted === counts.total
                            ? 'dim'
                            : counts.reverted > 0
                              ? 'amber'
                              : 'lime'
                      }
                    >
                      {counts.total === 0
                        ? 'no-op'
                        : counts.reverted === counts.total
                          ? 'fully reverted'
                          : counts.reverted > 0
                            ? `${counts.reverted}/${counts.total} reverted`
                            : `${counts.total} ops`}
                    </Pill>
                  </DataTd>
                </DataTr>
              );
            })}
          </DataBody>
        </DataTable>
      )}

      {hasMore || page > 0 ? (
        <div className="flex items-center justify-between gap-3 border-t border-border py-4 font-mono text-[11px] uppercase tracking-[.12em] text-muted-foreground">
          {page > 0 ? (
            <Link
              href={`/dashboard/consolidation?page=${page - 1}`}
              className="border border-border px-3 py-2 transition-colors hover:border-primary hover:text-primary"
            >
              ‹ PREV
            </Link>
          ) : (
            <span />
          )}
          <span>PAGE {page + 1}</span>
          {hasMore ? (
            <Link
              href={`/dashboard/consolidation?page=${page + 1}`}
              className="border border-border px-3 py-2 transition-colors hover:border-primary hover:text-primary"
            >
              NEXT ›
            </Link>
          ) : (
            <span />
          )}
        </div>
      ) : null}

      <div className="mt-8">
        <SectionBar
          name={lastRun ? `Operations in the latest run` : 'Operations'}
          meta={lastRun ? scopeLabel(repos, lastRun.scope) : 'NO RUN YET'}
        />
      </div>
      {lastRunOps.length === 0 ? (
        <TableEmpty>NO OPERATION WAS JOURNALED IN THE LATEST RUN</TableEmpty>
      ) : (
        <DataTable>
          <DataHead>
            <DataTh>type</DataTh>
            <DataTh>affected</DataTh>
            <DataTh>created</DataTh>
            <DataTh>reasoning</DataTh>
            <DataTh>applied</DataTh>
          </DataHead>
          <DataBody>
            {lastRunOps.map((op) => (
              <DataTr key={op.id}>
                <DataTd>{op.opType}</DataTd>
                <DataTd className="font-mono text-xs text-muted-foreground">
                  {op.affectedIds.length}
                </DataTd>
                <DataTd className="font-mono text-xs text-muted-foreground">
                  {relativeTime(op.appliedAt, nowMs)}
                </DataTd>
                <DataTd className="max-w-[420px] truncate text-muted-foreground">
                  {truncate(op.reasoning, 140) || `${op.affectedIds.length} affected`}
                  <span className="ml-2 font-mono text-[10px]">{shortId(op.id)}</span>
                </DataTd>
                <DataTd>
                  <Pill tone={op.revertedAt ? 'amber' : 'lime'}>
                    {op.revertedAt ? 'reverted' : 'applied'}
                  </Pill>
                </DataTd>
              </DataTr>
            ))}
          </DataBody>
        </DataTable>
      )}
    </Page>
  );
}
