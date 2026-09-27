import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/components/dashboard/action-form';
import { JudgmentsTable } from '@/components/dashboard/judgments-table';
import { PageHelp } from '@/components/dashboard/page-help';
import { ServerPager } from '@/components/dashboard/pager';
import { PAGE_SIZE, singleParam } from '@/components/dashboard/support';
import { Page } from '@/components/dashboard/ui';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

const ORPHAN_FORM = 'judgment.orphan';
const BULK_ORPHAN_FORM = 'judgment.bulk-orphan';
const TABLE_PAGE_SIZE = 10;

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

function statusHref(params: SearchParams, value: StatusTab): string {
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (key === 'page' || key === 'status' || raw === undefined) continue;
    for (const item of Array.isArray(raw) ? raw : [raw]) search.append(key, item);
  }
  if (value !== 'all') search.set('status', value);
  const query = search.toString();
  return query ? `/dashboard/judgments?${query}` : '/dashboard/judgments';
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

  const { repos } = getServices();
  const csrf = {
    orphan: await dashboardCsrfToken(ORPHAN_FORM),
    bulkOrphan: await dashboardCsrfToken(BULK_ORPHAN_FORM),
  };

  const filters = status === 'all' ? {} : { status };
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
        <p className="mt-2 text-sm text-muted-foreground">
          {`${total} matching · ${pending} pending · ${judged} judged · ${orphaned} orphaned`}
        </p>
      </header>

      <nav aria-label="Judgment status" className="mt-4 flex flex-wrap items-center gap-2">
        {STATUS_TABS.map((tab) => {
          const active = tab.value === status;
          return (
            <Link
              key={tab.value}
              href={statusHref(params, tab.value)}
              prefetch
              aria-current={active ? 'page' : undefined}
              className={cn(
                'inline-flex items-center gap-1.5 whitespace-nowrap rounded-full border px-2.5 py-1 font-mono text-[10px] uppercase tracking-[.12em] transition-colors',
                active
                  ? 'border-primary/40 bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:text-foreground',
              )}
            >
              {tab.label}
              <span className="tabular-nums">{counts[tab.value]}</span>
            </Link>
          );
        })}
      </nav>

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
          searchable
          pageSize={TABLE_PAGE_SIZE}
        />
        <ServerPager page={page} total={total} pageSize={PAGE_SIZE} params={params} />
      </div>
    </Page>
  );
}
