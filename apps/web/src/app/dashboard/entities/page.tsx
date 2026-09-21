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
  SectionBar,
  StatCard,
  StatGrid,
  TableEmpty,
  ViewHead,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The entities list, in the production dashboard's composition: the numbered
 * view head, the corpus stats, the kind/single-reference filter bar, and the
 * entities as a table with the kind/value/project/links columns.
 *
 * The read is the ported view's own — `adminListEntities` paginates in SQL, so
 * the page index and the filters are the only state and both live in the URL.
 * `kind` is untrusted text, not the enum: the cast makes a bogus value match no
 * row instead of falling back to the unfiltered list.
 *
 * The retired view's Rebuild form is still NOT ported: it is a mutation whose
 * Server Action boundary is a separate slice, so the backlog stays visible as a
 * fact and no control is offered.
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

  const isFiltered = filters.kind !== '' || filters.singleReferenceOnly;

  const { repos } = getServices();

  const kind = filters.kind === '' ? undefined : (filters.kind as EntityKind);
  const rowFilters = { kind, singleReferenceOnly: filters.singleReferenceOnly };

  const offset = filters.page * PAGE_SIZE;
  const rows = repos.entities.adminListEntities(rowFilters, PAGE_SIZE, offset);
  const total = repos.entities.adminCountEntities(rowFilters);
  const backlog = repos.entities.adminBacklogCount();
  const projectById = new Map(repos.projects.adminListAll().map((p) => [p.id, p.slug]));
  const counts = repos.entities.adminCountsByKind();

  const hasMore = offset + rows.length < total;

  return (
    <Page>
      <ViewHead
        num="05b"
        title="Rembric Entities."
        hl="Rembric"
        meta={[
          { k: 'TOTAL ENTITIES', v: total },
          { k: 'BACKFILL BACKLOG', v: backlog },
        ]}
      />

      <StatGrid className="mt-6 sm:grid-cols-3 xl:grid-cols-3">
        <StatCard
          k="ENTITIES MATCHED"
          v={total}
          tone="lime"
          sub={<span>WHOLE CORPUS COUNT</span>}
        />
        <StatCard
          k="BACKFILL BACKLOG"
          v={backlog}
          tone={backlog > 0 ? 'amber' : 'dim'}
          sub={<span>MEMORIES NOT SCANNED YET</span>}
        />
        <StatCard
          k="KINDS"
          v={counts.length}
          sub={<span>{counts.map((c) => c.kind).join(', ') || '—'}</span>}
        />
      </StatGrid>

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

      <SectionBar name="Extracted graph" meta={`${rows.length} OF ${total}`} />
      {rows.length === 0 ? (
        <TableEmpty>
          {isFiltered ? 'NO ENTITY MATCHES THIS FILTER' : 'NO ENTITY HAS BEEN EXTRACTED YET'}
        </TableEmpty>
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
                  <Chip tone={entity.kind === 'path' ? 'lime' : 'dim'}>{entity.kind}</Chip>
                </DataTd>
                <DataTd className="max-w-[420px] truncate">
                  <span className="text-foreground">{entity.value}</span>
                  <span className="ml-2 font-mono text-[10px] text-muted-foreground">
                    {shortId(entity.id)}
                  </span>
                </DataTd>
                <DataTd className="text-muted-foreground">
                  {entity.projectId ? (projectById.get(entity.projectId) ?? 'project') : '—'}
                </DataTd>
                <DataTd className="font-mono text-xs text-muted-foreground">
                  {entity.linkCount}
                </DataTd>
                <DataTd>
                  <Link
                    href={`/dashboard/memories?review=&q=${encodeURIComponent(entity.value)}`}
                    className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground hover:text-primary"
                  >
                    Linked →
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
