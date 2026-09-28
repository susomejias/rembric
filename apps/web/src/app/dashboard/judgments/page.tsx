import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/components/dashboard/action-form';
import { JudgmentsTable } from '@/components/dashboard/judgments-table';
import { PageHelp } from '@/components/dashboard/page-help';
import { ServerPager } from '@/components/dashboard/pager';
import { PAGE_SIZE, singleParam } from '@/components/dashboard/support';
import { TableSearch } from '@/components/dashboard/table-search';
import { Page } from '@/components/dashboard/ui';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

const ORPHAN_FORM = 'judgment.orphan';
const BULK_ORPHAN_FORM = 'judgment.bulk-orphan';

type SearchParams = Record<string, string | string[] | undefined>;

const STATUS_TABS = [
  { value: 'all', label: 'All' },
  { value: 'pending', label: 'Pending' },
  { value: 'judged', label: 'Judged' },
  { value: 'orphaned', label: 'Orphaned' },
] as const;

type StatusTab = (typeof STATUS_TABS)[number]['value'];

function resolveStatusTab(raw: string): StatusTab {
  const tab = STATUS_TABS.find((candidate) => candidate.value === raw);
  return tab ? tab.value : 'all';
}

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

export default async function JudgmentsPage({
  searchParams,
}: {
  searchParams?: Promise<SearchParams>;
} = {}) {
  const params = (await searchParams) ?? {};
  const status = resolveStatusTab(singleParam(params['status']));
  const q = singleParam(params['q']).trim();

  const { repos } = getServices();
  const csrf = {
    orphan: await dashboardCsrfToken(ORPHAN_FORM),
    bulkOrphan: await dashboardCsrfToken(BULK_ORPHAN_FORM),
  };

  const filters = {
    ...(status === 'all' ? {} : { status }),
    ...(q ? { q } : {}),
  };
  const total = repos.relations.adminCountWithFilters(filters);
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(Math.max(1, Number.parseInt(singleParam(params['page']), 10) || 1), pages);
  const rows = repos.relations.adminListWithContent(filters, PAGE_SIZE, (page - 1) * PAGE_SIZE);

  const pending = repos.relations.adminCountByStatus('pending');
  const judged = repos.relations.adminCountByStatus('judged');
  const orphaned = repos.relations.adminCountByStatus('orphaned');
  const counts: Record<StatusTab, number> = {
    all: pending + judged + orphaned,
    pending,
    judged,
    orphaned,
  };

  return (
    <Page>
      <header className="min-w-0">
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Judgments</h1>
          <PageHelp text="Conflicts and overlaps between memories awaiting your verdict." />
        </div>
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
          selectable
          toolbar={
            <TableSearch value={q} placeholder="Search judgments…" ariaLabel="Search judgments" />
          }
          quickFilter={{
            paramKey: 'status',
            active: status === 'all' ? null : status,
            options: [
              { value: 'pending', label: 'Pending' },
              { value: 'judged', label: 'Judged' },
              { value: 'orphaned', label: 'Orphaned' },
            ],
            counts: { pending: counts.pending, judged: counts.judged, orphaned: counts.orphaned },
            totalCount: counts.all,
            allLabel: 'All',
            label: 'Filter by status',
          }}
        />
        <ServerPager page={page} total={total} pageSize={PAGE_SIZE} params={params} />
      </div>
    </Page>
  );
}
