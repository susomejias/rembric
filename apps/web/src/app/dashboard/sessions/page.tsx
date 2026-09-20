import { AGENT_SESSION_STATUSES } from '@rembric/db';
import { Radio } from 'lucide-react';
import Link from 'next/link';

import {
  parseSessionStatus,
  readSessionsFilters,
  resolveProjectFilter,
  sessionsQuery,
  type SearchParams,
} from './filters';

import {
  FilterActions,
  FilterField,
  FilterForm,
  FilterInput,
  FilterSelect,
  Pager,
} from '@/components/dashboard/filters';
import { PAGE_SIZE, durationBetween, formatBytes } from '@/components/dashboard/support';
import {
  EmptyNote,
  Page,
  PageHead,
  Panel,
  PanelHead,
  Pill,
  Row,
  Rows,
  StatTile,
  Time,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The sessions list, in the v0 composition: the live band, the filtered table
 * rows, the activity chart and the footprint panel.
 *
 * The reads and the filter model are the ported view's own — the same
 * `AdminSessionFilters`, the same `deleted: false` address for the filtered
 * table, the same second page-sized slice for the soft-deleted table, the same
 * `titleCascade`. The retired row actions (Abandon, Delete) stay unported: both
 * are mutations whose Server Action boundary is a separate slice.
 */
export const dynamic = 'force-dynamic';

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

  const { repos } = getServices();
  const nowMs = Date.now();

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

  // Filters apply to the non-deleted table only, exactly as the retired view
  // read them; the soft-deleted table is a second, unfiltered page-sized slice.
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

  const liveRows = visibleRows.filter((row) => row.status === 'active');

  return (
    <Page>
      <PageHead
        icon={Radio}
        eyebrow="Session monitor"
        title="Sessions"
        description="A focused view of the context being created right now, with recent runs kept close at hand."
        aside={
          <div className="flex items-center gap-2 rounded-full border border-(--accent-ink)/20 bg-(--accent-ink)/[6%] px-3 py-1.5 text-[11px] text-(--accent-ink)">
            <span className="size-1.5 rounded-full bg-lime-300 shadow-[0_0_10px_#c4f23f]" />
            {statusCounts.active} live session{statusCounts.active === 1 ? '' : 's'}
          </div>
        }
      />

      <Panel className="mt-6">
        <PanelHead
          eyebrow="Live now"
          title="Working context"
          action={liveRows.length > 0 ? 'Started and still open' : 'No open run in this page'}
        />
        {liveRows.length === 0 ? (
          <EmptyNote>Nothing is running in this slice of the list.</EmptyNote>
        ) : (
          <Rows>
            {liveRows.map((session, index) => (
              <Link key={session.id} href={`/dashboard/sessions/${session.id}`} className="block">
                <Row columns="md:grid-cols-[minmax(210px,1fr)_1.5fr_auto_auto]">
                  <div className="flex items-center gap-3">
                    <span className="size-2 rounded-full bg-lime-300 shadow-[0_0_10px_#c4f23f]" />
                    <div>
                      <p className="text-sm font-medium">{sessionTitle(session)}</p>
                      <p className="mt-1 text-[11px] text-(--ink)/38">
                        Session {String(index + 1).padStart(2, '0')} · {session.agent}
                      </p>
                    </div>
                  </div>
                  <div>
                    <p className="text-xs text-(--ink)/65">
                      {session.description ?? 'No description reported by the client'}
                    </p>
                    <p className="mt-2 text-[10px] text-(--ink)/38">
                      {memoryCounts[session.id] ?? 0} memories · {promptCounts[session.id] ?? 0}{' '}
                      prompts
                    </p>
                  </div>
                  <span className="text-[11px] text-(--ink)/45">
                    {durationBetween(session.startedAt, session.endedAt, nowMs)}
                  </span>
                  <span className="w-fit text-[11px] text-(--ink)/38">View context</span>
                </Row>
              </Link>
            ))}
          </Rows>
        )}
      </Panel>

      <FilterForm action="/dashboard/sessions" className="mt-6">
        <FilterField label="Scope" htmlFor="s-project" className="w-44">
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
        <FilterField label="Agent" htmlFor="s-agent" className="w-40">
          <FilterInput id="s-agent" name="agent" value={filters.agent} placeholder="claude-code" />
        </FilterField>
        <FilterField label="Status" htmlFor="s-status" className="w-36">
          <FilterSelect
            id="s-status"
            name="status"
            value={filters.status}
            options={STATUS_OPTIONS}
          />
        </FilterField>
        <FilterField label="Deleted" htmlFor="s-deleted" className="w-32">
          <FilterSelect
            id="s-deleted"
            name="include_deleted"
            value={filters.includeDeleted ? '1' : ''}
            options={[
              { value: '', label: 'hidden' },
              { value: '1', label: 'shown' },
            ]}
          />
        </FilterField>
        <FilterActions clearHref="/dashboard/sessions" />
      </FilterForm>

      <Panel className="mt-6">
        <PanelHead eyebrow="Runs" title="Session history" action={`${total} matching`} />
        {visibleRows.length === 0 ? (
          <EmptyNote>
            {isFiltered
              ? 'No session matches this filter set.'
              : 'No session has been recorded yet.'}
          </EmptyNote>
        ) : (
          <Rows>
            {visibleRows.map((session) => (
              <Link key={session.id} href={`/dashboard/sessions/${session.id}`} className="block">
                <Row columns="md:grid-cols-[minmax(220px,1.3fr)_1fr_1fr_auto_auto]">
                  <div>
                    <p className="truncate text-sm text-(--ink)/80">{sessionTitle(session)}</p>
                    <p className="mt-1 text-[10px] text-(--ink)/38">
                      {session.agent} · {session.tokenName ?? 'no token'}
                    </p>
                  </div>
                  <span className="text-[11px] text-(--ink)/45">
                    {session.projectSlug ?? 'global scope'}
                  </span>
                  <span className="text-[11px] text-(--ink)/45">
                    <Time value={session.startedAt} />
                  </span>
                  <span className="text-[11px] text-(--ink)/38">
                    {memoryCounts[session.id] ?? 0} mem · {promptCounts[session.id] ?? 0} prompts
                  </span>
                  <Pill tone={session.status === 'active' ? 'lime' : 'dim'}>{session.status}</Pill>
                </Row>
              </Link>
            ))}
          </Rows>
        )}
        <div className="px-5 pb-5 md:px-6">
          <Pager
            page={filters.page}
            hasMore={visibleHasMore}
            total={total}
            totalLabel={`${visibleRows.length} rows`}
            path="/dashboard/sessions"
            query={roundTripQuery}
          />
        </div>
      </Panel>

      {filters.includeDeleted ? (
        <Panel className="mt-6">
          <PanelHead
            eyebrow="Soft-deleted"
            title="Removed from the active list"
            action={deletedHasMore ? 'more rows on this page set' : 'complete slice'}
          />
          {deletedRows.length === 0 ? (
            <EmptyNote>No soft-deleted session in this slice.</EmptyNote>
          ) : (
            <Rows>
              {deletedRows.map((session) => (
                <Link key={session.id} href={`/dashboard/sessions/${session.id}`} className="block">
                  <Row columns="md:grid-cols-[1.4fr_1fr_auto_auto]">
                    <p className="truncate text-sm text-(--ink)/70">{sessionTitle(session)}</p>
                    <span className="text-[11px] text-(--ink)/45">{session.agent}</span>
                    <span className="text-[11px] text-(--ink)/38">
                      <Time value={session.deletedAt} />
                    </span>
                    <Pill tone="danger">deleted</Pill>
                  </Row>
                </Link>
              ))}
            </Rows>
          )}
        </Panel>
      ) : null}

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
        <Panel padded>
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[10px] tracking-[.14em] text-(--ink)/38 uppercase">
                Recent activity
              </p>
              <h2 className="mt-2 text-xl font-medium tracking-[-.04em]">
                {allSessions} total runs
              </h2>
            </div>
            <span className="text-[11px] text-(--ink)/38">Memory writes, 7 days</span>
          </div>
          <div
            className="mt-6 flex items-end gap-2"
            aria-label="Memory writes over the last seven days"
          >
            {activity.days.map((day, index) => (
              <div key={day.day} className="flex flex-1 flex-col items-center gap-2">
                <div className="flex h-28 w-full items-end rounded-md bg-(--surface-tile)">
                  <div
                    className="w-full rounded-md bg-(--accent-ink)/60"
                    style={{
                      height: `${Math.max(4, Math.round((day.count / activity.peak) * 100))}%`,
                    }}
                    title={`${day.count} memories`}
                  />
                </div>
                <span className="text-[10px] text-(--ink)/25">{WEEKDAYS[index]}</span>
              </div>
            ))}
          </div>
        </Panel>
        <Panel padded>
          <p className="text-[10px] tracking-[.14em] text-(--ink)/38 uppercase">
            Session footprint
          </p>
          <h2 className="mt-2 text-xl font-medium tracking-[-.04em]">Lightweight by design</h2>
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

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatTile label="Active" value={statusCounts.active} tone="lime" hint="open right now" />
        <StatTile label="Abandoned" value={statusCounts.abandoned} hint="swept after inactivity" />
        <StatTile label="Ended" value={statusCounts.ended} hint="closed by the client" />
      </section>
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
    <div className="flex items-center justify-between border-b border-(--ink)/[6%] pb-3 last:border-0 last:pb-0">
      <span className="text-(--ink)/45">{label}</span>
      <span className={accent ? 'text-(--accent-ink)' : undefined}>{value}</span>
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
