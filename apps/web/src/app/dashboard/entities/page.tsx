import { ENTITY_KINDS, type EntityKind } from '@rembric/db';
import Link from 'next/link';

import { entitiesQuery, readEntitiesFilters, type SearchParams } from './filters';

import {
  FilterActions,
  FilterField,
  FilterForm,
  FilterSelect,
  Pager,
} from '@/components/dashboard/filters';
import { PAGE_SIZE, shortId } from '@/components/dashboard/support';
import {
  Chip,
  DataBody,
  DataHead,
  DataTable,
  DataTd,
  DataTh,
  DataTr,
  Page,
  StatCard,
  StatGrid,
  TableEmpty,
  ViewHead,
} from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { getServices } from '@/lib/services';

/**
 * The entities list, in the production dashboard's composition: the corpus
 * stats, the kind/single-reference filter bar, and the entities as a table with
 * the kind/value/project/links columns.
 *
 * The read is the ported view's own — `adminListEntities` paginates in SQL, so
 * the page index and the filters are the only state and both live in the URL.
 * `kind` is untrusted text, not the enum: the cast makes a bogus value match no
 * row instead of falling back to the unfiltered list.
 *
 * The kind cards count the whole corpus (`adminCountsByKind`), not the filtered
 * page, so they stay stable while filtering and double as the kind filter links.
 *
 * The retired view's Rebuild is still NOT ported: it is a mutation whose Server
 * Action boundary is a separate slice. Instead of hiding it, its control renders
 * disabled with the backlog count, so the gap is visible and honest.
 */
export const dynamic = 'force-dynamic';

const KIND_OPTIONS = [
  { value: '', label: 'all kinds' },
  ...ENTITY_KINDS.map((kind) => ({ value: kind, label: kind })),
];

export default async function EntitiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readEntitiesFilters(params);
  const roundTripQuery = entitiesQuery(params);

  const { repos } = getServices();

  const kind = filters.kind === '' ? undefined : (filters.kind as EntityKind);
  const rowFilters = { kind, singleReferenceOnly: filters.singleReferenceOnly };

  const offset = filters.page * PAGE_SIZE;
  const rows = repos.entities.adminListEntities(rowFilters, PAGE_SIZE, offset);
  const total = repos.entities.adminCountEntities(rowFilters);
  const backlog = repos.entities.adminBacklogCount();
  const projectById = new Map(repos.projects.adminListAll().map((p) => [p.id, p.slug]));
  const counts = repos.entities.adminCountsByKind();
  // Whole-corpus, filter-independent — main's "ALL KINDS" card does not shrink
  // as the table filters.
  const corpusTotal = counts.reduce((sum, c) => sum + c.count, 0);

  const hasMore = offset + rows.length < total;

  return (
    <Page>
      <ViewHead title="Rembric Entities." hl="Rembric" />

      <StatGrid variant="cards" className="mt-6">
        <StatCard compact k="ALL KINDS" v={corpusTotal} tone="lime" href="/dashboard/entities" />
        {ENTITY_KINDS.map((entityKind) => (
          <StatCard
            compact
            key={entityKind}
            k={entityKind.toUpperCase()}
            v={counts.find((c) => c.kind === entityKind)?.count ?? 0}
            tone="fg"
            href={`/dashboard/entities?kind=${entityKind}`}
          />
        ))}
      </StatGrid>

      <div className="mt-6">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled
          title="Entity rebuild is not connected yet"
        >
          Rebuild entity index ({backlog} pending)
        </Button>
      </div>

      <FilterForm action="/dashboard/entities" className="mt-6">
        <FilterField label="KIND" htmlFor="e-kind">
          <FilterSelect id="e-kind" name="kind" value={filters.kind} options={KIND_OPTIONS} />
        </FilterField>
        <FilterField label="REFERENCES" htmlFor="e-single">
          <FilterSelect
            id="e-single"
            name="single_ref"
            value={filters.singleReferenceOnly ? '1' : ''}
            options={[
              { value: '', label: 'any' },
              { value: '1', label: 'single reference only' },
            ]}
          />
        </FilterField>
        <FilterActions clearHref="/dashboard/entities" />
      </FilterForm>

      {rows.length === 0 ? (
        <TableEmpty>No entities match this filter.</TableEmpty>
      ) : (
        <DataTable>
          <DataHead>
            <DataTh>kind</DataTh>
            <DataTh>value</DataTh>
            <DataTh>project</DataTh>
            <DataTh>links</DataTh>
            <DataTh>actions</DataTh>
          </DataHead>
          <DataBody>
            {rows.map((entity) => (
              <DataTr key={entity.id}>
                <DataTd>
                  <Chip>{entity.kind}</Chip>
                </DataTd>
                <DataTd className="font-mono text-xs">{entity.value}</DataTd>
                <DataTd className="text-muted-foreground">
                  {entity.projectId
                    ? (projectById.get(entity.projectId) ?? shortId(entity.projectId))
                    : '—'}
                </DataTd>
                <DataTd className="font-mono text-xs text-muted-foreground">
                  {entity.linkCount}
                </DataTd>
                <DataTd>
                  <Link
                    href={`/dashboard/memories?q=${encodeURIComponent(entity.value)}`}
                    className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground hover:text-primary"
                  >
                    View memories →
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
        path="/dashboard/entities"
        query={roundTripQuery}
      />
    </Page>
  );
}
