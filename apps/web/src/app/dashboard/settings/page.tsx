import Link from 'next/link';

import { resolveDataDir } from '@/app/dashboard/maintenance/data';
import { getUpdates } from '@/app/dashboard/update/update-service';
import { formatBytes } from '@/components/dashboard/support';
import {
  DataBody,
  DataHead,
  DataTable,
  DataTd,
  DataTh,
  DataTr,
  Page,
  Pill,
  SectionBar,
  StatCard,
  StatGrid,
  ViewHead,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

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
      <ViewHead
        num="10"
        title="Rembric Settings."
        hl="Rembric"
        meta={[{ k: 'READ ONLY', v: 'ENV' }]}
      />

      <StatGrid className="mt-6 sm:grid-cols-3 xl:grid-cols-3">
        <StatCard k="STORAGE" v="SQLite" tone="lime" sub={<span>{resolveDataDir()}</span>} />
        <StatCard k="RETENTION" v="Local" sub={<span>NO EXTERNAL SERVICE REQUIRED</span>} />
        <StatCard
          k="AUTOMATION"
          v={updates.enabled ? 'On' : 'Check off'}
          tone={updates.enabled ? 'lime' : 'amber'}
          sub={<span>DAILY RELEASE CHECK</span>}
        />
      </StatGrid>

      <div className="mt-6 grid gap-3 md:grid-cols-2">
        <div className="border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
                RUNTIME DEFAULTS
              </p>
              <h2 className="mt-2 text-base font-medium">Local-first by construction</h2>
            </div>
            <span className="border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-muted-foreground">
              one process
            </span>
          </div>
          <p className="mt-3 max-w-lg text-xs leading-5 text-muted-foreground">
            One Node process, one SQLite file, no external service and no API key required. The
            embedder runs in-process; the database is the only durable store.
          </p>
        </div>
        <div className="border border-border bg-card p-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <p className="font-mono text-[11px] uppercase tracking-[.14em] text-primary">
                OPERATOR CONTROLS
              </p>
              <h2 className="mt-2 text-base font-medium">Configured at the server boundary</h2>
            </div>
            <span className="border border-border px-2 py-1 font-mono text-[10px] uppercase tracking-[.1em] text-muted-foreground">
              env
            </span>
          </div>
          <p className="mt-3 max-w-lg text-xs leading-5 text-muted-foreground">
            Updates, tokens, retention and OAuth are set where the server boots, not stored in the
            database — so a change is one restart and always visible in the process environment.
          </p>
          <Link
            href="/dashboard/tokens"
            className="mt-5 inline-block font-mono text-[11px] uppercase tracking-[.12em] text-primary hover:underline"
          >
            MANAGE ACCESS TOKENS →
          </Link>
        </div>
      </div>

      <div className="mt-8">
        <SectionBar name="Defaults" meta="WHAT THIS DEPLOYMENT IS RUNNING WITH" />
      </div>
      <DataTable>
        <DataHead>
          <DataTh>setting</DataTh>
          <DataTh>value</DataTh>
          <DataTh>state</DataTh>
        </DataHead>
        <DataBody>
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
        </DataBody>
      </DataTable>
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
    <DataTr>
      <DataTd>{name}</DataTd>
      <DataTd className="max-w-[520px] whitespace-normal text-muted-foreground">{value}</DataTd>
      <DataTd>
        <Pill tone={tone}>{state}</Pill>
      </DataTd>
    </DataTr>
  );
}

function readPragma(name: 'page_count' | 'page_size'): number {
  const { db } = getServices();
  return db.raw.pragma(name, { simple: true }) as number;
}
