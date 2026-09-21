import { Download, Wrench } from 'lucide-react';
import Link from 'next/link';

import { formatBytes, readMaintenanceState } from './data';
import { ON_DEMAND_BACKUP_KEEP } from './data';

import { getUpdates } from '@/app/dashboard/update/update-service';
import {
  Bar,
  EmptyNote,
  Notice,
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
 * Maintenance, in the v0 composition: the health counters, the update banner,
 * the two policy panels, the purge-candidate rows and the disk breakdown.
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
      <PageHead
        icon={Wrench}
        eyebrow="System care"
        title="Maintenance"
        description="Keep the local memory layer healthy with small, safe, and mostly automatic checks."
        aside={<span className="text-[11px] text-muted-foreground">admin scope · *</span>}
      />

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatTile
          label="System health"
          value={breakdown.source === 'dbstat' ? 'Good' : 'Partial'}
          tone="lime"
          hint={`breakdown read from ${breakdown.source}`}
        />
        <StatTile
          label="Database size"
          value={formatBytes(breakdown.totalBytes)}
          hint={`${formatBytes(breakdown.freelistBytes)} reclaimable`}
        />
        <StatTile
          label="Queued work"
          value={orphanedPendings}
          tone={orphanedPendings > 0 ? 'amber' : 'dim'}
          hint="orphaned judgments"
        />
      </section>

      {release ? (
        <section className="mt-6 rounded-xl border border-primary/30 bg-primary/5 p-5 md:p-6">
          <div className="flex flex-wrap items-start justify-between gap-5">
            <div className="flex items-start gap-3">
              <div className="grid size-9 shrink-0 place-items-center rounded-xl bg-primary/10 text-primary">
                <Download className="size-4" />
              </div>
              <div>
                <p className="text-[10px] tracking-[.14em] text-primary uppercase">
                  Update available
                </p>
                <h2 className="mt-2 text-xl font-medium tracking-[-.04em]">
                  Rembric v{release.latestVersion} is published
                </h2>
                <p className="mt-2 max-w-xl text-xs leading-5 text-muted-foreground">
                  The release check found a newer version. Upgrading is done on the host that runs
                  this deployment — this dashboard never replaces its own image.
                </p>
              </div>
            </div>
            <Pill tone="lime">pending restart</Pill>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
            <p className="text-[11px] text-muted-foreground">
              {release.publishedAt ? (
                <Time value={release.publishedAt} />
              ) : (
                'Publication date unknown'
              )}{' '}
              · backup before updating
            </p>
            <Link
              href="/dashboard/update"
              className="rounded-lg bg-primary px-3 py-2 text-[11px] font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              Open the release
            </Link>
          </div>
        </section>
      ) : null}

      <section className="mt-6 grid gap-3 md:grid-cols-2">
        <article className="rounded-2xl border border-border bg-muted p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] tracking-[.14em] text-primary uppercase">Context</p>
              <h2 className="mt-2 text-base font-medium">Safe purges</h2>
            </div>
            <span className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground">
              journaled
            </span>
          </div>
          <p className="mt-3 max-w-lg text-xs leading-5 text-muted-foreground">
            Physical deletion is reserved for empty sessions, disconnected archived memories, and
            deleted prompts. Every purge is journaled and reversible.
          </p>
          <p className="mt-5 text-[11px] text-muted-foreground">
            Dry run only — the purge boundary is a separate slice.
          </p>
        </article>
        <article className="rounded-2xl border border-border bg-muted p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] tracking-[.14em] text-primary uppercase">Context</p>
              <h2 className="mt-2 text-base font-medium">Disk recovery</h2>
            </div>
            <span className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground">
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
        </article>
      </section>

      <Panel className="mt-6">
        <PanelHead
          eyebrow="Purge candidates"
          title="What a purge would touch"
          action="state only, no control is wired"
        />
        <Rows>
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
        </Rows>
      </Panel>

      <div className="mt-6 grid gap-6 xl:grid-cols-[1.1fr_.9fr]">
        <Panel>
          <PanelHead eyebrow="Storage" title="Per-table breakdown" action={breakdown.source} />
          {breakdown.perTable.length === 0 ? (
            <EmptyNote>No table exceeded the reporting threshold.</EmptyNote>
          ) : (
            <Rows>
              {breakdown.perTable.map((table) => (
                <Row key={table.name} columns="md:grid-cols-[1.4fr_1fr_auto]">
                  <code className="text-xs text-muted-foreground">{table.name}</code>
                  <div className="max-w-[220px]">
                    <Bar
                      percent={Math.round((table.bytes / Math.max(1, breakdown.totalBytes)) * 100)}
                    />
                  </div>
                  <span className="text-[11px] text-muted-foreground">
                    {formatBytes(table.bytes)}
                    {table.rowCount === null ? '' : ` · ${table.rowCount} rows`}
                  </span>
                </Row>
              ))}
            </Rows>
          )}
        </Panel>

        <Panel>
          <PanelHead
            eyebrow="Snapshots"
            title="Available backups"
            action={`${state.backups.length} kept · on-demand keeps ${ON_DEMAND_BACKUP_KEEP}`}
          />
          {state.backups.length === 0 ? (
            <EmptyNote>No snapshot exists in {state.backupsDir} yet.</EmptyNote>
          ) : (
            <Rows>
              {state.backups.map((backup) => (
                <Row key={backup.file} columns="md:grid-cols-[1.6fr_1fr_auto]">
                  <code className="truncate text-xs text-muted-foreground">{backup.file}</code>
                  <span className="text-[11px] text-muted-foreground">
                    <Time value={backup.createdAt} />
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {formatBytes(backup.sizeBytes)}
                  </span>
                </Row>
              ))}
            </Rows>
          )}
        </Panel>
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
    <Row columns="md:grid-cols-[1.4fr_1fr_auto]">
      <p className="text-sm text-foreground">{label}</p>
      <Link href={href} className="text-[11px] text-muted-foreground hover:text-primary">
        Inspect candidates →
      </Link>
      <Pill tone={count > 0 ? 'amber' : 'dim'}>{count}</Pill>
    </Row>
  );
}
