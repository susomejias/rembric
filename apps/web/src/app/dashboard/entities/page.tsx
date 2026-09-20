import { ENTITY_KINDS, type EntityKind } from '@rembric/db';
import Link from 'next/link';

import { entitiesQuery, readEntitiesFilters, type SearchParams } from './filters';

import { TableEmptyState, TableNoResults } from '@/components/dashboard/empty-states';
import { FilterBar, FilterField, FilterSelect } from '@/components/dashboard/filter-bar';
import { PAGE_SIZE, queryWithPage, shortId } from '@/components/dashboard/format';
import { Pager } from '@/components/dashboard/pager';
import { ViewHead } from '@/components/dashboard/view-head';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { getServices } from '@/lib/services';

/**
 * The entities list — a server component querying the entities repository
 * directly, the same read the retired Hono view made
 * (`apps/server/src/dashboard/entities.ts`): `adminListEntities` over-fetches by
 * nothing and paginates in SQL, so the page index and the filters are the only
 * state and both live in the URL.
 *
 * The retired view's Rebuild form is NOT ported: it is a mutation, and the
 * change's mutation-protection probe (design D4, task 2.5) has not run, so this
 * view shows state and no dead control — the boundary
 * `../memories/[id]/page.tsx` documents. The backlog count it guarded stays
 * visible in the header, so a pending rebuild is still readable as a fact.
 *
 * Entity rows are derived data (`memory_entity_links`), so the row-links
 * navigation into the already-ported memories view is the one affordance here.
 */
export const dynamic = 'force-dynamic';

export default async function EntitiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readEntitiesFilters(params);
  // The params the pager and the filter form round-trip.
  const roundTripQuery = entitiesQuery(params);
  const filterKey = queryWithPage(roundTripQuery, 0);

  const isFiltered = filters.kind !== '' || filters.singleReferenceOnly;

  const { repos } = getServices();

  // `kind` is untrusted text, not the enum: the cast is what makes a bogus value
  // match no row (the SQL comparison simply fails) instead of falling back to
  // the unfiltered list.
  const kind = filters.kind === '' ? undefined : (filters.kind as EntityKind);
  const rowFilters = { kind, singleReferenceOnly: filters.singleReferenceOnly };

  const offset = filters.page * PAGE_SIZE;
  const rows = repos.entities.adminListEntities(rowFilters, PAGE_SIZE, offset);
  const total = repos.entities.adminCountEntities(rowFilters);
  const backlog = repos.entities.adminBacklogCount();
  const projectById = new Map(repos.projects.adminListAll().map((p) => [p.id, p]));

  const hasMore = offset + rows.length < total;

  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        num="05b"
        title="Rembric Entities."
        metaId="entities-meta"
        meta={[
          { k: 'TOTAL ENTITIES', v: String(total) },
          { k: 'BACKFILL BACKLOG', v: String(backlog) },
        ]}
      />

      {/* Remounted whenever the filter set changes, so the uncontrolled controls
          re-seed from the URL on a soft navigation (e.g. CLEAR). */}
      <FilterBar key={filterKey} action="/dashboard/entities">
        <FilterField label="KIND" htmlFor="f-kind" className="w-44">
          <FilterSelect
            id="f-kind"
            name="kind"
            value={filters.kind}
            options={[
              { value: '', label: 'all kinds' },
              ...ENTITY_KINDS.map((k) => ({ value: k, label: k })),
            ]}
          />
        </FilterField>
        <FilterField label="SINGLE-REFERENCE ONLY" htmlFor="f-single-ref" className="w-56">
          <input
            type="checkbox"
            id="f-single-ref"
            name="single_ref"
            value="1"
            defaultChecked={filters.singleReferenceOnly}
            className="size-4 accent-primary"
          />
        </FilterField>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm">
            FILTER
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/dashboard/entities">CLEAR</Link>
          </Button>
        </div>
      </FilterBar>

      <div id="entities-list" className="flex flex-col gap-3">
        {rows.length === 0 ? (
          isFiltered ? (
            <TableNoResults what="entities" clearHref="/dashboard/entities" />
          ) : (
            <TableEmptyState
              title="No entities yet"
              description={
                <>
                  Entities are extracted from saved memories by the deterministic scan — it runs on
                  session start and from the maintenance page's backfill, so this list fills as
                  memories arrive.
                </>
              }
            />
          )
        ) : (
          <Table className="font-sans">
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-32">kind</TableHead>
                <TableHead>value</TableHead>
                <TableHead className="w-40">project</TableHead>
                <TableHead className="w-24">links</TableHead>
                <TableHead className="w-44">actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => (
                <TableRow key={row.id}>
                  <TableCell>
                    <Badge variant="secondary" className="font-mono text-muted-foreground">
                      {row.kind}
                    </Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{row.value}</TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {row.projectId
                      ? (projectById.get(row.projectId)?.slug ?? shortId(row.projectId))
                      : '—'}
                  </TableCell>
                  <TableCell className="tabular-nums">{row.linkCount}</TableCell>
                  <TableCell>
                    <Link
                      href={`/dashboard/memories?q=${encodeURIComponent(row.value)}`}
                      className="font-mono text-xs tracking-[0.12em] uppercase underline-offset-4 hover:underline"
                    >
                      view memories →
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <Pager
          page={filters.page}
          hasMore={hasMore}
          total={total}
          totalLabel={`${rows.length} ROWS`}
          path="/dashboard/entities"
          query={roundTripQuery}
        />
      </div>
    </div>
  );
}
