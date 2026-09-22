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
import { shortId } from '@/components/dashboard/support';
import {
  BackLink,
  DataBody,
  DataHead,
  DataTable,
  DataTd,
  DataTh,
  DataTr,
  Kv,
  KvGrid,
  Page,
  Pill,
  SectionBar,
  TableEmpty,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
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
  } catch {}
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

  return (
    <Page>
      <ViewHead title={`Rembric Run ${shortId(run.id)}.`} hl="Rembric" />

      <div className="mt-4 mb-5">
        <BackLink href="/dashboard/consolidation" label="BACK TO CONSOLIDATION" />
      </div>

      <KvGrid>
        <Kv k="Started" v={<Time value={run.startedAt} />} mono />
        <Kv k="Finished" v={<Time value={run.finishedAt} />} mono />
        <Kv k="Scope" v={scopeLabel(repos, run.scope)} />
        <Kv k="Ops" v={ops.length} />
      </KvGrid>

      <SectionBar name="Summary" />
      <pre className="mb-6 overflow-x-auto border border-border bg-muted p-3 font-mono text-xs leading-5">
        {formatRunSummary(run.summary)}
      </pre>

      <SectionBar name="Ops" />
      {ops.length === 0 ? (
        <TableEmpty>NO OPERATION WAS RECORDED FOR THIS RUN</TableEmpty>
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
            {ops.map((op) => (
              <DataTr key={op.id}>
                <DataTd>
                  <Pill tone={TERMINAL_OP_TYPES.has(op.opType) ? 'dim' : 'lime'}>{op.opType}</Pill>
                </DataTd>
                <DataTd className="font-mono text-xs">
                  {op.affectedIds.length === 0
                    ? '—'
                    : op.affectedIds.map((memoryId) => (
                        <Link
                          key={memoryId}
                          href={`/dashboard/memories/${memoryId}`}
                          className="mr-2 text-primary hover:underline"
                        >
                          {shortId(memoryId)}
                        </Link>
                      ))}
                </DataTd>
                <DataTd className="font-mono text-xs">
                  {op.createdId ? (
                    <Link
                      href={`/dashboard/memories/${op.createdId}`}
                      className="text-primary hover:underline"
                    >
                      {shortId(op.createdId)}
                    </Link>
                  ) : (
                    '—'
                  )}
                </DataTd>
                <DataTd className="max-w-[420px] truncate text-muted-foreground">
                  {op.reasoning ?? '—'}
                </DataTd>
                <DataTd className="font-mono text-xs text-muted-foreground">
                  <Time value={op.appliedAt} />
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

      <SectionBar name="Run actions" />
      {hasAnyActiveOps ? (
        <ActionForm action={undoRun}>
          <CsrfField form={RUN_UNDO_FORM} />
          <input type="hidden" name="runId" value={run.id} />
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
        <p className="font-mono text-[11px] uppercase tracking-[.12em] text-muted-foreground">
          all ops reverted
        </p>
      )}
    </Page>
  );
}
