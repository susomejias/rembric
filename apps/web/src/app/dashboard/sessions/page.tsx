import { DomainError } from '@rembric/core';
import { revalidatePath } from 'next/cache';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import type { ActionState } from '@/components/dashboard/action-form';
import { SessionUndoPill } from '@/components/dashboard/session-undo-pill';
import { SessionsTable } from '@/components/dashboard/sessions-table';
import { singleParam } from '@/components/dashboard/support';
import { Flash } from '@/components/dashboard/ui';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

const ABANDON_FORM = 'session.abandon';
const BULK_ABANDON_FORM = 'session.bulk-abandon';
const BULK_DELETE_FORM = 'session.bulk-delete';
const DELETE_FORM = 'session.delete';
const UNDELETE_FORM = 'session.undelete';

// One-line justification: the client table owns filtering and pagination, so the
// page loads a generous window instead of paginating server-side.
const LIST_LIMIT = 500;

const DAY_MS = 86_400_000;

// Sparkline slots = days including today, so the oldest bar is `today - 13`.
const SPARKLINE_SLOTS = 14;

async function abandonSession(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, ABANDON_FORM);
  if (!guard.ok) return guardFailure(guard);

  const id = readField(formData, 'id');
  try {
    guard.services.agentSessions.markAbandoned(id, { adminBypass: true });
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  redirect(`/dashboard/sessions?abandoned=${encodeURIComponent(id)}`);
}

