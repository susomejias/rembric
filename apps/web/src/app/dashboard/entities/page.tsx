import { ENTITY_KINDS, type EntityKind } from '@rembric/db';
import { FileText } from 'lucide-react';
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
  EmptyNote,
  Page,
  PageHead,
  Panel,
  PanelHead,
  Row,
  Rows,
  StatTile,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The entities list, in the v0 composition.
 *
 * The read is the ported view's own — `adminListEntities` paginates in SQL, so
 * the page index and the filters are the only state and both live in the URL.
 * `kind` is untrusted text, not the enum: the cast makes a bogus value match no
 * row instead of falling back to the unfiltered list.
 *
 * The retired view's Rebuild form is still NOT ported: it is a mutation whose
 * Server Action boundary is a separate slice, so the backlog stays visible as a
 * fact and no control is offered.
 *
 * The route is not in the sidebar: entities are derived data (the
 * `memory_entity_links` table), so their one affordance is the link into the
 * memories view, and the rail lists the durable aggregates only.
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
      <PageHead
        icon={FileText}
        eyebrow="Derived data"
        title="Entities"
        description="Names, paths and identifiers extracted from memory content. Entities are derived, never authored: they exist to make memory searchable by the things it mentions."
        aside={
          <div className="text-right text-[11px] text-(--ink)/45">
            <p>{total} entities</p>
            <p>{backlog} awaiting scan</p>
          </div>
        }
      />

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatTile label="Entities matched" value={total} tone="lime" hint="whole corpus count" />
        <StatTile
          label="Backfill backlog"
          value={backlog}
          tone={backlog > 0 ? 'amber' : 'dim'}
          hint="memories not scanned yet"
        />
        <StatTile
          label="Kinds"
          value={counts.length}
          hint={counts.map((c) => c.kind).join(', ') || '—'}
        />
      </section>

      <FilterForm action="/dashboard/entities" className="mt-6">
        <FilterField label="Kind" htmlFor="e-kind" className="w-44">
          <FilterSelect id="e-kind" name="kind" value={filters.kind} options={KIND_OPTIONS} />
        </FilterField>
        <FilterField label="Reference count" htmlFor="e-single" className="w-44">
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

      <Panel className="mt-6">
        <PanelHead
          eyebrow="Extracted graph"
          title="Entities by reference count"
          action={`${rows.length} of ${total}`}
        />
        {rows.length === 0 ? (
          <EmptyNote>
            {isFiltered
              ? 'No entity matches this filter set.'
              : 'No entity has been extracted yet. The backfill scans memories as they are written.'}
          </EmptyNote>
        ) : (
          <Rows>
            {rows.map((entity) => (
              <Row key={entity.id} columns="md:grid-cols-[1.6fr_1fr_1fr_auto]">
                <div className="flex items-start gap-3">
                  <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-(--accent-ink)/80" />
                  <div className="min-w-0">
                    <p className="truncate text-sm text-(--ink)/80">{entity.value}</p>
                    <p className="mt-1 font-mono text-[10px] text-(--ink)/38">
                      {shortId(entity.id)}
                    </p>
                  </div>
                </div>
                <Chip tone={entity.kind === 'path' ? 'lime' : 'dim'}>{entity.kind}</Chip>
                <span className="text-[11px] text-(--ink)/45">
                  {entity.projectId
                    ? (projectById.get(entity.projectId) ?? 'project')
                    : 'global scope'}
                </span>
                <Link
                  href={`/dashboard/memories?review=&q=${encodeURIComponent(entity.value)}`}
                  className="text-[11px] text-(--ink)/45 hover:text-(--accent-ink)"
                >
                  {entity.linkCount} linked →
                </Link>
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
            path="/dashboard/entities"
            query={roundTripQuery}
          />
        </div>
      </Panel>
    </Page>
  );
}
