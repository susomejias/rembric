import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { durationBetween, shortId, truncate } from '@/components/dashboard/support';
import {
  BackLink,
  DataBody,
  DataHead,
  DataTable,
  DataTd,
  DataTh,
  DataTr,
  Flash,
  Kv,
  KvGrid,
  Page,
  SectionBar,
  StatusPill,
  TableEmpty,
  Tag,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';

/**
 * The session detail, in the production dashboard's composition: the head with
 * the status meta, the key/value grid, the session summary as rendered markdown
 * with a copy control, and the memories and prompts the run produced as tables.
 *
 * The reads are the retired `sessions.ts` `/:id` handler's own — the same
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
    <Page>
      <ViewHead
        num="03"
        title={title}
        meta={[
          { k: 'ID', v: shortId(row.id) },
          { k: 'STATUS', v: row.status.toUpperCase() },
          { k: 'AGENT', v: row.agent },
        ]}
      />

      <div className="mt-4 mb-5">
        <BackLink href="/dashboard/sessions" label="BACK TO SESSIONS" />
      </div>

      {row.deletedAt ? (
        <Flash tone="danger" label="SOFT-DELETED">
          Removed from the active list on <Time value={row.deletedAt} />. Memories that reference it
          keep their <code className="font-mono">session_id</code> pointer intact.
        </Flash>
      ) : null}

      <KvGrid>
        <Kv k="Status" v={<StatusPill status={row.status} />} />
        <Kv k="Agent" v={row.agent} />
        <Kv k="Project" v={row.projectSlug ?? '—'} />
        <Kv
          k="Token"
          v={row.tokenName ? `${row.tokenName}${row.tokenRevokedAt ? ' (revoked)' : ''}` : '—'}
          mono
        />
        <Kv k="Started" v={<Time value={row.startedAt} />} mono />
        <Kv k="Ended" v={<Time value={row.endedAt} />} mono />
        <Kv
          k={row.endedAt ? 'Duration' : 'Running for'}
          v={durationBetween(row.startedAt, row.endedAt, nowMs)}
          mono
        />
        <Kv k="Memories" v={memories.length} />
        <Kv k="Prompts" v={prompts.length} />
      </KvGrid>

      <MarkdownPanel
        eyebrow="Session summary"
        title="What happened in this run"
        markdown={markdown}
        copyLabel="Copy markdown"
      />

      <SectionBar name={`MEMORIES (${memories.length})`} />
      {memories.length === 0 ? (
        <TableEmpty>NO MEMORY WAS WRITTEN DURING THIS RUN</TableEmpty>
      ) : (
        <DataTable>
          <DataHead>
            <DataTh>type</DataTh>
            <DataTh>title</DataTh>
            <DataTh>status</DataTh>
            <DataTh>created</DataTh>
          </DataHead>
          <DataBody>
            {memories.map((memory) => (
              <DataTr key={memory.id}>
                <DataTd>{memory.type}</DataTd>
                <DataTd className="max-w-[420px] truncate">
                  <Link
                    href={`/dashboard/memories/${memory.id}`}
                    className="transition-colors hover:text-primary"
                  >
                    {memory.title}
                  </Link>
                </DataTd>
                <DataTd>
                  <StatusPill status={memory.status} />
                </DataTd>
                <DataTd className="font-mono text-xs text-muted-foreground">
                  <Time value={memory.createdAt} />
                </DataTd>
              </DataTr>
            ))}
          </DataBody>
        </DataTable>
      )}

      <div className="mt-8">
        <SectionBar name={`PROMPTS (${prompts.length})`} />
      </div>
      {prompts.length === 0 ? (
        <TableEmpty>NO PROMPT WAS CAPTURED</TableEmpty>
      ) : (
        <DataTable>
          <DataHead>
            <DataTh>title</DataTh>
            <DataTh>content</DataTh>
            <DataTh>tags</DataTh>
            <DataTh>created</DataTh>
          </DataHead>
          <DataBody>
            {prompts.map((prompt) => (
              <DataTr key={prompt.id} className={prompt.deletedAt ? 'opacity-60' : undefined}>
                <DataTd>{truncate(prompt.title, 60)}</DataTd>
                <DataTd className="max-w-[420px] truncate text-muted-foreground">
                  {truncate(prompt.content, 160)}
                </DataTd>
                <DataTd>
                  <div className="flex flex-wrap gap-1">
                    {(prompt.tags ?? []).length === 0 ? (
                      <span className="text-muted-foreground">—</span>
                    ) : (
                      (prompt.tags ?? []).map((tag) => <Tag key={tag}>{tag}</Tag>)
                    )}
                  </div>
                </DataTd>
                <DataTd className="font-mono text-xs text-muted-foreground">
                  <Time value={prompt.createdAt} />
                </DataTd>
              </DataTr>
            ))}
          </DataBody>
        </DataTable>
      )}
    </Page>
  );
}
