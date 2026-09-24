import type { EntityBackfillWorker } from '@rembric/core';
import type { EntityKind } from '@rembric/db';
import { redirect } from 'next/navigation';

import { readEntitiesFilters, type SearchParams } from './filters';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { EntitiesTable } from '@/components/dashboard/entities-table';
import { shortId, singleParam } from '@/components/dashboard/support';
import { Flash, Page } from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

const REBUILD_FORM = 'entities.rebuild';

const REBUILD_MAX_BATCHES = 200;

// One-line justification: the client table owns filtering and pagination, so the
// page loads a generous window instead of paginating server-side.
const LIST_LIMIT = 500;

const TABLE_PAGE_SIZE = 10;

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

export default async function EntitiesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readEntitiesFilters(params);
  const rebuilt = singleParam(params['rebuilt']);

  const { repos } = getServices();

  const kind = filters.kind === '' ? undefined : (filters.kind as EntityKind);
  const rowFilters = { kind };

  const rows = repos.entities.adminListEntities(rowFilters, LIST_LIMIT, 0);
  const total = repos.entities.adminCountEntities(rowFilters);
  const backlog = repos.entities.adminBacklogCount();
  const projectById = new Map(repos.projects.adminListAll().map((p) => [p.id, p.slug]));
  const counts = repos.entities.adminCountsByKind();
  const corpusTotal = counts.reduce((sum, c) => sum + c.count, 0);

  return (
    <Page>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Entities</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {`${rows.length} in view · ${total} matching · ${corpusTotal} indexed`}
          </p>
        </div>
        <ActionForm action={rebuildEntities} className="shrink-0">
          <CsrfField form={REBUILD_FORM} />
          <ConfirmSubmit
            tone="warn"
            title="Truncate and re-scan the entity index from every memory, archived included?"
            description="Useful both to backfill a pending scan and to apply a tightened extraction rule retroactively. This does not touch any memory row — only derived entity/link data."
            confirmLabel="Rebuild entity index"
          >
            <Button
              type="button"
              size="sm"
              className="rounded-[10px] border-border text-sm text-foreground"
            >
              Rebuild entity index{backlog > 0 ? ` (${backlog} pending)` : ''}
            </Button>
          </ConfirmSubmit>
        </ActionForm>
      </header>

      {rebuilt !== '' ? (
        <div className="mt-2">
          <Flash tone="lime" label="REBUILT">
            Entity index rebuilt ({rebuilt} memor{rebuilt === '1' ? 'y' : 'ies'} re-scanned).
          </Flash>
        </div>
      ) : null}

      <div className="mt-4">
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
          quickFilter
          searchable
          pageSize={TABLE_PAGE_SIZE}
        />
      </div>
    </Page>
  );
}
