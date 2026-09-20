import { Settings } from 'lucide-react';
import Link from 'next/link';

import { resolveDataDir } from '@/app/dashboard/maintenance/data';
import { getUpdates } from '@/app/dashboard/update/update-service';
import { formatBytes } from '@/components/dashboard/support';
import {
  Page,
  PageHead,
  Panel,
  PanelHead,
  Pill,
  Row,
  Rows,
  StatTile,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * Settings — the v0 "workspace defaults" view, read from the runtime rather
 * than from a settings table: Rembric has none, and every default this page
 * shows is decided by an environment variable or by the service graph. Reading
 * them here is what makes the page honest; a form would be a control that cannot
 * write anything back.
 *
 * `REMBRIC_*` values are shown by name, never by secret value.
 */
export const dynamic = 'force-dynamic';

export default function SettingsPage() {
  const { repos, oauth, hasEmbeddingBacklog, sessionAbandonAfterMs } = getServices();
  const updates = getUpdates();

  const embeddingsBacklog = repos.vectors.adminBacklogCount();
  const entityBacklog = repos.entities.adminBacklogCount();
  const vectorRows = repos.vectors.count();
  const projects = repos.projects.count();
  const archivedProjects = repos.projects.adminCountArchived();
  const pageCount = readPragma('page_count');
  const pageSize = readPragma('page_size');

  return (
    <Page>
      <PageHead
        icon={Settings}
        eyebrow="Workspace defaults"
        title="Settings"
        description="Review the defaults that keep Rembric local and low-maintenance. Every value here is decided by the environment the server booted with."
      />

      <section className="mt-6 grid gap-3 sm:grid-cols-3">
        <StatTile label="Storage" value="SQLite" hint={resolveDataDir()} />
        <StatTile label="Retention" value="Local" hint="no external service required" />
        <StatTile
          label="Automation"
          value={updates.enabled ? 'On' : 'Check off'}
          tone={updates.enabled ? 'lime' : 'amber'}
          hint="daily release check"
        />
      </section>

      <section className="mt-6 grid gap-3 md:grid-cols-2">
        <article className="rounded-2xl border border-(--ink)/[6.5%] bg-(--surface-nested) p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] tracking-[.14em] text-(--accent-ink)/55 uppercase">
                Runtime defaults
              </p>
              <h2 className="mt-2 text-base font-medium">Local-first by construction</h2>
            </div>
            <span className="rounded-md border border-(--ink)/[6.5%] px-2 py-1 text-[10px] text-(--ink)/45">
              one process
            </span>
          </div>
          <p className="mt-3 max-w-lg text-xs leading-5 text-(--ink)/45">
            One Node process, one SQLite file, no external service and no API key required. The
            embedder runs in-process; the database is the only durable store.
          </p>
        </article>
        <article className="rounded-2xl border border-(--ink)/[6.5%] bg-(--surface-nested) p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="text-[10px] tracking-[.14em] text-(--accent-ink)/55 uppercase">
                Operator controls
              </p>
              <h2 className="mt-2 text-base font-medium">Configured at the server boundary</h2>
            </div>
            <span className="rounded-md border border-(--ink)/[6.5%] px-2 py-1 text-[10px] text-(--ink)/45">
              env
            </span>
          </div>
          <p className="mt-3 max-w-lg text-xs leading-5 text-(--ink)/45">
            Updates, tokens, retention and OAuth are set where the server boots, not stored in the
            database — so a change is one restart and always visible in the process environment.
          </p>
          <Link
            href="/dashboard/tokens"
            className="mt-5 inline-block text-[11px] text-(--accent-ink)/75 hover:text-(--accent-ink)"
          >
            Manage access tokens →
          </Link>
        </article>
      </section>

      <Panel className="mt-6">
        <PanelHead
          eyebrow="Defaults"
          title="What this deployment is running with"
          action="read-only"
        />
        <Rows>
          <SettingRow
            name="Memory storage"
            value={`Local SQLite · ${formatBytes(pageCount * pageSize)}`}
            state="Enabled"
          />
          <SettingRow
            name="Project scope"
            value={`${projects} project${projects === 1 ? '' : 's'} · ${archivedProjects} archived · selected in the sidebar`}
            state="Enabled"
          />
          <SettingRow
            name="Consolidation"
            value="Deterministic sweep, throttled on session start and from /mcp + /api"
            state="Enabled"
          />
          <SettingRow
            name="Session abandon window"
            value={`${Math.round(sessionAbandonAfterMs / 3_600_000)}h of inactivity`}
            state="Enabled"
          />
          <SettingRow
            name="Update check"
            value="REMBRIC_UPDATE_CHECK — at most once per day"
            state={updates.enabled ? 'Enabled' : 'Disabled'}
            tone={updates.enabled ? 'lime' : 'amber'}
          />
          <SettingRow
            name="OAuth access tokens"
            value="REMBRIC_PUBLIC_URL enables the authorization server"
            state={oauth === null ? 'Disabled' : 'Enabled'}
            tone={oauth === null ? 'dim' : 'lime'}
          />
          <SettingRow
            name="Embedding backlog"
            value={
              embeddingsBacklog === 0
                ? `${vectorRows} vectors stored, nothing queued`
                : `${embeddingsBacklog} memories waiting for an embedding`
            }
            state={hasEmbeddingBacklog() ? 'Draining' : 'Idle'}
            tone={hasEmbeddingBacklog() ? 'amber' : 'lime'}
          />
          <SettingRow
            name="Entity extraction backlog"
            value={
              entityBacklog === 0
                ? 'every memory has been scanned'
                : `${entityBacklog} memories waiting to be scanned`
            }
            state={entityBacklog === 0 ? 'Idle' : 'Draining'}
            tone={entityBacklog === 0 ? 'lime' : 'amber'}
          />
          <SettingRow
            name="Data directory"
            value={resolveDataDir()}
            state="REMBRIC_DATA_DIR"
            tone="dim"
          />
        </Rows>
      </Panel>
    </Page>
  );
}

function SettingRow({
  name,
  value,
  state,
  tone = 'lime',
}: {
  name: string;
  value: string;
  state: string;
  tone?: 'lime' | 'amber' | 'dim';
}) {
  return (
    <Row columns="md:grid-cols-[1fr_1.6fr_auto]">
      <p className="text-sm text-(--ink)/80">{name}</p>
      <p className="text-[11px] leading-5 text-(--ink)/45">{value}</p>
      <Pill tone={tone}>{state}</Pill>
    </Row>
  );
}

/** PRAGMA reads do not go through a repository: the value is a property of the file, not a row. */
function readPragma(name: 'page_count' | 'page_size'): number {
  const { db } = getServices();
  return db.raw.pragma(name, { simple: true }) as number;
}
