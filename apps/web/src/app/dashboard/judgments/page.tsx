import { Gavel } from 'lucide-react';
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
import { PAGE_SIZE, relativeTime, shortId } from '@/components/dashboard/support';
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
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The judgment queue, in the v0 composition: the verdict counters, the decision
 * context panel, the review-with-context table and the policy aside.
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
  const nowMs = Date.now();

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
      <PageHead
        icon={Gavel}
        eyebrow="Memory decisions"
        title="Judgments"
        description="Review the signals that shape what becomes durable memory."
      />

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatTile label="Pending" value={pending} tone="amber" hint="needs your attention" />
        <StatTile label="Judged" value={judged} tone="lime" hint="verdicts recorded" />
        <StatTile label="Orphaned" value={orphaned} hint="endpoints no longer active" />
      </section>

      <section className="mt-6 rounded-xl border border-amber-500/30 bg-amber-500/5 p-5 md:p-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="max-w-xl">
            <p className="text-[10px] tracking-[.14em] text-amber-600 dark:text-amber-400 uppercase">
              Decision context
            </p>
            <h2 className="mt-2 text-xl font-medium tracking-[-.04em]">What deserves a decision</h2>
            <p className="mt-2 text-xs leading-5 text-muted-foreground">
              Judgments are the quality gate between temporary session signals and durable memory.
              Review the reason, scope, and confidence before anything is kept long term.
            </p>
          </div>
          <div className="rounded-lg border border-border bg-accent px-3 py-2 text-right">
            <p className="text-[10px] text-muted-foreground">Review queue</p>
            <p className="mt-1 text-lg font-medium text-amber-600 dark:text-amber-400">
              {pending} <span className="text-xs font-normal text-muted-foreground">pairs</span>
            </p>
          </div>
        </div>
        {adjudicable.length > 0 ? (
          <div className="mt-5 flex flex-wrap gap-2">
            {adjudicable.slice(0, 6).map((row) => (
              <span
                key={row.projectId ?? 'global'}
                className="rounded-full border border-border bg-accent px-3 py-1 text-[10px] text-muted-foreground"
              >
                {projectLabel(repos, row.projectId)} · {row.count}
              </span>
            ))}
          </div>
        ) : null}
      </section>

      <FilterForm action="/dashboard/judgments" className="mt-6">
        <FilterField label="Status" htmlFor="j-status" className="w-44">
          <FilterSelect
            id="j-status"
            name="status"
            value={filters.status}
            options={STATUS_OPTIONS}
          />
        </FilterField>
        <FilterField label="Kind" htmlFor="j-kind" className="w-48">
          <FilterSelect id="j-kind" name="kind" value={filters.kind} options={KIND_OPTIONS} />
        </FilterField>
        <FilterActions clearHref="/dashboard/judgments" />
      </FilterForm>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.35fr_.65fr]">
        <Panel>
          <PanelHead
            eyebrow="Decision queue"
            title="Review with context"
            action={`${total} matching`}
          />
          {rows.length === 0 ? (
            <EmptyNote>
              {isFiltered
                ? 'No judgment matches this filter set.'
                : 'No candidate pair has been recorded. Conflicts appear the moment a save overlaps an existing memory.'}
            </EmptyNote>
          ) : (
            <Rows>
              {rows.map((relation, index) => (
                <Row key={relation.id} columns="md:grid-cols-[auto_1.3fr_1fr_auto]">
                  <span
                    className={`grid size-7 place-items-center rounded-lg text-[10px] ${
                      relation.status === 'pending' || relation.status === 'orphaned'
                        ? 'bg-amber-500/10 text-amber-600 dark:text-amber-400'
                        : 'bg-primary/10 text-primary'
                    }`}
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <div className="min-w-0">
                    <Link
                      href={`/dashboard/memories/${relation.sourceId}`}
                      className="text-sm text-foreground hover:text-primary"
                    >
                      {relation.sourceTitle}
                    </Link>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {relation.relation ?? 'pending'} →{' '}
                      <Link
                        href={`/dashboard/memories/${relation.targetId}`}
                        className="hover:text-primary"
                      >
                        {relation.targetTitle}
                      </Link>
                    </p>
                  </div>
                  <div className="text-[11px] text-muted-foreground">
                    <p>confidence {relation.confidence ?? '—'}</p>
                    <p className="mt-1 text-muted-foreground">
                      {relation.judgmentId !== ''
                        ? `judgment ${shortId(relation.judgmentId)}`
                        : 'no judgment id'}
                    </p>
                  </div>
                  <div className="flex flex-col items-start gap-1">
                    <Pill tone={relation.status === 'judged' ? 'lime' : 'amber'}>
                      {relation.status}
                    </Pill>
                    <span className="text-[10px] text-muted-foreground">
                      {relativeTime(relation.judgedAt ?? relation.createdAt, nowMs)}
                    </span>
                  </div>
                </Row>
              ))}
            </Rows>
          )}
          <div className="px-5 pb-5 md:px-6">
            <Pager
              page={filters.page}
              hasMore={hasMore}
              total={total}
              totalLabel={`${rows.length} rows`}
              path="/dashboard/judgments"
              query={roundTripQuery}
            />
          </div>
        </Panel>

        <aside className="rounded-2xl border border-border bg-card p-5 md:p-6">
          <p className="text-[10px] tracking-[.14em] text-muted-foreground uppercase">
            How decisions work
          </p>
          <h2 className="mt-2 text-xl font-medium tracking-[-.04em]">Only durable context wins</h2>
          <p className="mt-4 text-xs leading-5 text-muted-foreground">
            Rembric keeps proposed memories separate until they are accepted. Nothing is silently
            promoted. A verdict keeps its source, target, confidence, reason, and evidence.
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
            className="mt-4 inline-block text-[11px] text-primary hover:text-primary"
          >
            Inspect the journal →
          </Link>
        </aside>
      </div>
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
