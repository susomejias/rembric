import { DomainError } from '@rembric/core';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { CsrfField } from '@/components/dashboard/csrf-field';
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
  Pill,
  SectionBar,
  StatusPill,
  TableEmpty,
  Tag,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';

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

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { repos } = getServices();

  const row = repos.agentSessions.adminGetDetail(id);
  if (!row) notFound();

  const title = row.title ?? row.description ?? row.projectSlug ?? row.id;
  const memories = repos.memory.adminListBySession(id);
  const prompts = repos.prompts.adminListBySession(id);
  const nowMs = Date.now();
  const summary = row.summary;

  const markdown = [
    `# ${title}`,
    '',
    row.description ? `${row.description}\n` : '',
    summary && row.summaryFinal ? `## Summary\n\n${summary}` : '',
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
        titleVisible
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

      <div className="mb-5 flex flex-wrap items-center gap-2">
        {row.deletedAt ? (
          <ActionForm action={undeleteSession}>
            <CsrfField form={UNDELETE_FORM} />
            <input type="hidden" name="id" value={row.id} />
            <Button type="submit">Undelete</Button>
          </ActionForm>
        ) : (
          <>
            {row.status === 'active' ? (
              <ActionForm action={abandonSession}>
                <CsrfField form={ABANDON_FORM} />
                <input type="hidden" name="id" value={row.id} />
                <ConfirmSubmit
                  tone="warn"
                  title="Mark this session as abandoned?"
                  description={`Its ${memories.length} memories stay queryable and the row stays visible in the list. This transition is not reversible from the dashboard.`}
                  confirmLabel="ABANDON SESSION"
                >
                  <Button type="button" variant="outline" size="sm">
                    Abandon
                  </Button>
                </ConfirmSubmit>
              </ActionForm>
            ) : null}
            <ActionForm action={deleteSession}>
              <CsrfField form={DELETE_FORM} />
              <input type="hidden" name="id" value={row.id} />
              <ConfirmSubmit
                tone="danger"
                title="Soft-delete this session?"
                description="Its memories stay queryable but the session is hidden from the list. You can restore it from the list with ?include_deleted=1."
                confirmLabel="DELETE SESSION"
              >
                <Button type="button" variant="destructive" size="sm">
                  Delete
                </Button>
              </ConfirmSubmit>
            </ActionForm>
          </>
        )}
      </div>

      {summary && !row.summaryFinal ? (
        <>
          <SectionBar name="Summary" more={<Pill tone="dim">RAW</Pill>} />
          <pre className="mb-5 overflow-x-auto border border-border bg-muted p-3 font-mono text-xs leading-5">
            {summary}
          </pre>
        </>
      ) : null}

      <MarkdownPanel
        eyebrow="Session log"
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
