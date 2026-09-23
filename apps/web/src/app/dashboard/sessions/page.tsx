import { DomainError } from '@rembric/core';
import { AGENT_SESSION_STATUSES } from '@rembric/db';
import Link from 'next/link';
import { redirect } from 'next/navigation';

import {
  parseSessionStatus,
  readSessionsFilters,
  resolveProjectFilter,
  sessionsQuery,
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
import { SessionUndoPill } from '@/components/dashboard/session-undo-pill';
import { SessionsTable } from '@/components/dashboard/sessions-table';
import { PAGE_SIZE, formatBytes, singleParam } from '@/components/dashboard/support';
import {
  Flash,
  Page,
  Panel,
  SectionBar,
  StatCard,
  StatGrid,
  TableEmpty,
  ViewHead,
} from '@/components/dashboard/ui';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

const ABANDON_FORM = 'session.abandon';
const DELETE_FORM = 'session.delete';
const UNDELETE_FORM = 'session.undelete';

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

const STATUS_OPTIONS = [
  { value: '', label: 'all statuses' },
  ...AGENT_SESSION_STATUSES.map((s) => ({ value: s, label: s })),
];

const DAY_MS = 86_400_000;
const WEEKDAYS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'] as const;

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const filters = readSessionsFilters(params);
  const roundTripQuery = sessionsQuery(params);
  const justDeleted = singleParam(params['deleted']);
  const justRestored = singleParam(params['restored']);
  const justAbandoned = singleParam(params['abandoned']);

  const { repos } = getServices();
  const nowMs = Date.now();
  const csrf = {
    abandon: await dashboardCsrfToken(ABANDON_FORM),
    remove: await dashboardCsrfToken(DELETE_FORM),
    restore: await dashboardCsrfToken(UNDELETE_FORM),
  };

  const offset = filters.page * PAGE_SIZE;
  const status = parseSessionStatus(filters.status);
  const projectRows = repos.projects.adminListAll();
  const resolvedProject = resolveProjectFilter(filters.project, projectRows);

  const isFiltered = filters.project !== '' || filters.agent !== '' || filters.status !== '';

  const address = {
    deleted: false,
    projectId: resolvedProject.projectId,
    agent: filters.agent || undefined,
    status,
  };
  const visibleRowsRaw = resolvedProject.unknown
    ? []
    : repos.agentSessions.adminList({
        ...address,
        activeFirst: true,
        limit: PAGE_SIZE + 1,
        offset,
      });
  const visibleHasMore = visibleRowsRaw.length > PAGE_SIZE;
  const visibleRows = visibleRowsRaw.slice(0, PAGE_SIZE);

  const deletedRowsRaw = filters.includeDeleted
    ? repos.agentSessions.adminList({
        deleted: true,
        activeFirst: false,
        limit: PAGE_SIZE + 1,
        offset,
      })
    : [];
  const deletedHasMore = deletedRowsRaw.length > PAGE_SIZE;
  const deletedRows = deletedRowsRaw.slice(0, PAGE_SIZE);

  const memoryCounts = repos.memory.adminCountBySession(
    [...visibleRows, ...deletedRows].map((r) => r.id),
  );
  const promptCounts = repos.prompts.adminCountBySession(
    [...visibleRows, ...deletedRows].map((r) => r.id),
  );

  const total = resolvedProject.unknown ? 0 : repos.agentSessions.adminCount(address);
  const statusCounts = sessionStatusCounts(repos.agentSessions.adminCountByStatus());
  const allSessions = repos.agentSessions.adminCount({ deleted: false });

  const activity = sevenDayActivity(
    repos.memory.adminCountCreatedByDay(new Date(nowMs - 6 * DAY_MS)),
  );
  const lifetimeMemoryWrites = visibleRows.reduce(
    (acc, row) => acc + (memoryCounts[row.id] ?? 0),
    0,
  );
  const averageDurationMs = averageDuration(visibleRows, nowMs);
  const contextCaptured = visibleRows.reduce((acc, row) => acc + (row.description?.length ?? 0), 0);

  return (
    <Page>
      <ViewHead num="03" title="Rembric Sessions." hl="Rembric" meta={[{ k: 'TOTAL', v: total }]} />

      {justDeleted ? (
        <SessionUndoPill id={justDeleted} restoreAction={undeleteSession} />
      ) : justRestored ? (
        <div className="mt-6">
          <Flash tone="lime" label="RESTORED">
            Session <code className="font-mono">{justRestored}</code> restored.
          </Flash>
        </div>
      ) : justAbandoned ? (
        <div className="mt-6">
          <Flash tone="lime" label="ABANDONED">
            Session <code className="font-mono">{justAbandoned}</code> marked as abandoned.{' '}
            <Link href={`/dashboard/sessions/${justAbandoned}`} className="hover:text-primary">
              View
            </Link>
            .
          </Flash>
        </div>
      ) : null}

      <StatGrid className="mt-6 sm:grid-cols-3 xl:grid-cols-3">
        <StatCard
          k="ACTIVE"
          v={statusCounts.active}
          tone={statusCounts.active > 0 ? 'lime' : 'dim'}
          sub={<span>OPEN RIGHT NOW</span>}
        />
        <StatCard
          k="ABANDONED"
          v={statusCounts.abandoned}
          sub={<span>SWEPT AFTER INACTIVITY</span>}
        />
        <StatCard k="ENDED" v={statusCounts.ended} sub={<span>CLOSED BY THE CLIENT</span>} />
      </StatGrid>

      <FilterForm action="/dashboard/sessions" className="mt-6">
        <FilterField label="SCOPE" htmlFor="s-project">
          <FilterSelect
            id="s-project"
            name="project"
            value={filters.project}
            options={[
              { value: '', label: 'all scopes' },
              ...projectRows.map((p) => ({ value: p.slug, label: p.slug })),
            ]}
          />
        </FilterField>
        <FilterField label="AGENT" htmlFor="s-agent">
          <FilterInput
            id="s-agent"
            name="agent"
            value={filters.agent}
            placeholder="e.g. claude-code"
          />
        </FilterField>
        <FilterField label="STATUS" htmlFor="s-status">
          <FilterSelect
            id="s-status"
            name="status"
            value={filters.status}
            options={STATUS_OPTIONS}
          />
        </FilterField>
        {filters.includeDeleted ? <input type="hidden" name="include_deleted" value="1" /> : null}
        <FilterActions
          clearHref={`/dashboard/sessions${filters.includeDeleted ? '?include_deleted=1' : ''}`}
        />
      </FilterForm>

      <p className="mb-4 font-mono text-[11px] tracking-[.14em] text-muted-foreground uppercase">
        {filters.includeDeleted ? (
          <Link href="/dashboard/sessions" className="hover:text-primary">
            Hide deleted
          </Link>
        ) : (
          <Link href="/dashboard/sessions?include_deleted=1" className="hover:text-primary">
            Show deleted
          </Link>
        )}
      </p>

      <SectionBar name="Sessions" meta={`${visibleRows.length} ROWS`} />
      {visibleRows.length === 0 ? (
        <TableEmpty>
          {isFiltered ? 'NO SESSION MATCHES THIS FILTER' : 'NO SESSION HAS BEEN RECORDED YET'}
        </TableEmpty>
      ) : (
        <SessionsTable
          rows={visibleRows.map((session) => ({
            id: session.id,
            title: sessionTitle(session),
            description: session.description ?? null,
            agent: session.agent,
            project: session.projectSlug ?? '—',
            token: session.tokenName ?? '—',
            startedAt: session.startedAt,
            endedAt: session.endedAt,
            status: session.status,
            memories: memoryCounts[session.id] ?? 0,
            prompts: promptCounts[session.id] ?? 0,
            deleted: false,
          }))}
          memoryCounts={memoryCounts}
          promptCounts={promptCounts}
          actions={{ abandon: abandonSession, remove: deleteSession, restore: undeleteSession }}
          csrf={csrf}
        />
      )}

      <Pager
        page={filters.page}
        hasMore={visibleHasMore || (filters.includeDeleted && deletedHasMore)}
        total={total}
        totalLabel={`${visibleRows.length} ROWS`}
        path="/dashboard/sessions"
        query={roundTripQuery}
      />

      {filters.includeDeleted && deletedRows.length > 0 ? (
        <>
          <div className="mt-8">
            <SectionBar name="Deleted" meta={`${deletedRows.length} ROWS`} />
          </div>
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
              status: session.status,
              memories: memoryCounts[session.id] ?? 0,
              prompts: promptCounts[session.id] ?? 0,
              deleted: true,
            }))}
            memoryCounts={memoryCounts}
            promptCounts={promptCounts}
            actions={{ abandon: abandonSession, remove: deleteSession, restore: undeleteSession }}
            csrf={csrf}
          />
        </>
      ) : null}

      <div className="mt-8 grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
        <Panel padded>
          <div className="flex items-start justify-between">
            <div>
              <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
                <span aria-hidden="true" className="inline-block size-[0.55em] bg-primary" />
                RECENT ACTIVITY
              </p>
              <h2 className="mt-2 font-display text-xl font-bold tracking-[-.02em]">
                {allSessions} total runs
              </h2>
            </div>
            <span className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
              MEMORY WRITES · 7 DAYS
            </span>
          </div>
          <div
            className="mt-6 flex items-end gap-2"
            aria-label="Memory writes over the last seven days"
          >
            {activity.days.map((day, index) => (
              <div key={day.day} className="flex flex-1 flex-col items-center gap-2">
                <div className="flex h-28 w-full items-end bg-muted">
                  <div
                    className="w-full bg-primary"
                    style={{
                      height: `${Math.max(4, Math.round((day.count / activity.peak) * 100))}%`,
                    }}
                    title={`${day.count} memories`}
                  />
                </div>
                <span className="font-mono text-[10px] text-muted-foreground">
                  {WEEKDAYS[index]}
                </span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel padded>
          <p className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground">
            <span aria-hidden="true" className="inline-block size-[0.55em] bg-primary" />
            SESSION FOOTPRINT
          </p>
          <h2 className="mt-2 font-display text-xl font-bold tracking-[-.02em]">
            Lightweight by design
          </h2>
          <div className="mt-6 flex flex-col gap-4 text-xs">
            <FootprintRow label="Rows on this page" value={visibleRows.length} />
            <FootprintRow
              label="Average duration"
              value={averageDurationMs === null ? '—' : formatDuration(averageDurationMs)}
            />
            <FootprintRow label="Context text captured" value={formatBytes(contextCaptured)} />
            <FootprintRow label="Memory writes" value={lifetimeMemoryWrites} accent />
          </div>
        </Panel>
      </div>
    </Page>
  );
}

function FootprintRow({
  label,
  value,
  accent = false,
}: {
  label: string;
  value: string | number;
  accent?: boolean;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border pb-3 last:border-0 last:pb-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={accent ? 'text-primary' : undefined}>{value}</span>
    </div>
  );
}

function sessionStatusCounts(
  rows: readonly { readonly status: 'active' | 'ended' | 'abandoned'; readonly count: number }[],
): Record<'active' | 'ended' | 'abandoned', number> {
  const counts = { active: 0, ended: 0, abandoned: 0 };
  for (const row of rows) counts[row.status] = row.count;
  return counts;
}

function sessionTitle(row: {
  title: string | null;
  description: string | null;
  id: string;
  projectSlug: string | null;
}): string {
  return row.title ?? row.description ?? row.projectSlug ?? row.id;
}

function averageDuration(
  rows: readonly { startedAt: Date; endedAt: Date | null }[],
  nowMs: number,
): number | null {
  if (rows.length === 0) return null;
  const total = rows.reduce((acc, row) => {
    const end = row.endedAt ? row.endedAt.getTime() : nowMs;
    return acc + Math.max(0, end - row.startedAt.getTime());
  }, 0);
  return Math.round(total / rows.length);
}

function formatDuration(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function sevenDayActivity(rows: readonly { readonly day: number; readonly n: number }[]): {
  days: { day: number; count: number }[];
  peak: number;
} {
  const byDay = new Map(rows.map((row) => [row.day, row.n]));
  const today = Math.floor(Date.now() / DAY_MS);
  const days = Array.from({ length: 7 }, (_, index) => {
    const day = today - 6 + index;
    return { day, count: byDay.get(day) ?? 0 };
  });
  return { days, peak: Math.max(1, ...days.map((entry) => entry.count)) };
}
