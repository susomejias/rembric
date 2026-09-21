import Link from 'next/link';

import {
  judgmentsQuery,
  readJudgmentsFilters,
  relationFilters,
  type SearchParams,
} from './filters';

import {
  FilterActions,
  FilterField,
  FilterForm,
  FilterSelect,
  Pager,
} from '@/components/dashboard/filters';
import { PAGE_SIZE } from '@/components/dashboard/support';
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
  StatusPill,
  TableEmpty,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The judgment queue, in the production dashboard's composition: the numbered
 * view head, the status/kind filter bar, and the candidates as a table with the
 * status/verdict/source → target/actor/created columns.
 *
 * The filter model is the ported view's own (`RelationKindFilter` includes the
 * repository's `pending` pseudo-kind), and so is the read: `adminListWithContent`
 * joined against both endpoints, `adminCountWithFilters` for the total.
 */
export const dynamic = 'force-dynamic';

const STATUS_OPTIONS = [
  { value: '', label: 'all statuses' },
  { value: 'pending', label: 'pending' },
  { value: 'judged', label: 'judged' },
  { value: 'orphaned', label: 'orphaned' },
];

const KIND_OPTIONS = [
  { value: '', label: 'all kinds' },
  { value: 'pending', label: 'pending (unjudged)' },
  { value: 'compatible', label: 'compatible' },
  { value: 'supersedes', label: 'supersedes' },
  { value: 'not_conflict', label: 'not_conflict' },
];

export default async function JudgmentsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readJudgmentsFilters(params);
  const roundTripQuery = judgmentsQuery(params);

  const { repos } = getServices();

  const address = relationFilters(filters);
  const offset = filters.page * PAGE_SIZE;
  const rowsRaw = repos.relations.adminListWithContent(address, PAGE_SIZE + 1, offset);
  const hasMore = rowsRaw.length > PAGE_SIZE;
  const rows = rowsRaw.slice(0, PAGE_SIZE);
  const total = repos.relations.adminCountWithFilters(address);

  const pending = repos.relations.adminCountByStatus('pending');
  const judged = repos.relations.adminCountByStatus('judged');
  const orphaned = repos.relations.adminCountByStatus('orphaned');
  const adjudicable = repos.relations.adminPendingAdjudicableByProject();
  const isFiltered = filters.status !== '' || filters.kind !== '';

  return (
    <Page>
      <ViewHead
        num="04"
        title="Rembric Judgments."
        hl="Rembric"
        meta={[
          { k: 'TOTAL', v: total },
          { k: 'SHOWING', v: `${rows.length} ROWS` },
        ]}
      />

      <StatGrid className="mt-6 sm:grid-cols-3 xl:grid-cols-3">
        <StatCard
          k="PENDING"
          v={pending}
          tone={pending > 0 ? 'amber' : 'dim'}
          sub={<span>NEEDS YOUR ATTENTION</span>}
        />
        <StatCard k="JUDGED" v={judged} tone="lime" sub={<span>VERDICTS RECORDED</span>} />
        <StatCard k="ORPHANED" v={orphaned} sub={<span>ENDPOINTS NO LONGER ACTIVE</span>} />
      </StatGrid>

      <div className="mt-6 border border-amber-500/40 bg-amber-500/5 p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <p className="font-mono text-[11px] uppercase tracking-[.14em] text-amber-600 dark:text-amber-400">
              DECISION CONTEXT
            </p>
            <h2 className="mt-2 font-display text-xl font-bold tracking-[-.02em]">
              What deserves a decision
            </h2>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Judgments are the quality gate between temporary session signals and durable memory.
              Review the reason, scope, and confidence before anything is kept long term.
            </p>
          </div>
          <div className="border border-border bg-card px-3 py-2 text-right">
            <p className="font-mono text-[10px] uppercase tracking-[.14em] text-muted-foreground">
              REVIEW QUEUE
            </p>
            <p className="mt-1 font-display text-lg font-bold text-amber-600 dark:text-amber-400">
              {pending} <span className="text-xs font-normal text-muted-foreground">pairs</span>
            </p>
          </div>
        </div>
        {adjudicable.length > 0 ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {adjudicable.slice(0, 6).map((row) => (
              <span
                key={row.projectId ?? 'global'}
                className="border border-border bg-card px-3 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-muted-foreground"
              >
                {projectLabel(repos, row.projectId)} · {row.count}
              </span>
            ))}
          </div>
        ) : null}
      </div>

      <FilterForm action="/dashboard/judgments" className="mt-6">
        <FilterField label="STATUS" htmlFor="j-status">
          <FilterSelect
            id="j-status"
            name="status"
            value={filters.status}
            options={STATUS_OPTIONS}
          />
        </FilterField>
        <FilterField label="KIND" htmlFor="j-kind">
          <FilterSelect id="j-kind" name="kind" value={filters.kind} options={KIND_OPTIONS} />
        </FilterField>
        <FilterActions clearHref="/dashboard/judgments" />
      </FilterForm>

      <SectionBar name="Decision queue" meta={`${total} MATCHING`} />
      {rows.length === 0 ? (
        <TableEmpty>
          {isFiltered ? 'NO JUDGMENT MATCHES THIS FILTER' : 'NO CANDIDATE PAIR HAS BEEN RECORDED'}
        </TableEmpty>
      ) : (
        <DataTable>
          <DataHead>
            <DataTh>status</DataTh>
            <DataTh>verdict</DataTh>
            <DataTh>source → target</DataTh>
            <DataTh>actor</DataTh>
            <DataTh>created</DataTh>
            <DataTh>actions</DataTh>
          </DataHead>
          <DataBody>
            {rows.map((relation) => (
              <DataTr key={relation.id}>
                <DataTd>
                  <StatusPill status={relation.status} />
                </DataTd>
                <DataTd>
                  <Pill tone={relation.relation === null ? 'dim' : 'lime'}>
                    {relation.relation ?? 'pending'}
                  </Pill>
                </DataTd>
                <DataTd className="max-w-[420px] truncate">
                  <Link
                    href={`/dashboard/memories/${relation.sourceId}`}
                    className="transition-colors hover:text-primary"
                  >
                    {relation.sourceTitle}
                  </Link>
                  <span className="mx-2 text-muted-foreground">→</span>
                  <Link
                    href={`/dashboard/memories/${relation.targetId}`}
                    className="transition-colors hover:text-primary"
                  >
                    {relation.targetTitle}
                  </Link>
                </DataTd>
                <DataTd className="text-muted-foreground">{relation.markedByActor ?? '—'}</DataTd>
                <DataTd className="font-mono text-xs text-muted-foreground">
                  <Link href={`/dashboard/judgments/${relation.id}`} className="hover:text-primary">
                    <Time value={relation.createdAt} />
                  </Link>
                </DataTd>
                <DataTd>
                  <Link
                    href={`/dashboard/judgments/${relation.id}`}
                    className="font-mono text-[11px] uppercase tracking-[.14em] hover:text-primary"
                  >
                    View →
                  </Link>
                </DataTd>
              </DataTr>
            ))}
          </DataBody>
        </DataTable>
      )}

      <Pager
        page={filters.page}
        hasMore={hasMore}
        total={total}
        totalLabel={`${rows.length} ROWS`}
        path="/dashboard/judgments"
        query={roundTripQuery}
      />

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

function projectLabel(
  repos: ReturnType<typeof getServices>['repos'],
  projectId: string | null,
): string {
  if (projectId === null) return 'global scope';
  return repos.projects.adminFindById(projectId)?.slug ?? projectId;
}
