import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/components/dashboard/action-form';
import { JudgmentsTable } from '@/components/dashboard/judgments-table';
import { PageHelp } from '@/components/dashboard/page-help';
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
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Judgments</h1>
          <PageHelp text="Conflicts and overlaps between memories awaiting your verdict." />
        </div>
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
    </Page>
  );
}
