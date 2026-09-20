import Link from 'next/link';
import type { ReactNode } from 'react';

import { formatBytes, ON_DEMAND_BACKUP_KEEP, readMaintenanceState, type Backup } from './data';

import { singleParam } from '@/components/dashboard/format';
import { Timestamp } from '@/components/dashboard/timestamp';
import { ViewHead } from '@/components/dashboard/view-head';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

/**
 * The maintenance view — the admin surface, ported read-only.
 *
 * It renders exactly what the retired Hono view rendered — the DB breakdown, the
 * three purge cards with their fresh per-render counts, the disabled-at-zero
 * copy, and the backup card with every downloadable snapshot — and it wires NONE
 * of the four mutations. Each purge and the on-demand backup are Server Actions
 * gated by admin scope and the mutation protection, and that boundary is a later
 * slice; rendering a live control here would either bypass it or ship a dead
 * form. The same reason leaves the view without an admin-scope gate: this app
 * still has no dashboard session to resolve a token from.
 *
 * The counts are re-read on every render (`force-dynamic`) because the card's
 * contract is a *fresh* count: a purge card that served a cached number would
 * offer to delete rows that no longer match its predicate.
 */
export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

export default async function MaintenancePage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const withBytes = singleParam(params.bytes) === '1';
  const flash = flashFrom(params);

  const state = readMaintenanceState(withBytes);
  const { breakdown } = state;

  return (
    <div className="flex flex-col gap-4">
      <ViewHead title="Rembric Maintenance." meta={[{ k: 'ADMIN ONLY', v: '*' }]} />

      {flash ? (
        <Card className="border-primary/40 bg-primary/5 py-3">
          <CardContent className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="outline" className="border-primary/50 font-mono text-brand-accent">
              {flash.label}
            </Badge>
            <span>{flash.body}</span>
          </CardContent>
        </Card>
      ) : null}

      <Card className="py-0">
        <CardHeader className="pt-4">
          <CardTitle className="font-mono text-xs tracking-[0.18em] text-muted-foreground uppercase">
            DB breakdown
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3 px-0 pb-0">
          <p className="px-4 text-sm text-muted-foreground">
            Total: <b className="text-foreground">{formatBytes(breakdown.totalBytes)}</b> ·
            Freelist: <b className="text-foreground">{formatBytes(breakdown.freelistBytes)}</b>
            {breakdown.freelistBytes > 0 ? (
              <>
                {' '}
                · Run <code className="font-mono">VACUUM</code> to reclaim
              </>
            ) : null}{' '}
            · Source: <code className="font-mono">{breakdown.source}</code>
            {withBytes ? null : (
              <>
                {' '}
                ·{' '}
                <Link
                  href="/dashboard/maintenance?bytes=1"
                  className="text-brand-accent underline-offset-4 hover:underline"
                >
                  Measure per-table bytes
                </Link>
              </>
            )}
          </p>
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="pl-4">TABLE</TableHead>
                <TableHead>ROWS</TableHead>
                <TableHead className="pr-4 text-right">BYTES</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {breakdown.perTable.map((row) => (
                <TableRow key={row.name}>
                  <TableCell className="pl-4 font-mono text-xs">{row.name}</TableCell>
                  <TableCell className="text-muted-foreground">{row.rowCount ?? '—'}</TableCell>
                  <TableCell className="pr-4 text-right text-muted-foreground">
                    {breakdown.source === 'dbstat' ? formatBytes(row.bytes) : '—'}
                  </TableCell>
                </TableRow>
              ))}
              <TableRow className="hover:bg-transparent">
                <TableCell className="pl-4 font-mono text-xs">TOTAL FILE</TableCell>
                <TableCell className="text-muted-foreground">—</TableCell>
                <TableCell className="pr-4 text-right font-mono">
                  {formatBytes(breakdown.totalBytes)}
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <div className="grid gap-3 lg:grid-cols-2">
        <PurgeCard
          title="Empty Sessions"
          count={state.emptySessions}
          disabledLabel="NO EMPTY SESSIONS TO PURGE"
          actionLabel={`PURGE EMPTY SESSIONS (${state.emptySessions})`}
          predicate={
            <>
              <p>Eligible rows match ALL of:</p>
              <ul className="list-disc pl-5">
                <li>status = ended or abandoned</li>
                <li>zero memories, prompts, confirmations referencing</li>
                <li>no summary written, no manual title</li>
                <li>not operator-soft-deleted</li>
                <li>ended over 1 hour ago (late summary grace)</li>
              </ul>
            </>
          }
        />

        <PurgeCard
          title="Disconnected Archived Memories"
          count={state.archivedMemories}
          disabledLabel="NO DISCONNECTED ARCHIVED TO PURGE"
          actionLabel={`PURGE DISCONNECTED ARCHIVED (${state.archivedMemories})`}
          predicate={
            <>
              <p>Eligible rows match ALL of:</p>
              <ul className="list-disc pl-5">
                <li>status = archived</li>
                <li>
                  no other memory&apos;s <code className="font-mono">replaces</code> points here
                </li>
                <li>
                  no <code className="font-mono">consolidation_ops</code> affects this id
                </li>
                <li>
                  no <code className="font-mono">memory_relations</code> references this id
                </li>
                <li>no confirmations target this id</li>
              </ul>
              <p>
                <code className="font-mono">memory_vec</code> +{' '}
                <code className="font-mono">memory_fts</code> shadow rows are dropped in the same
                transaction.
              </p>
            </>
          }
        />

        <PurgeCard
          title="Deleted Prompts"
          count={state.deletedPrompts}
          disabledLabel="NO DELETED PROMPTS TO PURGE"
          actionLabel={`PURGE DELETED PROMPTS (${state.deletedPrompts})`}
          predicate={
            <>
              <p>Eligible rows match:</p>
              <ul className="list-disc pl-5">
                <li>
                  <code className="font-mono">deleted_at IS NOT NULL</code>
                </li>
              </ul>
              <p>
                Covers both operator soft-deletes and refine supersedes (from{' '}
                <code className="font-mono">memory.save_prompt</code>). The{' '}
                <code className="font-mono">prompts_fts</code> shadow row is dropped in the same
                transaction.
              </p>
            </>
          }
        />

        <Card className="gap-3">
          <CardHeader>
            <CardTitle className="font-heading text-base">Backup Database</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3 text-sm">
            <p className="text-muted-foreground">
              Writes a consistent, WAL-safe snapshot of the live database via{' '}
              <code className="font-mono">VACUUM INTO</code> (the same mechanism the self-update
              flow uses before every upgrade), keeping the {ON_DEMAND_BACKUP_KEEP} most recent
              on-demand snapshots.
            </p>
            {state.latestOnDemand ? (
              <p className="text-muted-foreground">
                Last backup: <Timestamp value={state.latestOnDemand.createdAt} /> ·{' '}
                {formatBytes(state.latestOnDemand.sizeBytes)} ·{' '}
                <Link
                  href="/dashboard/maintenance/backup/download"
                  className="text-brand-accent underline-offset-4 hover:underline"
                >
                  Download latest
                </Link>
              </p>
            ) : (
              <p className="text-muted-foreground">No on-demand backup yet.</p>
            )}
            {state.backups.length > 0 ? (
              <>
                <p className="text-muted-foreground">
                  Every snapshot in <code className="font-mono">backups/</code> is individually
                  downloadable, including the pre-update snapshot the self-update flow takes before
                  every upgrade:
                </p>
                <ul className="flex flex-col gap-1">
                  {state.backups.map((b) => (
                    <li key={b.file} className="text-xs text-muted-foreground">
                      <BackupLink backup={b} /> · <Timestamp value={b.createdAt} /> ·{' '}
                      {formatBytes(b.sizeBytes)}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <Button variant="outline" disabled>
              BACKUP NOW
            </Button>
          </CardContent>
        </Card>
      </div>

      <p className="text-xs text-muted-foreground">
        The three purges and <code className="font-mono">BACKUP NOW</code> are not wired in this
        slice: each is a Server Action gated by an admin-scoped token and the mutation protection,
        and each one is journaled in <code className="font-mono">consolidation_ops</code> for audit.
        Until then this view renders the counts and the copy they will act on.
      </p>
    </div>
  );
}

function PurgeCard({
  title,
  count,
  predicate,
  actionLabel,
  disabledLabel,
}: {
  title: string;
  count: number;
  predicate: ReactNode;
  actionLabel: string;
  disabledLabel: string;
}) {
  return (
    <Card className="gap-3">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-heading text-base">
          {title}
          <Badge
            variant="outline"
            className={count === 0 ? 'font-mono text-muted-foreground' : 'font-mono text-warn'}
          >
            {count}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm text-muted-foreground">
        {predicate}
        <Button variant="destructive" disabled>
          {count === 0 ? disabledLabel : actionLabel}
        </Button>
      </CardContent>
    </Card>
  );
}

function BackupLink({ backup }: { backup: Backup }) {
  return (
    <Link
      href={`/dashboard/maintenance/backup/download/${encodeURIComponent(backup.file)}`}
      className="text-brand-accent underline-offset-4 hover:underline"
    >
      {backup.kind}
    </Link>
  );
}

/**
 * The redirect-plus-flash contract the retired POST handlers used. Presence is
 * what signals a flash (the retired view tested `searchParams.get(...) !== null`),
 * so this reads the raw value rather than the shared single-value helper.
 */
function flashFrom(params: SearchParams): { label: string; body: string } | null {
  const purgedSessions = first(params['purged-sessions']);
  if (purgedSessions !== undefined) {
    return { label: 'PURGED', body: `Removed ${purgedSessions} empty session row(s).` };
  }
  const purgedMemories = first(params['purged-memories']);
  if (purgedMemories !== undefined) {
    return {
      label: 'PURGED',
      body: `Removed ${purgedMemories} disconnected archived memory row(s).`,
    };
  }
  const purgedPrompts = first(params['purged-prompts']);
  if (purgedPrompts !== undefined) {
    return { label: 'PURGED', body: `Removed ${purgedPrompts} deleted prompt row(s).` };
  }
  const backedUp = first(params['backed-up']);
  if (backedUp !== undefined) {
    return { label: 'BACKED UP', body: `Snapshot written (${backedUp} bytes).` };
  }
  return null;
}

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}
