import Link from 'next/link';

import { formatBytes, readMaintenanceState } from './data';
import { ON_DEMAND_BACKUP_KEEP } from './data';

import { getUpdates } from '@/app/dashboard/update/update-service';
import {
  Bar,
  DataBody,
  DataHead,
  DataTable,
  DataTd,
  DataTh,
  DataTr,
  Notice,
  Page,
  Pill,
  SectionBar,
  StatCard,
  StatGrid,
  TableEmpty,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * Maintenance, in the production dashboard's composition: the numbered view head,
 * the health counters, the update banner, the two policy cards, and the purge
 * candidates, disk breakdown and snapshots as tables.
 *
 * No mutation lives here on purpose: the three purges and the on-demand backup
 * are journaled writes whose boundary (admin scope + the mutation protection) is
 * a later slice, so this view renders their *state* and their disabled controls
 * — the same boundary the ported view drew.
 */
export const dynamic = 'force-dynamic';

export default function MaintenancePage() {
  const state = readMaintenanceState(true);
  const { breakdown } = state;
  const { repos } = getServices();
  const orphanedPendings = repos.relations.adminCountByStatus('orphaned');
  const updates = getUpdates();
  const release = updates.enabled ? updates.peek() : null;
  const freelistShare =
    breakdown.totalBytes > 0
      ? Math.round((breakdown.freelistBytes / breakdown.totalBytes) * 100)
      : 0;

  return (
    <Page>
      <ViewHead
        num="08"
        title="Rembric Maintenance."
        hl="Rembric"
        meta={[{ k: 'ADMIN ONLY', v: '*' }]}
      />

      <StatGrid className="mt-6 sm:grid-cols-3 xl:grid-cols-3">
        <StatCard
          k="SYSTEM HEALTH"
          v={breakdown.source === 'dbstat' ? 'Good' : 'Partial'}
          tone="lime"
          sub={<span>BREAKDOWN READ FROM {breakdown.source.toUpperCase()}</span>}
        />
        <StatCard
          k="DATABASE SIZE"
          v={formatBytes(breakdown.totalBytes)}
          sub={<span>{formatBytes(breakdown.freelistBytes)} RECLAIMABLE</span>}
        />
        <StatCard
          k="QUEUED WORK"
          v={orphanedPendings}
          tone={orphanedPendings > 0 ? 'amber' : 'dim'}
          sub={<span>ORPHANED JUDGMENTS</span>}
        />
      </StatGrid>

      {release ? (
        <section className="mt-6 border border-primary/40 bg-primary/5 p-5 md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
                UPDATE AVAILABLE
              </p>
              <h2 className="mt-2 font-display text-xl font-bold tracking-[-.02em]">
                Rembric v{release.latestVersion} is published
              </h2>
              <p className="mt-2 max-w-xl text-xs leading-5 text-muted-foreground">
                The release check found a newer version. Upgrading is done on the host that runs
                this deployment — this dashboard never replaces its own image.
              </p>
            </div>
            <Pill tone="lime">pending restart</Pill>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="font-mono text-[11px] uppercase tracking-[.12em] text-muted-foreground">
              {release.publishedAt ? (
                <Time value={release.publishedAt} />
              ) : (
                'PUBLICATION DATE UNKNOWN'
              )}{' '}
              · BACKUP BEFORE UPDATING
            </p>
            <Link
              href="/dashboard/update"
              className="bg-primary px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[.12em] text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Open the release
            </Link>
          </div>
        </section>
      ) : null}

      <div className="mt-6 grid gap-3 md:grid-cols-2">
        <div className="border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
                CONTEXT
              </p>
              <h2 className="mt-2 text-base font-medium">Safe purges</h2>
            </div>
            <span className="border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-muted-foreground">
              journaled
            </span>
          </div>
          <p className="mt-3 max-w-lg text-xs leading-5 text-muted-foreground">
            Physical deletion is reserved for empty sessions, disconnected archived memories, and
            deleted prompts. Every purge is journaled and reversible.
          </p>
          <p className="mt-5 font-mono text-[11px] uppercase tracking-[.12em] text-muted-foreground">
            DRY RUN ONLY — THE PURGE BOUNDARY IS A SEPARATE SLICE
          </p>
        </div>
        <div className="border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
                CONTEXT
              </p>
              <h2 className="mt-2 text-base font-medium">Disk recovery</h2>
            </div>
            <span className="border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-muted-foreground">
              freelist
            </span>
          </div>
          <p className="mt-3 max-w-lg text-xs leading-5 text-muted-foreground">
            The freelist is space SQLite has already reclaimed inside the file. `VACUUM` is the
            final operator step and the only one that shrinks the file on disk.
          </p>
          <div className="mt-5">
            <div className="flex justify-between text-xs">
              <span className="text-muted-foreground">Reclaimable</span>
              <span>{freelistShare}% of the file</span>
            </div>
            <Bar percent={freelistShare} tone="amber" />
          </div>
        </div>
      </div>

      <div className="mt-8">
        <SectionBar name="Purge candidates" meta="STATE ONLY · NO CONTROL IS WIRED" />
      </div>
      <DataTable>
        <DataHead>
          <DataTh>candidate</DataTh>
          <DataTh>count</DataTh>
          <DataTh>actions</DataTh>
        </DataHead>
        <DataBody>
          <PurgeRow label="Empty sessions" count={state.emptySessions} href="/dashboard/sessions" />
          <PurgeRow
            label="Disconnected archived memories"
            count={state.archivedMemories}
            href="/dashboard/memories?status=archived"
          />
          <PurgeRow
            label="Deleted prompts"
            count={state.deletedPrompts}
            href="/dashboard/prompts?include_deleted=1"
          />
        </DataBody>
      </DataTable>

      {/* `min-w-0` on both columns is load-bearing: a grid item's default
          `min-width: auto` floors its track at its min-content width, and this
          min-content is the tables' own 720px. Without it the grid — not the
          tables — overflows the viewport. */}
      <div className="mt-8 grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
        <div className="min-w-0">
          <SectionBar name="Per-table breakdown" meta={breakdown.source.toUpperCase()} />
          {breakdown.perTable.length === 0 ? (
            <TableEmpty>NO TABLE EXCEEDED THE REPORTING THRESHOLD</TableEmpty>
          ) : (
            <DataTable>
              <DataHead>
                <DataTh>table</DataTh>
                <DataTh>share</DataTh>
                <DataTh>size</DataTh>
                <DataTh>rows</DataTh>
              </DataHead>
              <DataBody>
                {breakdown.perTable.map((table) => (
                  <DataTr key={table.name}>
                    <DataTd className="font-mono text-xs text-muted-foreground">
                      {table.name}
                    </DataTd>
                    <DataTd className="min-w-[160px]">
                      <Bar
                        percent={Math.round(
                          (table.bytes / Math.max(1, breakdown.totalBytes)) * 100,
                        )}
                      />
                    </DataTd>
                    <DataTd className="text-muted-foreground">{formatBytes(table.bytes)}</DataTd>
                    <DataTd className="font-mono text-xs text-muted-foreground">
                      {table.rowCount ?? '—'}
                    </DataTd>
                  </DataTr>
                ))}
              </DataBody>
            </DataTable>
          )}
        </div>

        <div className="min-w-0">
          <SectionBar
            name="Available backups"
            meta={`${state.backups.length} KEPT · ON-DEMAND KEEPS ${ON_DEMAND_BACKUP_KEEP}`}
          />
          {state.backups.length === 0 ? (
            <TableEmpty>NO SNAPSHOT EXISTS IN {state.backupsDir}</TableEmpty>
          ) : (
            <DataTable>
              <DataHead>
                <DataTh>file</DataTh>
                <DataTh>created</DataTh>
                <DataTh>size</DataTh>
              </DataHead>
              <DataBody>
                {state.backups.map((backup) => (
                  <DataTr key={backup.file}>
                    <DataTd className="max-w-[280px] truncate font-mono text-xs text-muted-foreground">
                      {backup.file}
                    </DataTd>
                    <DataTd className="font-mono text-xs text-muted-foreground">
                      <Time value={backup.createdAt} />
                    </DataTd>
                    <DataTd className="text-muted-foreground">
                      {formatBytes(backup.sizeBytes)}
                    </DataTd>
                  </DataTr>
                ))}
              </DataBody>
            </DataTable>
          )}
        </div>
      </div>

      <Notice badge="Operator step" className="mt-6">
        Restoring a snapshot and running `VACUUM` are host operations: stop the server, then work on
        the file in <code className="font-mono">{state.backupsDir}</code>.
      </Notice>
    </Page>
  );
}

function PurgeRow({ label, count, href }: { label: string; count: number; href: string }) {
  return (
    <DataTr>
      <DataTd>{label}</DataTd>
      <DataTd>
        <Pill tone={count > 0 ? 'amber' : 'dim'}>{count}</Pill>
      </DataTd>
      <DataTd>
        <Link
          href={href}
          className="font-mono text-[11px] uppercase tracking-[.14em] text-muted-foreground hover:text-primary"
        >
          Inspect candidates →
        </Link>
      </DataTd>
    </DataTr>
  );
}
