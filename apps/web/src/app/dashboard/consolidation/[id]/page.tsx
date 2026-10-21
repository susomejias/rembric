import {
  NotUndoableError,
  PurgedRowMissingError,
  TERMINAL_OP_TYPES,
  type SkippedRow,
  type UndoResult,
} from '@rembric/core';
import type { Repositories } from '@rembric/db';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { DetailDisclosure, DetailLayout } from '@/components/dashboard/detail-layout';
import { shortId } from '@/components/dashboard/support';
import { Pill, TableEmpty, Time } from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

const RUN_UNDO_FORM = 'run.undo';
const OP_UNDO_FORM = 'op.undo';

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

function scopeLabel(repos: Repositories, scope: string): string {
  if (!scope.startsWith('project:')) return scope;
  return repos.projects.adminFindById(scope.slice('project:'.length))?.slug ?? scope;
}

function formatRunSummary(summary: string | null): string {
  if (summary === null) return '—';
  try {
    const parsed: unknown = JSON.parse(summary);
    if (
      parsed !== null &&
      typeof parsed === 'object' &&
      typeof (parsed as Record<string, unknown>)['archives'] === 'number' &&
      typeof (parsed as Record<string, unknown>)['orphaned'] === 'number'
    ) {
      const ops = parsed as { archives: number; orphaned: number };
      return `${ops.archives} archived · ${ops.orphaned} orphaned`;
    }
  } catch {
    // The stored summary is not valid run JSON: fall back to the raw text.
  }
  return summary;
}

export default async function ConsolidationRunPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const { repos } = getServices();

  const run = repos.consolidation.adminGetRun(id);
  if (!run) notFound();

  const ops = repos.consolidation.adminListOps(id);
  const hasAnyActiveOps = ops.some((op) => op.revertedAt === null);
  const scope = scopeLabel(repos, run.scope);

  return (
    <DetailLayout
      presentation="ficha"
      title={`Consolidation run ${shortId(run.id)}`}
      backHref="/dashboard/consolidation"
      backLabel="Consolidation"
      contentLabel="Run summary and operations"
      badges={
        <>
          <Pill tone="dim">{ops.length} operations</Pill>
          <span className="ficha-byline">
            in <b>{scope}</b>, started <Time value={run.startedAt} />
          </span>
        </>
      }
      metadata={
        <DetailDisclosure presentation="ficha" title="Properties">
          <dl>
            <dt>Started</dt>
            <dd>
              <Time value={run.startedAt} />
            </dd>
            <dt>Finished</dt>
            <dd>
              <Time value={run.finishedAt} />
            </dd>
            <dt>Scope</dt>
            <dd>{scope}</dd>
            <dt>Ops</dt>
            <dd>{ops.length}</dd>
          </dl>
        </DetailDisclosure>
      }
      actionsLabel="Run actions"
      primaryActions={
        hasAnyActiveOps ? (
          <ActionForm action={undoRun}>
            <CsrfField form={RUN_UNDO_FORM} />
            <input type="hidden" name="runId" value={run.id} />
            <ConfirmSubmit
              tone="danger"
              title="Revert every op in this run?"
              description="All affected memories will return to their pre-run status."
              confirmLabel="UNDO ENTIRE RUN"
            >
              <Button type="button" variant="destructive" size="sm">
                Undo entire run
              </Button>
            </ConfirmSubmit>
          </ActionForm>
        ) : null
      }
      notices={
        !hasAnyActiveOps ? (
          <p className="mb-4 font-mono text-xs text-muted-foreground">all ops reverted</p>
        ) : null
      }
    >
      <div className="space-y-8">
        <section aria-label="Summary">
          <h2 className="mb-4 text-xl font-semibold">Summary</h2>
          <pre
            tabIndex={0}
            className="rounded-[16px] border border-border bg-card p-4 font-mono text-base leading-7 whitespace-pre-wrap! wrap-anywhere! text-muted-foreground"
          >
            {formatRunSummary(run.summary)}
          </pre>
        </section>
        <section aria-label="Operations">
          <h2 className="mb-4 text-xl font-semibold">Operations</h2>
          {ops.length === 0 ? (
            <TableEmpty>NO OPERATION WAS RECORDED FOR THIS RUN</TableEmpty>
          ) : (
            <ol className="space-y-4">
              {ops.map((op) => (
                <li
                  key={op.id}
                  aria-label={`Operation ${op.id}`}
                  className="min-w-0 rounded-[16px] border border-border bg-card p-4 sm:p-5"
                >
                  <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <Pill tone={TERMINAL_OP_TYPES.has(op.opType) ? 'dim' : 'lime'}>
                      {op.opType}
                    </Pill>
                    <span className="font-mono text-xs text-muted-foreground">
                      <Time value={op.appliedAt} />
                    </span>
                  </div>
                  <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-3 text-sm [&_dt]:text-[var(--chart-2)] [&_dd]:min-w-0 [&_dd]:wrap-anywhere">
                    <dt>Affected</dt>
                    <dd className="flex flex-wrap gap-x-3 gap-y-1 font-mono text-xs">
                      {op.affectedIds.length === 0
                        ? '—'
                        : op.affectedIds.map((memoryId) => (
                            <Link
                              key={memoryId}
                              href={`/dashboard/memories/${memoryId}`}
                              className="text-primary underline-offset-4 hover:underline"
                            >
                              {shortId(memoryId)}
                            </Link>
                          ))}
                    </dd>
                    <dt>Created</dt>
                    <dd className="font-mono text-xs">
                      {op.createdId ? (
                        <Link
                          href={`/dashboard/memories/${op.createdId}`}
                          className="text-primary underline-offset-4 hover:underline"
                        >
                          {shortId(op.createdId)}
                        </Link>
                      ) : (
                        '—'
                      )}
                    </dd>
                  </dl>
                  <h3 className="mt-5 mb-2 text-sm font-medium">Reasoning</h3>
                  <p className="text-base leading-7 whitespace-pre-wrap wrap-anywhere text-muted-foreground">
                    {op.reasoning ?? '—'}
                  </p>
                  <div className="mt-4 border-t border-border pt-4">
                    {op.revertedAt !== null ? (
                      <span className="text-sm text-muted-foreground">reverted</span>
                    ) : TERMINAL_OP_TYPES.has(op.opType) ? (
                      <span className="text-sm text-muted-foreground">terminal (not undoable)</span>
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
                            Undo op
                          </Button>
                        </ConfirmSubmit>
                      </ActionForm>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
      </div>
    </DetailLayout>
  );
}
