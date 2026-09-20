import { DEFAULT_MIN_INTERVAL_MS } from '@rembric/core';
import type { Repositories } from '@rembric/db';
import Link from 'next/link';

import { EmptyState } from '@/components/dashboard/empty-state';
import { PAGE_SIZE, pageParam } from '@/components/dashboard/format';
import { Pager } from '@/components/dashboard/pager';
import { StatCard } from '@/components/dashboard/stat-card';
import { Timestamp } from '@/components/dashboard/timestamp';
import { ViewHead } from '@/components/dashboard/view-head';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
 * The consolidation view — the journal of the deterministic sweep, read straight
 * from `@rembric/core`'s repositories like `apps/server/src/dashboard/consolidation.ts`
 * reads them, minus the manual trigger.
 *
 * The sweep is NOT a cron in this process: it fires from the request path
 * (`services.sweep()` on session start, and the `/mcp` + `/api` routes own that
 * call). This view therefore renders the runs and their op counts and offers no
 * mutation — no force-sweep form, no undo form. Both are journaled mutations and
 * their boundary is a later slice.
 *
 * A run row has no `status` column: the state shown per row is derived from the
 * op counts exactly as the retired view derived it (no ops → no-op, all reverted,
 * partial, else the op count).
 */
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function ConsolidationPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const page = pageParam(params.page);
  const offset = page * PAGE_SIZE;

  const { repos } = getServices();

  const runsRaw = repos.consolidation.adminListRuns(PAGE_SIZE + 1, offset);
  const hasMore = runsRaw.length > PAGE_SIZE;
  const runs = runsRaw.slice(0, PAGE_SIZE);
  const total = repos.consolidation.adminCountRuns();

  const rows = runs.map((run) => ({
    run,
    scope: scopeLabel(repos, run.scope),
    counts: repos.consolidation.adminOpCounts(run.id),
  }));

  // The health strip is about the corpus, not about this page: the last run is
  // queried independently of the pagination offset, exactly as the retired
  // overview did.
  const lastRunRow = repos.consolidation.adminListRuns(1, 0).at(0) ?? null;
  const lastRunCounts = lastRunRow
    ? repos.consolidation.adminOpCounts(lastRunRow.id)
    : { total: 0, reverted: 0 };
  const orphanedPendings = repos.relations.adminCountByStatus('orphaned');
  const thresholds = orphanThresholds();

  return (
    <div className="flex flex-col gap-4">
      <ViewHead title="Rembric Consolidation." meta={[{ k: 'TOTAL', v: total }]} />

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard
          label="Last run"
          value={lastRunRow ? 'OK' : '—'}
          tone={lastRunRow ? 'accent' : 'dim'}
          hint={
            lastRunRow ? (
              <>
                <Timestamp value={lastRunRow.finishedAt ?? lastRunRow.startedAt} /> ·{' '}
                {scopeLabel(repos, lastRunRow.scope)}
              </>
            ) : (
              'NEVER'
            )
          }
        />
        <StatCard
          label="Ops applied"
          value={lastRunCounts.total}
          hint={`${lastRunCounts.reverted} REVERTED`}
        />
        <StatCard
          label="Orphaned pendings"
          value={orphanedPendings}
          tone={orphanedPendings > 0 ? 'warn' : 'accent'}
          hint={`RE-EXPOSED > ${formatWindow(thresholds.afterMs)} · ORPHANED > ${formatWindow(
            thresholds.deadlineMs,
          )}`}
        />
        <StatCard
          label="Trigger"
          value={<span className="font-mono text-lg">ON SESSION START</span>}
          hint={`THROTTLED ${formatWindow(DEFAULT_MIN_INTERVAL_MS)} / SCOPE`}
        />
      </div>

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
            Runs
          </CardTitle>
        </CardHeader>
        <CardContent className="px-0 pb-0">
          {rows.length === 0 ? (
            <div className="px-4 pb-4">
              <EmptyState>
                No runs yet. The deterministic sweep runs on session start (throttled per scope).
              </EmptyState>
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className="pl-4">started</TableHead>
                  <TableHead>finished</TableHead>
                  <TableHead>scope</TableHead>
                  <TableHead className="pr-4">status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map(({ run, scope, counts }) => (
                  <TableRow key={run.id}>
                    <TableCell className="pl-4 text-muted-foreground">
                      <Link
                        href={`/dashboard/consolidation/${run.id}`}
                        className="underline-offset-4 hover:underline"
                      >
                        <Timestamp value={run.startedAt} />
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      <Timestamp value={run.finishedAt} />
                    </TableCell>
                    <TableCell>{scope}</TableCell>
                    <TableCell className="pr-4">
                      <RunStatusBadge counts={counts} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {rows.length > 0 || page > 0 ? (
        <Pager
          page={page}
          hasMore={hasMore}
          total={total}
          totalLabel={`${rows.length} ROWS`}
          path="/dashboard/consolidation"
          query={{}}
        />
      ) : null}
    </div>
  );
}

/** `project:<id>` → project slug when the project still exists; raw value otherwise. */
function scopeLabel(repos: Repositories, scope: string | null): string {
  if (scope === null) return '—';
  if (!scope.startsWith('project:')) return scope;
  const row = repos.projects.adminFindById(scope.slice('project:'.length));
  return row?.slug ?? scope;
}

function RunStatusBadge({ counts }: { counts: { total: number; reverted: number } }) {
  if (counts.total === 0) {
    return (
      <Badge variant="outline" className="font-mono text-muted-foreground">
        no-op
      </Badge>
    );
  }
  if (counts.reverted === counts.total) {
    return (
      <Badge variant="outline" className="font-mono text-muted-foreground">
        fully reverted
      </Badge>
    );
  }
  if (counts.reverted > 0) {
    return (
      <Badge variant="outline" className="border-warn/50 font-mono text-warn">
        {counts.reverted}/{counts.total} reverted
      </Badge>
    );
  }
  return (
    <Badge variant="outline" className="border-primary/50 font-mono text-brand-accent">
      {counts.total} ops
    </Badge>
  );
}

/**
 * The two judgment windows the sweep enforces. Same names, defaults and bounds
 * as `apps/server/src/config.ts`'s zod schema — an unparseable or out-of-range
 * value falls back to the same default here rather than failing the render, so
 * the thresholds the operator reads can never drift from the ones the sweep
 * applies on the server process.
 */
function orphanThresholds(): { afterMs: number; deadlineMs: number } {
  return {
    afterMs: envInt('JUDGMENT_ORPHAN_AFTER_MS', 86_400_000, 60_000, 30 * 86_400_000),
    deadlineMs: envInt('JUDGMENT_ORPHAN_DEADLINE_MS', 14 * 86_400_000, 3_600_000, 365 * 86_400_000),
  };
}

function envInt(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return fallback;
  return Math.min(Math.max(parsed, min), max);
}

/** `fmtWindow` from the retired overview: the window as `H` under 48h, else `D`. */
function formatWindow(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  return hours >= 48 ? `${Math.round(hours / 24)}D` : `${hours}H`;
}
