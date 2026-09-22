import {
  NotUndoableError,
  PurgedRowMissingError,
  TERMINAL_OP_TYPES,
  type SkippedRow,
  type UndoResult,
} from '@rembric/core';
import type { Repositories } from '@rembric/db';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { CsrfField } from '@/components/dashboard/csrf-field';
import {
  PAGE_SIZE,
  pageParam,
  relativeTime,
  shortId,
  singleParam,
  truncate,
} from '@/components/dashboard/support';
import {
  DataBody,
  DataHead,
  DataTable,
  DataTd,
  DataTh,
  DataTr,
  Flash,
  Page,
  Pill,
  SectionBar,
  StatCard,
  StatGrid,
  TableEmpty,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

const SWEEP_FORM = 'sweep.run';
const RUN_UNDO_FORM = 'run.undo';
const OP_UNDO_FORM = 'op.undo';

async function runSweep(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, SWEEP_FORM);
  if (!guard.ok) return guardFailure(guard);

  const summary = guard.services.forcedSweep();
  const purged = summary.purgedSessionIds?.length ?? 0;
  redirect(
    purged > 0 ? `/dashboard/consolidation?purged-sessions=${purged}` : '/dashboard/consolidation',
  );
}

function undoFailure(err: unknown): ActionState {
  if (err instanceof PurgedRowMissingError) {
    return {
      error:
        `Undo blocked. ${err.missing.length} memory row(s) referenced by this op have been ` +
        `purged after the op ran; their state cannot be reconstructed. Missing ids: ` +
        `${err.missing.join(', ')}.`,
    };
  }
  if (err instanceof NotUndoableError) {
    return {
      error:
        'Not undoable. Purge operations are terminal — the rows they removed cannot be ' +
        'reconstructed.',
    };
  }
  return { error: err instanceof Error ? err.message : String(err) };
}

function partialUndo(skipped: SkippedRow[]): ActionState {
  const rows = skipped
    .map((s) => `${shortId(s.id)} (topic ${s.topicKey} now held by ${shortId(s.occupiedBy)})`)
    .join('; ');
  return {
    error:
      `${skipped.length} row(s) were not reactivated — a newer memory now owns their topic ` +
      `slot. The rest of the undo was applied. ${rows}`,
  };
}

async function undoRun(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, RUN_UNDO_FORM);
  if (!guard.ok) return guardFailure(guard);

  const runId = readField(formData, 'runId');
  let result: { reverted: string[]; skipped: SkippedRow[] };
  try {
    result = guard.services.undoRun(runId);
  } catch (err) {
    return undoFailure(err);
  }
  if (result.skipped.length > 0) return partialUndo(result.skipped);
  redirect(`/dashboard/consolidation?undone=${result.reverted.length}`);
}

async function undoOp(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, OP_UNDO_FORM);
  if (!guard.ok) return guardFailure(guard);

  const opId = readField(formData, 'opId');
  let result: UndoResult;
  try {
    result = guard.services.undoOp(opId);
  } catch (err) {
    return undoFailure(err);
  }
  if (result.skipped.length > 0) return partialUndo(result.skipped);
  redirect('/dashboard/consolidation?undone=1');
}

function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return (typeof value === 'string' ? value : '').trim();
}

type SearchParams = Record<string, string | string[] | undefined>;

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

function scopeLabel(repos: Repositories, scope: string): string {
  if (!scope.startsWith('project:')) return scope;
  return repos.projects.adminFindById(scope.slice('project:'.length))?.slug ?? scope;
}

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
  const purgedSessions = singleParam(params['purged-sessions']);
  const undone = singleParam(params['undone']);

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

      {undone !== '' ? (
        <div className="mt-6">
          <Flash tone="lime" label="UNDONE">
            Reverted {undone} consolidation op(s).
          </Flash>
        </div>
      ) : purgedSessions !== '' ? (
        <div className="mt-6">
          <Flash tone="lime" label="PURGED">
            Removed {purgedSessions} empty session row(s) as part of this sweep.
          </Flash>
        </div>
      ) : null}

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
          <div className="mt-5">
            <ActionForm action={runSweep}>
              <CsrfField form={SWEEP_FORM} />
              <ConfirmSubmit
                tone="danger"
                title="Force a consolidation sweep across all scopes now?"
                description="Decay and orphan ops are journaled and reversible, but this also purges empty sessions — that purge is irreversible."
                confirmLabel="RUN SWEEP"
              >
                <Button type="button" variant="outline" size="sm">
                  RUN SWEEP NOW
                </Button>
              </ConfirmSubmit>
            </ActionForm>
          </div>
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
          more={
            lastRun === null ? undefined : lastRunOps.some((op) => op.revertedAt === null) ? (
              <ActionForm action={undoRun}>
                <CsrfField form={RUN_UNDO_FORM} />
                <input type="hidden" name="runId" value={lastRun.id} />
                <ConfirmSubmit
                  tone="danger"
                  title="Revert every op in this run?"
                  description="All affected memories will return to their pre-run status."
                  confirmLabel="UNDO ENTIRE RUN"
                >
                  <Button type="button" variant="outline" size="sm">
                    UNDO ENTIRE RUN
                  </Button>
                </ConfirmSubmit>
              </ActionForm>
            ) : (
              <span className="font-mono text-[11px] uppercase tracking-[.12em] text-muted-foreground">
                all ops reverted
              </span>
            )
          }
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
            <DataTh>action</DataTh>
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
                <DataTd>
                  {op.revertedAt !== null ? (
                    <span className="font-mono text-[11px] uppercase tracking-[.12em] text-muted-foreground">
                      reverted
                    </span>
                  ) : TERMINAL_OP_TYPES.has(op.opType) ? (
                    <span className="font-mono text-[11px] uppercase tracking-[.12em] text-muted-foreground">
                      terminal (not undoable)
                    </span>
                  ) : (
                    <ActionForm action={undoOp}>
                      <CsrfField form={OP_UNDO_FORM} />
                      <input type="hidden" name="opId" value={op.id} />
                      <ConfirmSubmit
                        tone="warn"
                        title="Revert this consolidation op?"
                        description="Affected memories will return to their pre-op status. This is journaled and itself reversible."
                        confirmLabel="UNDO OP"
                      >
                        <Button type="button" variant="outline" size="sm">
                          UNDO OP
                        </Button>
                      </ConfirmSubmit>
                    </ActionForm>
                  )}
                </DataTd>
              </DataTr>
            ))}
          </DataBody>
        </DataTable>
      )}
    </Page>
  );
}
