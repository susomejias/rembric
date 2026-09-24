import { DomainError } from '@rembric/core';
import type { Prompt } from '@rembric/db';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/components/dashboard/action-form';
import { PageHelp } from '@/components/dashboard/page-help';
import { PromptsTable } from '@/components/dashboard/prompts-table';
import { singleParam } from '@/components/dashboard/support';
import { Flash, Page, StatCard, StatGrid } from '@/components/dashboard/ui';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

const DELETE_FORM = 'prompt.delete';
const UNDELETE_FORM = 'prompt.undelete';
const BULK_DELETE_FORM = 'prompt.bulk-delete';

// One-line justification: the client table owns filtering and pagination, so the
// page loads a generous window instead of paginating server-side.
const LIST_LIMIT = 500;

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

export async function bulkDeletePrompt(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, BULK_DELETE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const ids = formData.getAll('id').filter((value): value is string => typeof value === 'string');
  try {
    for (const id of ids) {
      guard.services.prompts.softDelete(id, { adminBypass: true });
    }
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  revalidatePath('/dashboard/prompts');
  return { error: null };
}

function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return (typeof value === 'string' ? value : '').trim();
}

export default async function PromptsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const justDeleted = singleParam(params['deleted']);
  const justUndeleted = singleParam(params['undeleted']);
  const includeDeleted = singleParam(params['include_deleted']) === '1';

  const { repos } = getServices();
  const csrf = {
    remove: await dashboardCsrfToken(DELETE_FORM),
    restore: await dashboardCsrfToken(UNDELETE_FORM),
    bulkRemove: await dashboardCsrfToken(BULK_DELETE_FORM),
  };

  const projectRows = repos.projects.adminListAll();
  const projectById = new Map(projectRows.map((p) => [p.id, p]));

  const rows: Prompt[] = repos.prompts.adminList({
    includeDeleted,
    limit: LIST_LIMIT,
    offset: 0,
  });

  const activeCount = repos.prompts.adminCount({ includeDeleted: false });
  const deletedCount = repos.prompts.adminCount({ includeDeleted: true }) - activeCount;
  const total = repos.prompts.adminCount({ includeDeleted });

  return (
    <Page>
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">Prompts</h1>
            <PageHelp text="Prompts captured from agent sessions, with lifecycle states." />
          </div>
          <p className="mt-2 text-sm text-muted-foreground">
            {`${total} MATCHING · ${rows.length} rows · ${activeCount} live · ${deletedCount} deleted`}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {includeDeleted ? (
            <Link
              href="/dashboard/prompts"
              className="border border-border px-4 py-2.5 text-sm text-foreground transition-colors hover:border-primary"
            >
              Hide deleted
            </Link>
          ) : (
            <Link
              href="/dashboard/prompts?include_deleted=1"
              className="border border-border px-4 py-2.5 text-sm text-foreground transition-colors hover:border-primary"
            >
              Show deleted
            </Link>
          )}
        </div>
      </section>

      {justDeleted ? (
        <div className="mt-6">
          <Flash tone="lime" label="deleted">
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
          k="live PROMPTS"
          v={activeCount}
          tone="lime"
          sub={<span>VISIBLE TO AGENTS</span>}
        />
        <StatCard
          k="SOFT-deleted"
          v={deletedCount}
          tone={deletedCount > 0 ? 'amber' : 'dim'}
          sub={<span>HIDDEN UNLESS SHOWN</span>}
        />
        <StatCard k="IN WINDOW" v={rows.length} sub={<span>LOADED FOR THE LIST</span>} />
      </StatGrid>

      <PromptsTable
        rows={rows.map((prompt) => ({
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
        actions={{ remove: deletePrompt, restore: undeletePrompt, bulkRemove: bulkDeletePrompt }}
        csrf={csrf}
        quickFilter
        selectable
        searchable
        pageSize={10}
      />
    </Page>
  );
}
