import { DomainError, sanitizeFtsQuery } from '@rembric/core';
import type { Prompt } from '@rembric/db';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  matchesFilters,
  promptsQuery,
  readPromptsFilters,
  resolveProjectFilter,
  type SearchParams,
} from './filters';

import type { ActionState } from '@/components/dashboard/action-form';
import {
  FilterActions,
  FilterField,
  FilterForm,
  FilterInput,
  FilterSelect,
  Pager,
} from '@/components/dashboard/filters';
import { PromptsTable } from '@/components/dashboard/prompts-table';
import { PAGE_SIZE, singleParam } from '@/components/dashboard/support';
import { Flash, Page, StatCard, StatGrid, TableEmpty } from '@/components/dashboard/ui';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

const DELETE_FORM = 'prompt.delete';
const UNDELETE_FORM = 'prompt.undelete';

export async function deletePrompt(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, DELETE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const id = readField(formData, 'id');
  try {
    guard.services.prompts.softDelete(id, { adminBypass: true });
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  redirect(`/dashboard/prompts?deleted=${encodeURIComponent(id)}`);
}

export async function undeletePrompt(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, UNDELETE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const id = readField(formData, 'id');
  try {
    guard.services.prompts.undelete(id, { adminBypass: true });
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  redirect(`/dashboard/prompts?undeleted=${encodeURIComponent(id)}`);
}

function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return (typeof value === 'string' ? value : '').trim();
}

export default async function PromptsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readPromptsFilters(params);
  const roundTripQuery = promptsQuery(params);
  const justDeleted = singleParam(params['deleted']);
  const justUndeleted = singleParam(params['undeleted']);

  const isFiltered =
    filters.project !== '' || filters.session !== '' || filters.agent !== '' || filters.q !== '';

  const { repos } = getServices();
  const csrf = {
    remove: await dashboardCsrfToken(DELETE_FORM),
    restore: await dashboardCsrfToken(UNDELETE_FORM),
  };

  const offset = filters.page * PAGE_SIZE;
  const projectRows = repos.projects.adminListAll();
  const projectById = new Map(projectRows.map((p) => [p.id, p]));
  const resolvedProject = resolveProjectFilter(filters.project, projectRows);

  const ftsQuery = sanitizeFtsQuery(filters.q);

  let rows: Prompt[];
  if (resolvedProject.unknown) {
    rows = [];
  } else if (ftsQuery) {
    rows = repos.prompts.adminSearchFts(ftsQuery, PAGE_SIZE + 1, offset).filter((p) =>
      matchesFilters(p, {
        includeDeleted: filters.includeDeleted,
        projectId: resolvedProject.projectId,
        agent: filters.agent,
        session: filters.session,
      }),
    );
  } else {
    rows = repos.prompts.adminList({
      includeDeleted: filters.includeDeleted,
      projectId: resolvedProject.projectId,
      agent: filters.agent || undefined,
      sessionIdPrefix: filters.session || undefined,
      limit: PAGE_SIZE + 1,
      offset,
    });
  }

  const hasMore = rows.length > PAGE_SIZE;
  const visible = rows.slice(0, PAGE_SIZE);

  const totalCount: number | undefined = resolvedProject.unknown
    ? 0
    : ftsQuery
      ? undefined
      : repos.prompts.adminCount({
          includeDeleted: filters.includeDeleted,
          projectId: resolvedProject.projectId,
          agent: filters.agent || undefined,
          sessionIdPrefix: filters.session || undefined,
        });

  const activeCount = repos.prompts.adminCount({ includeDeleted: false });
  const deletedCount = repos.prompts.adminCount({ includeDeleted: true }) - activeCount;

  const matching = totalCount === undefined ? `${visible.length}+` : `${totalCount}`;

  return (
    <Page>
      <header className="min-w-0">
        <h1 className="font-display text-2xl font-semibold tracking-[-.03em] uppercase md:text-3xl">
          Prompts
        </h1>
        <p className="mt-2 font-mono text-[11px] tracking-[.14em] text-muted-foreground uppercase">
          {`${matching} MATCHING · ${visible.length} ROWS · ${activeCount} LIVE · ${deletedCount} DELETED`}
        </p>
      </header>

      {justDeleted ? (
        <div className="mt-6">
          <Flash tone="lime" label="DELETED">
            Prompt <code className="font-mono">{justDeleted}</code> soft-deleted.{' '}
            <Link href="/dashboard/prompts?include_deleted=1" className="hover:text-primary">
              View deleted
            </Link>{' '}
            to undelete.
          </Flash>
        </div>
      ) : justUndeleted ? (
        <div className="mt-6">
          <Flash tone="lime" label="RESTORED">
            Prompt <code className="font-mono">{justUndeleted}</code> restored.
          </Flash>
        </div>
      ) : null}

      <StatGrid className="mt-6 sm:grid-cols-3 xl:grid-cols-3">
        <StatCard
          k="LIVE PROMPTS"
          v={activeCount}
          tone="lime"
          sub={<span>VISIBLE TO AGENTS</span>}
        />
        <StatCard
          k="SOFT-DELETED"
          v={deletedCount}
          tone={deletedCount > 0 ? 'amber' : 'dim'}
          sub={<span>HIDDEN UNLESS SHOWN</span>}
        />
        <StatCard k="SHOWING" v={visible.length} sub={<span>PAGE {filters.page + 1}</span>} />
      </StatGrid>

      <FilterForm action="/dashboard/prompts" className="mt-6">
        <FilterField label="SCOPE" htmlFor="p-project">
          <FilterSelect
            id="p-project"
            name="project"
            value={filters.project}
            options={[
              { value: '', label: 'all scopes' },
              ...projectRows.map((p) => ({ value: p.slug, label: p.slug })),
            ]}
          />
        </FilterField>
        <FilterField label="AGENT" htmlFor="p-agent">
          <FilterInput
            id="p-agent"
            name="agent"
            value={filters.agent}
            placeholder="e.g. claude-code"
          />
        </FilterField>
        <FilterField label="SESSION" htmlFor="p-session">
          <FilterInput id="p-session" name="session" value={filters.session} placeholder="01H…" />
        </FilterField>
        <FilterField label="SEARCH" htmlFor="p-q" className="min-w-56 flex-1">
          <FilterInput id="p-q" name="q" value={filters.q} placeholder="FTS5 keyword" />
        </FilterField>
        <FilterField label="DELETED" htmlFor="p-deleted">
          <FilterSelect
            id="p-deleted"
            name="include_deleted"
            value={filters.includeDeleted ? '1' : ''}
            options={[
              { value: '', label: 'hidden' },
              { value: '1', label: 'shown' },
            ]}
          />
        </FilterField>
        <FilterActions clearHref="/dashboard/prompts" />
      </FilterForm>

      {visible.length === 0 ? (
        <TableEmpty>
          {isFiltered ? 'NO PROMPT MATCHES THIS FILTER' : 'NO PROMPT HAS BEEN CAPTURED YET'}
        </TableEmpty>
      ) : (
        <PromptsTable
          rows={visible.map((prompt) => ({
            id: prompt.id,
            title: prompt.title,
            content: prompt.content,
            project: prompt.projectId ? (projectById.get(prompt.projectId)?.slug ?? '—') : '—',
            sessionId: prompt.sessionId ?? null,
            agent: prompt.agent ?? '—',
            tags: prompt.tags ?? [],
            status: prompt.deletedAt
              ? 'deleted'
              : (prompt.replaces?.length ?? 0) > 0
                ? 'refined'
                : 'active',
            createdAt: prompt.createdAt,
            deleted: prompt.deletedAt != null,
          }))}
          actions={{ remove: deletePrompt, restore: undeletePrompt }}
          csrf={csrf}
        />
      )}

      <Pager
        page={filters.page}
        hasMore={hasMore}
        total={totalCount}
        totalLabel={`${visible.length} ROWS`}
        path="/dashboard/prompts"
        query={roundTripQuery}
      />
    </Page>
  );
}
