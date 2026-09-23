import type { EntityBackfillWorker } from '@rembric/core';
import { ENTITY_KINDS, type EntityKind } from '@rembric/db';
import { redirect } from 'next/navigation';

import { entitiesQuery, readEntitiesFilters, type SearchParams } from './filters';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { EntitiesTable } from '@/components/dashboard/entities-table';
import {
  FilterActions,
  FilterField,
  FilterForm,
  FilterSelect,
  Pager,
} from '@/components/dashboard/filters';
import { PAGE_SIZE, shortId, singleParam } from '@/components/dashboard/support';
import { Flash, Page, StatCard, StatGrid, TableEmpty } from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

const REBUILD_FORM = 'entities.rebuild';

const REBUILD_MAX_BATCHES = 200;

export function runEntityRebuild(worker: EntityBackfillWorker): number {
  worker.resetIndex();
  let processed = 0;
  for (let i = 0; i < REBUILD_MAX_BATCHES; i++) {
    const result = worker.processBatch({ force: true });
    processed += result.processed;
    if (result.processed === 0) break;
  }
  return processed;
}

async function rebuildEntities(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, REBUILD_FORM);
  if (!guard.ok) return guardFailure(guard);

  const processed = runEntityRebuild(guard.services.entityBackfillWorker);
  redirect(`/dashboard/entities?rebuilt=${processed}`);
}

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
  const rebuilt = singleParam(params['rebuilt']);

  const { repos } = getServices();

  const kind = filters.kind === '' ? undefined : (filters.kind as EntityKind);
  const rowFilters = { kind, singleReferenceOnly: filters.singleReferenceOnly };

  const offset = filters.page * PAGE_SIZE;
  const rows = repos.entities.adminListEntities(rowFilters, PAGE_SIZE, offset);
  const total = repos.entities.adminCountEntities(rowFilters);
  const backlog = repos.entities.adminBacklogCount();
  const projectById = new Map(repos.projects.adminListAll().map((p) => [p.id, p.slug]));
  const counts = repos.entities.adminCountsByKind();
  const corpusTotal = counts.reduce((sum, c) => sum + c.count, 0);

  const hasMore = offset + rows.length < total;

  return (
    <Page>
      <header className="min-w-0">
        <h1 className="font-display text-2xl font-semibold tracking-[-.03em] uppercase md:text-3xl">
          Entities
        </h1>
        <p className="mt-2 font-mono text-[11px] tracking-[.14em] text-muted-foreground uppercase">
          {`${rows.length} ROWS · ${total} MATCHING · ${corpusTotal} INDEXED`}
        </p>
      </header>

      {rebuilt !== '' ? (
        <div className="mt-5">
          <Flash tone="lime" label="REBUILT">
            Entity index rebuilt ({rebuilt} memor{rebuilt === '1' ? 'y' : 'ies'} re-scanned).
          </Flash>
        </div>
      ) : null}

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
        <ActionForm action={rebuildEntities}>
          <CsrfField form={REBUILD_FORM} />
          <ConfirmSubmit
            tone="warn"
            title="Truncate and re-scan the entity index from every memory, archived included?"
            description="Useful both to backfill a pending scan and to apply a tightened extraction rule retroactively. This does not touch any memory row — only derived entity/link data."
            confirmLabel="REBUILD ENTITY INDEX"
          >
            <Button type="button" variant="outline" size="sm">
              REBUILD ENTITY INDEX{backlog > 0 ? ` (${backlog} PENDING)` : ''}
            </Button>
          </ConfirmSubmit>
        </ActionForm>
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
        <EntitiesTable
          rows={rows.map((entity) => ({
            id: entity.id,
            kind: entity.kind,
            value: entity.value,
            project: entity.projectId
              ? (projectById.get(entity.projectId) ?? shortId(entity.projectId))
              : '—',
            linkCount: entity.linkCount,
          }))}
        />
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
