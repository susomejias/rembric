import { ArrowLeft, Database, Radio } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { durationBetween, shortId } from '@/components/dashboard/support';
import {
  Fact,
  Notice,
  Page,
  Panel,
  PanelHead,
  Pill,
  Row,
  Rows,
  Time,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The session detail, in the v0 composition: the title block, the facts grid,
 * the session summary as rendered markdown with a copy control, the memories and
 * prompts the run produced, and the metadata aside.
 *
 * The reads are the retired `session-detail.tsx` loader's own — the same
 * `adminGetDetail`, the same per-session memory and prompt lists.
 */
export const dynamic = 'force-dynamic';

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { repos } = getServices();

  const row = repos.agentSessions.adminGetDetail(id);
  if (!row) notFound();

  const title = row.title ?? row.description ?? row.projectSlug ?? row.id;
  const memories = repos.memory.adminListBySession(id);
  const prompts = repos.prompts.adminListBySession(id);
  const nowMs = Date.now();
  const summary = row.summary ?? row.summaryFinal;

  const markdown = [
    `# ${title}`,
    '',
    row.description ? `${row.description}\n` : '',
    summary ? `## Summary\n\n${summary}` : '',
    `## Run\n\nAgent \`${row.agent}\` · started ${row.startedAt.toISOString()} · status ${row.status}.`,
    memories.length > 0
      ? `## Memories written\n\n${memories.map((m) => `- **${m.title}** — ${m.type}`).join('\n')}`
      : '',
    prompts.length > 0
      ? `## Prompts captured\n\n${prompts.map((p) => `- ${p.content.slice(0, 120)}`).join('\n')}`
      : '',
  ]
    .filter((part) => part !== '')
    .join('\n');

  return (
    <Page className="max-w-[1100px]">
      <Link
        href="/dashboard/sessions"
        className="mb-6 flex items-center gap-2 text-xs text-(--ink)/40 transition-colors hover:text-(--accent-ink)"
      >
        <ArrowLeft className="size-3.5" />
        Back to sessions
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2 text-[10px] tracking-[.15em] text-(--accent-ink-strong)/70 uppercase">
            <Radio className="size-3" />
            Session · {row.agent}
          </div>
          <h1 className="mt-3 text-2xl font-medium tracking-[-.06em] md:text-4xl">{title}</h1>
          <p className="mt-3 text-sm leading-6 text-(--ink)/45">
            {row.description ?? 'No description was reported for this run.'}
          </p>
        </div>
        <Pill tone={row.status === 'active' ? 'lime' : 'dim'}>{row.status}</Pill>
      </div>

      {row.deletedAt ? (
        <Notice tone="danger" badge="Soft-deleted" className="mt-6">
          Removed from the active list on <Time value={row.deletedAt} />. Memories that reference it
          keep their <code className="font-mono">session_id</code> pointer intact.
        </Notice>
      ) : null}

      <section className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Agent" value={row.agent} />
        <Fact label="Project" value={row.projectSlug ?? 'global'} />
        <Fact
          label={row.endedAt ? 'Duration' : 'Running for'}
          value={durationBetween(row.startedAt, row.endedAt, nowMs)}
        />
        <Fact
          label="Token"
          value={row.tokenName ? `${row.tokenName}${row.tokenRevokedAt ? ' (revoked)' : ''}` : '—'}
        />
      </section>

      <MarkdownPanel
        eyebrow="Session summary"
        title="What happened in this run"
        markdown={markdown}
        copyLabel="Copy markdown"
      />

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.25fr_.75fr]">
        <Panel>
          <PanelHead
            eyebrow="Produced context"
            title="Memories written during this session"
            action={`${memories.length} row${memories.length === 1 ? '' : 's'}`}
          />
          {memories.length === 0 ? (
            <p className="px-5 py-5 text-sm text-(--ink)/45 md:px-6">
              This run wrote no memory. Prompts and session activity are still recorded.
            </p>
          ) : (
            <Rows>
              {memories.map((memory) => (
                <Row key={memory.id} columns="md:grid-cols-[minmax(220px,1.4fr)_1fr_auto]">
                  <div className="flex items-start gap-3">
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-(--accent-ink)/80" />
                    <Link
                      href={`/dashboard/memories/${memory.id}`}
                      className="text-sm text-(--ink)/80 hover:text-(--accent-ink)"
                    >
                      {memory.title}
                    </Link>
                  </div>
                  <span className="text-[11px] text-(--ink)/45">{memory.type}</span>
                  <Pill tone={memory.status === 'active' ? 'lime' : 'dim'}>{memory.status}</Pill>
                </Row>
              ))}
            </Rows>
          )}
        </Panel>

        <Panel>
          <PanelHead
            eyebrow="Prompts"
            title="Captured in this session"
            action={`${prompts.length} row${prompts.length === 1 ? '' : 's'}`}
          />
          {prompts.length === 0 ? (
            <p className="px-5 py-5 text-sm text-(--ink)/45 md:px-6">No prompt was captured.</p>
          ) : (
            <Rows>
              {prompts.map((prompt) => (
                <div key={prompt.id} className="px-5 py-4 md:px-6">
                  <p className="text-xs leading-5 text-(--ink)/65">
                    {prompt.content.slice(0, 220)}
                  </p>
                  <p className="mt-2 text-[10px] text-(--ink)/38">
                    <Time value={prompt.createdAt} /> · {prompt.deletedAt ? 'deleted' : 'active'}
                  </p>
                </div>
              ))}
            </Rows>
          )}
        </Panel>
      </div>

      <aside className="mt-6 rounded-2xl border border-(--ink)/[7.5%] bg-(--surface-panel) p-5">
        <p className="flex items-center gap-2 text-[10px] tracking-[.14em] text-(--ink)/38 uppercase">
          <Database className="size-3" />
          Metadata
        </p>
        <div className="mt-5 grid gap-4 text-xs sm:grid-cols-2">
          <Metadata
            label="Session id"
            value={<code className="font-mono">{shortId(row.id)}</code>}
          />
          <Metadata label="Started" value={<Time value={row.startedAt} />} />
          <Metadata label="Ended" value={<Time value={row.endedAt} />} />
          <Metadata label="Local, append-only storage" value="no row was deleted" />
        </div>
      </aside>
    </Page>
  );
}

function Metadata({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="text-(--ink)/40">{label}</span>
      <span className="text-(--ink)/75">{value}</span>
    </div>
  );
}
