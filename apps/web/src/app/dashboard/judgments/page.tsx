import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/components/dashboard/action-form';
import { JudgmentsTable } from '@/components/dashboard/judgments-table';
import { PAGE_SIZE } from '@/components/dashboard/support';
import { Page } from '@/components/dashboard/ui';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

const ORPHAN_FORM = 'judgment.orphan';
const BULK_ORPHAN_FORM = 'judgment.bulk-orphan';
const TABLE_PAGE_SIZE = 10;

async function orphanJudgment(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, ORPHAN_FORM);
  if (!guard.ok) return guardFailure(guard);

  if (!guard.services.relations.orphanByOperator(readField(formData, 'judgmentId'))) {
    return { error: 'Judgment not found or already closed.' };
  }
  redirect('/dashboard/judgments');
}

export async function bulkOrphanJudgments(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, BULK_ORPHAN_FORM);
  if (!guard.ok) return guardFailure(guard);

  const judgmentIds = formData
    .getAll('judgmentId')
    .filter((value): value is string => typeof value === 'string');
  for (const judgmentId of judgmentIds) {
    guard.services.relations.orphanByOperator(judgmentId);
  }
  revalidatePath('/dashboard/judgments');
  return { error: null };
}

function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return (typeof value === 'string' ? value : '').trim();
}

export default async function JudgmentsPage() {
  const { repos } = getServices();
  const csrf = {
    orphan: await dashboardCsrfToken(ORPHAN_FORM),
    bulkOrphan: await dashboardCsrfToken(BULK_ORPHAN_FORM),
  };

  const rows = [
    ...repos.relations.adminListWithContent({ status: 'pending' }, PAGE_SIZE, 0),
    ...repos.relations.adminRecentJudged(PAGE_SIZE),
  ].slice(0, PAGE_SIZE);

  const pending = repos.relations.adminCountByStatus('pending');
  const judged = repos.relations.adminCountByStatus('judged');
  const orphaned = repos.relations.adminCountByStatus('orphaned');

  return (
    <Page>
      <header className="min-w-0">
        <h1 className="text-3xl font-semibold tracking-tight text-foreground">Judgments</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          {`${rows.length} rows · ${pending} pending · ${judged} judged · ${orphaned} orphaned`}
        </p>
      </header>

      <div className="mt-6">
        <JudgmentsTable
          rows={rows.map((relation) => ({
            id: relation.id,
            judgmentId: relation.judgmentId,
            sourceId: relation.sourceId,
            targetId: relation.targetId,
            sourceTitle: relation.sourceTitle,
            targetTitle: relation.targetTitle,
            relation: relation.relation,
            status: relation.status,
            actor: relation.markedByActor,
            kind: relation.markedByKind,
            createdAt: relation.createdAt,
            judgedAt: relation.judgedAt,
          }))}
          actions={{ orphan: orphanJudgment, bulkOrphan: bulkOrphanJudgments }}
          csrf={csrf}
          quickFilter
          selectable
          searchable
          pageSize={TABLE_PAGE_SIZE}
        />
      </div>

      <aside className="mt-8 border border-border bg-card p-5 md:p-6">
        <p className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
          HOW DECISIONS WORK
        </p>
        <h2 className="mt-2 font-display text-xl font-bold tracking-[-.02em]">
          Only durable context wins
        </h2>
        <p className="mt-4 text-xs leading-5 text-muted-foreground">
          Nothing is silently promoted. A verdict keeps its source, target, confidence, reason, and
          evidence.
        </p>
        <div className="mt-6 border-t border-border pt-4 text-xs text-muted-foreground">
          <div className="flex items-center justify-between">
            <span>Closure</span>
            <span className="text-primary">memory.judge</span>
          </div>
          <div className="mt-3 flex items-center justify-between">
            <span>Re-surfacing</span>
            <span>memory.context.pendingJudgments</span>
          </div>
        </div>
        <p className="mt-6 border-t border-border pt-4 text-[11px] text-muted-foreground">
          Aging pendings are orphaned by the deterministic sweep, not by a cron job.
        </p>
        <Link
          href="/dashboard/consolidation"
          className="mt-4 inline-block text-[11px] text-primary hover:underline"
        >
          Inspect the journal →
        </Link>
      </aside>
    </Page>
  );
}
