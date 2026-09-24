import {
  deriveReviewState,
  DomainError,
  REFUTED_PRIORITY_MS,
  REVIEW_TTL_MS,
  sanitizeFtsQuery,
  type ReviewState,
} from '@rembric/core';
import { projectScope, type Memory, type MemoryStatus, type MemoryType } from '@rembric/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { readMemoriesFilters, resolveProjectFilter, type SearchParams } from './filters';

import type { ActionState } from '@/components/dashboard/action-form';
import { MemoriesTable } from '@/components/dashboard/memories-table';
import { PageHelp } from '@/components/dashboard/page-help';
import { shortId, singleParam } from '@/components/dashboard/support';
import { Flash, Page } from '@/components/dashboard/ui';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

const ARCHIVE_FORM = 'memory.archive';
const BULK_ARCHIVE_FORM = 'memory.bulk-archive';
const CONFIRM_FORM = 'memory.confirm';

// One-line justification: the client table owns filtering and pagination, so the
// page loads a single bounded window instead of paginating server-side.
const LIST_LIMIT = 500;

const TTL_BY_TYPE = Object.entries(REVIEW_TTL_MS).filter(
  (entry): entry is [MemoryType, number] => typeof entry[1] === 'number',
);

const NO_PROJECT_MESSAGE =
  'This memory predates the default project and has no project to act in. An older image wrote it; it cannot be archived or confirmed from the dashboard.';

async function archiveMemory(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, ARCHIVE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const id = readField(formData, 'id');
  const row = guard.services.memory.unsafeGetById(id);
  if (!row) redirect('/dashboard/memories');
  if (!row.projectId) return { error: NO_PROJECT_MESSAGE };

  try {
    guard.services.memory.archive(id, projectScope(row.projectId));
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  redirect(`/dashboard/memories?archived=${encodeURIComponent(id)}`);
}

async function confirmMemory(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, CONFIRM_FORM);
  if (!guard.ok) return guardFailure(guard);

  const id = readField(formData, 'id');
  const row = guard.services.memory.unsafeGetById(id);
  if (!row) redirect('/dashboard/memories');
  if (!row.projectId) return { error: NO_PROJECT_MESSAGE };

  try {
    guard.services.memory.confirm(id, projectScope(row.projectId), {
      source: { agent: 'dashboard-operator' },
    });
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  redirect(`/dashboard/memories?confirmed=${encodeURIComponent(id)}`);
}

function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return (typeof value === 'string' ? value : '').trim();
}

async function bulkArchiveMemory(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, BULK_ARCHIVE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const ids = formData.getAll('id').filter((v): v is string => typeof v === 'string');
  try {
    for (const id of ids) {
      const row = guard.services.memory.unsafeGetById(id);
      if (!row?.projectId || row.status !== 'active') continue;
      guard.services.memory.archive(id, projectScope(row.projectId));
    }
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  revalidatePath('/dashboard/memories');
  return { error: null };
}

export default async function MemoriesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readMemoriesFilters(params);
  const justArchived = singleParam(params['archived']);
  const justConfirmed = singleParam(params['confirmed']);

  const { repos } = getServices();
  const nowMs = Date.now();

  const csrf = {
    archive: await dashboardCsrfToken(ARCHIVE_FORM),
    confirm: await dashboardCsrfToken(CONFIRM_FORM),
    bulkArchive: await dashboardCsrfToken(BULK_ARCHIVE_FORM),
  };

  const wantsNeedsReview = filters.review === 'needs_review';
  const status = filters.status as MemoryStatus;
  const type = filters.type === '' ? undefined : (filters.type as MemoryType);
  const ftsQuery = sanitizeFtsQuery(filters.q);

  const projectRows = repos.projects.adminListAll();
  const projectSlugById = new Map(projectRows.map((p) => [p.id, p.slug]));
  const resolvedProject = resolveProjectFilter(filters.project, projectRows);

  let rows: Memory[];
  if (resolvedProject.unknown) {
    rows = [];
  } else if (ftsQuery) {
    rows = repos.memory.adminSearchFts(ftsQuery, {
      status,
      type,
      projectId: resolvedProject.projectId,
      limit: LIST_LIMIT,
      offset: 0,
    });
  } else if (wantsNeedsReview) {
    rows = repos.memory.adminFindNeedsReview({
      projectId: resolvedProject.projectId,
      nowMs,
      limit: LIST_LIMIT,
      offset: 0,
      ttlByType: TTL_BY_TYPE,
      refutedPriorityMs: REFUTED_PRIORITY_MS,
    });
  } else {
    rows = repos.memory.adminList({
      status,
      type,
      projectId: resolvedProject.projectId,
      limit: LIST_LIMIT,
      offset: 0,
    });
  }

  const reviewById = new Map<string, ReviewState | null>();
  const reviewTimestamps = repos.memory.reviewTimestampsByIds(rows.map((m) => m.id));
  const reviewAt = new Date(nowMs);
  for (const m of rows) {
    reviewById.set(
      m.id,
      deriveReviewState(
        {
          type: m.type,
          createdAt: m.createdAt,
          status: m.status,
          lastConfirmedAt: reviewTimestamps.get(m.id)?.affirmedAt ?? null,
          lastRefutedAt: reviewTimestamps.get(m.id)?.refutedAt ?? null,
        },
        reviewAt,
      ).reviewState,
    );
  }
  if (wantsNeedsReview && ftsQuery) {
    rows = rows.filter((m) => reviewById.get(m.id) === 'needs_review');
  }

  const confirmCounts = repos.memory.confirmationCountsByIds(rows.map((m) => m.id));

  const statusCounts = repos.memory.countRowsByStatus();
  const totalMemories = statusCounts.reduce((acc, row) => acc + row.count, 0);
  const activeMemories = statusCounts.find((row) => row.status === 'active')?.count ?? 0;
  const totalNeedsReview = repos.memory.adminCountNeedsReview({ nowMs, ttlByType: TTL_BY_TYPE });
  const summary = `${totalMemories.toLocaleString('en-US')} total · ${activeMemories.toLocaleString(
    'en-US',
  )} active · ${totalNeedsReview.toLocaleString('en-US')} need review`;

  return (
    <Page>
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">Memories</h1>
            <PageHelp text="What your agents chose to remember — searchable, reviewable, archived by decay." />
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{summary}</p>
        </div>
      </section>

      {justArchived ? (
        <Flash tone="lime" label="ARCHIVED">
          Memory <code className="font-mono">{shortId(justArchived)}</code> archived.
        </Flash>
      ) : justConfirmed ? (
        <Flash tone="lime" label="CONFIRMED">
          Memory <code className="font-mono">{shortId(justConfirmed)}</code> re-affirmed.
        </Flash>
      ) : null}

      <div className="mt-6">
        <MemoriesTable
          rows={rows.map((memory) => ({
            id: memory.id,
            title: memory.title,
            content: memory.content,
            type: memory.type,
            project: memory.projectId
              ? (projectSlugById.get(memory.projectId) ?? shortId(memory.projectId))
              : '—',
            tags: memory.tags,
            status: memory.status,
            createdAt: memory.createdAt,
            lastSeenAt: memory.lastSeenAt,
            needsReview: (reviewById.get(memory.id) ?? null) === 'needs_review',
            confirms: confirmCounts.get(memory.id) ?? 0,
          }))}
          actions={{ archive: archiveMemory, confirm: confirmMemory }}
          csrf={csrf}
          bulkArchive={bulkArchiveMemory}
          quickFilter
          selectable
          searchable
          pageSize={10}
        />
      </div>
    </Page>
  );
}