async function deleteSession(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, DELETE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const id = readField(formData, 'id');
  try {
    guard.services.agentSessions.softDelete(id, { adminBypass: true });
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  redirect(`/dashboard/sessions?deleted=${encodeURIComponent(id)}`);
}

async function undeleteSession(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, UNDELETE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const id = readField(formData, 'id');
  try {
    guard.services.agentSessions.undelete(id, { adminBypass: true });
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  redirect(`/dashboard/sessions?restored=${encodeURIComponent(id)}`);
}

function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return (typeof value === 'string' ? value : '').trim();
}

async function bulkAbandonSession(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, BULK_ABANDON_FORM);
  if (!guard.ok) return guardFailure(guard);

  const ids = formData.getAll('id').filter((v): v is string => typeof v === 'string');
  try {
    for (const id of ids) {
      guard.services.agentSessions.markAbandoned(id, { adminBypass: true });
    }
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  revalidatePath('/dashboard/sessions');
  return { error: null };
}

async function bulkDeleteSession(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, BULK_DELETE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const ids = formData.getAll('id').filter((v): v is string => typeof v === 'string');
  try {
    for (const id of ids) {
      guard.services.agentSessions.softDelete(id, { adminBypass: true });
    }
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  revalidatePath('/dashboard/sessions');
  return { error: null };
}

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const justDeleted = singleParam(params['deleted']);
  const justRestored = singleParam(params['restored']);
  const justAbandoned = singleParam(params['abandoned']);
  const includeDeleted = singleParam(params['include_deleted']) === '1';

  const { repos } = getServices();
  const nowMs = Date.now();
  const csrf = {
    abandon: await dashboardCsrfToken(ABANDON_FORM),
    remove: await dashboardCsrfToken(DELETE_FORM),
    restore: await dashboardCsrfToken(UNDELETE_FORM),
    bulkAbandon: await dashboardCsrfToken(BULK_ABANDON_FORM),
    bulkRemove: await dashboardCsrfToken(BULK_DELETE_FORM),
  };

  const rows = repos.agentSessions.adminList({
    deleted: false,
    activeFirst: true,
    limit: LIST_LIMIT,
    offset: 0,
  });
  const deletedRows = includeDeleted
    ? repos.agentSessions.adminList({
        deleted: true,
        activeFirst: false,
        limit: LIST_LIMIT,
        offset: 0,
      })
    : [];

  const sessionIds = [...rows, ...deletedRows].map((r) => r.id);

  const memoryCounts = repos.memory.adminCountBySession(sessionIds);
  const promptCounts = repos.prompts.adminCountBySession(sessionIds);
  const sparklines = buildSparklines(
    repos.memory.adminMemoryWritesBySessionPerDay(
      sessionIds,
      new Date((Math.floor(nowMs / DAY_MS) - (SPARKLINE_SLOTS - 1)) * DAY_MS),
    ),
    nowMs,
  );

  const statusCounts = repos.agentSessions.adminCountByStatus();
  const active = statusCounts.find((row) => row.status === 'active')?.count ?? 0;
  const total = repos.agentSessions.adminCount({ deleted: false });

  return (
    <div className="flex flex-col gap-4">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Sessions</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            {total.toLocaleString('en-US')} sessions · {active} active now
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-3">
          {includeDeleted ? (
            <Link
              href="/dashboard/sessions"
              className="rounded-[10px] border border-border px-4 py-2.5 text-sm text-foreground transition-colors hover:bg-accent"
            >
              Hide deleted
            </Link>
          ) : (
            <Link
              href="/dashboard/sessions?include_deleted=1"
              className="rounded-[10px] border border-border px-4 py-2.5 text-sm text-foreground transition-colors hover:bg-accent"
            >
              Show deleted
            </Link>
          )}
        </div>
      </section>

      {justDeleted ? (
        <SessionUndoPill id={justDeleted} restoreAction={undeleteSession} />
      ) : justRestored ? (
        <Flash tone="lime" label="RESTORED">
          Session <code className="font-mono">{justRestored}</code> restored.
        </Flash>
      ) : justAbandoned ? (
        <Flash tone="lime" label="ABANDONED">
          Session <code className="font-mono">{justAbandoned}</code> marked as abandoned.{' '}
          <Link
            href={`/dashboard/sessions/${justAbandoned}`}
            className="underline-offset-2 hover:underline"
          >
            View
          </Link>
          .
        </Flash>
      ) : null}

      <SessionsTable
        rows={rows.map((session) => ({
          id: session.id,
          title: sessionTitle(session),
          description: session.description ?? null,
          agent: session.agent,
          project: session.projectSlug ?? '—',
          token: session.tokenName ?? '—',
          startedAt: session.startedAt,
          endedAt: session.endedAt,
          durationMs: (session.endedAt ?? new Date(nowMs)).getTime() - session.startedAt.getTime(),
          status: session.status,
          memories: memoryCounts[session.id] ?? 0,
          prompts: promptCounts[session.id] ?? 0,
          deleted: false,
        }))}
        memoryCounts={memoryCounts}
        promptCounts={promptCounts}
        sparklines={sparklines}
        actions={{ abandon: abandonSession, remove: deleteSession, restore: undeleteSession }}
        csrf={csrf}
        bulkAbandon={bulkAbandonSession}
        bulkRemove={bulkDeleteSession}
        quickFilter
        selectable
        searchable
        pageSize={10}
      />

      {includeDeleted && deletedRows.length > 0 ? (
        <>
          <h2 className="mt-4 font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
            Deleted
          </h2>
          <SessionsTable
            rows={deletedRows.map((session) => ({
              id: session.id,
              title: sessionTitle(session),
              description: session.description ?? null,
              agent: session.agent,
              project: session.projectSlug ?? '—',
              token: session.tokenName ?? '—',
              startedAt: session.startedAt,
              endedAt: session.endedAt,
              durationMs:
                (session.endedAt ?? new Date(nowMs)).getTime() - session.startedAt.getTime(),
              status: session.status,
              memories: memoryCounts[session.id] ?? 0,
              prompts: promptCounts[session.id] ?? 0,
              deleted: true,
            }))}
            memoryCounts={memoryCounts}
            promptCounts={promptCounts}
            sparklines={sparklines}
            actions={{ abandon: abandonSession, remove: deleteSession, restore: undeleteSession }}
            csrf={csrf}
            bulkAbandon={bulkAbandonSession}
            bulkRemove={bulkDeleteSession}
            pageSize={10}
          />
        </>
      ) : null}
    </div>
  );
}

function sessionTitle(row: {
  title: string | null;
  description: string | null;
  id: string;
  projectSlug: string | null;
}): string {
  return row.title ?? row.description ?? row.projectSlug ?? row.id;
}

function buildSparklines(
  rows: readonly { readonly sessionId: string; readonly day: number; readonly n: number }[],
  nowMs: number,
): Record<string, number[]> {
  const bySession = new Map<string, Map<number, number>>();
  for (const row of rows) {
    const days = bySession.get(row.sessionId) ?? new Map<number, number>();
    days.set(row.day, row.n);
    bySession.set(row.sessionId, days);
  }
  const today = Math.floor(nowMs / DAY_MS);
  const sparklines: Record<string, number[]> = {};
  for (const [sessionId, days] of bySession) {
    sparklines[sessionId] = Array.from(
      { length: SPARKLINE_SLOTS },
      (_, index) => days.get(today - SPARKLINE_SLOTS + 1 + index) ?? 0,
    );
  }
  return sparklines;
}
