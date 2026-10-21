import { DomainError } from '@rembric/core';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { DetailCopy } from '@/components/dashboard/detail-copy';
import { DetailExpand } from '@/components/dashboard/detail-expand';
import type { DetailShareData } from '@/components/dashboard/detail-image';
import { DetailDisclosure, DetailLayout } from '@/components/dashboard/detail-layout';
import { DetailShare } from '@/components/dashboard/detail-share';
import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { RowTooltip } from '@/components/dashboard/row-tooltip';
import { durationBetween, truncate } from '@/components/dashboard/support';
import { Flash, StatusPill, Time } from '@/components/dashboard/ui';
import { Badge } from '@/components/ui/badge';
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
  const running = row.status === 'active' && !row.deletedAt && !row.endedAt;
  const duration =
    row.endedAt || running ? durationBetween(row.startedAt, row.endedAt, nowMs) : undefined;
  const captures = [
    ...memories.map((memory) => ({
      kind: 'memory' as const,
      id: memory.id,
      date: memory.createdAt,
      title: memory.title,
      href: `/dashboard/memories/${memory.id}`,
      type: memory.type,
      status: memory.status,
      tags: memory.tags ?? [],
      excerpt: '',
    })),
    ...prompts.map((prompt) => ({
      kind: 'prompt' as const,
      id: prompt.id,
      date: prompt.createdAt,
      title: prompt.title,
      href: `/dashboard/prompts/${prompt.id}`,
      type: 'prompt',
      status: prompt.deletedAt ? 'deleted' : null,
      tags: prompt.tags ?? [],
      excerpt: truncate(prompt.content, 160),
    })),
  ].sort(
    (a, b) =>
      a.date.getTime() - b.date.getTime() ||
      a.kind.localeCompare(b.kind) ||
      a.id.localeCompare(b.id),
  );
  const events = [
    { kind: 'started' as const, id: 'started', date: row.startedAt, title: 'Started' },
    ...captures,
    ...(row.endedAt
      ? [
          {
            kind: 'ended' as const,
            id: 'ended',
            date: row.endedAt,
            title: row.status === 'abandoned' ? 'Abandoned' : 'Ended',
          },
        ]
      : []),
    ...(row.deletedAt
      ? [{ kind: 'deleted' as const, id: 'deleted', date: row.deletedAt, title: 'Deleted' }]
      : []),
  ].sort((a, b) => {
    const rank = { started: 0, memory: 1, prompt: 2, ended: 3, deleted: 4 };
    return (
      a.date.getTime() - b.date.getTime() || rank[a.kind] - rank[b.kind] || a.id.localeCompare(b.id)
    );
  });
  const middleStart = captures.length > 5 ? events.indexOf(captures[2]!) : events.length;
  const middleEnd =
    captures.length > 5 ? events.indexOf(captures[captures.length - 3]!) : events.length;
  const middle = events.slice(middleStart, middleEnd);
  const shareData: DetailShareData = {
    kind: 'session',
    label: 'Session',
    title,
    date: row.startedAt,
    byline: `Run by ${row.agent}`,
    projectName: row.projectSlug ?? '—',
    content: {
      text: summary || row.description || '',
      mode: summary && !row.summaryFinal ? 'literal' : 'markdown',
      label: 'Full summary',
    },
    duration,
    stats: [
      { label: 'memories', value: String(memories.length) },
      { label: 'prompts', value: String(prompts.length) },
      { label: 'duration', value: duration ?? '—' },
    ],
  };

  const markdown = [
    `# ${title}`,
    '',
    row.description ? `${row.description}\n` : '',
    summary && row.summaryFinal ? `## Summary\n\n${summary}` : '',
    `## Run\n\nAgent \`${row.agent}\` · started ${row.startedAt.toISOString()} · status ${row.status}.`,
    prompts.length > 0
      ? `## Prompts captured\n\n${prompts.map((p) => `- ${p.content.slice(0, 120)}`).join('\n')}`
      : '',
  ]
    .filter((part) => part !== '')
    .join('\n');

  const prose = [
    row.description && row.description !== title ? row.description : '',
    summary && row.summaryFinal ? summary : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  const historyEvent = (event: (typeof events)[number]) => {
    const capture = event.kind === 'memory' || event.kind === 'prompt';
    const outside =
      capture && (event.date < row.startedAt || (row.endedAt && event.date > row.endedAt));
    return (
      <li
        key={`${event.kind}:${event.id}`}
        className="relative min-w-0 border-l border-border pb-3 pl-5 text-sm"
      >
        <RowTooltip
          clickToOpen
          tooltip={
            <div className="min-w-0 space-y-1 wrap-anywhere">
              <p className="font-medium">{event.title}</p>
              <p className="text-muted-foreground">
                {capture
                  ? event.kind === 'memory'
                    ? `Memory · ${event.type}`
                    : 'Prompt'
                  : `Session · ${row.agent}`}
                {capture && event.status ? ` · ${event.status}` : ''}
              </p>
              {event.kind === 'started' ? <p>token {row.tokenName ?? '—'}</p> : null}
              {capture && event.excerpt ? <p>{event.excerpt}</p> : null}
              {capture && event.tags.length > 0 ? (
                <p>{event.tags.map((tag) => `#${tag}`).join(' ')}</p>
              ) : null}
              {outside ? <p className="text-muted-foreground">Outside recorded run</p> : null}
            </div>
          }
        >
          <button
            type="button"
            aria-label={`Details: ${event.title}`}
            className="absolute -top-0.5 -left-3 grid size-6 place-items-center rounded-md outline-offset-2 focus-visible:outline-2 focus-visible:outline-primary"
          >
            <span
              aria-hidden="true"
              className={`size-2 rounded-full border ${!capture ? 'border-foreground bg-background' : event.kind === 'memory' && event.status === 'active' ? 'border-primary bg-primary' : event.status === 'superseded' ? 'border-warn bg-warn' : 'border-muted-foreground bg-muted-foreground'}`}
            />
          </button>
        </RowTooltip>
        {capture ? (
          <Link href={event.href} className="block truncate leading-5 hover:text-primary">
            {event.title}
          </Link>
        ) : (
          <span className="block truncate leading-5">{event.title}</span>
        )}
        <Time
          value={event.date}
          className="block truncate font-mono text-xs leading-4 text-muted-foreground"
        />
      </li>
    );
  };
  const lifecycleActions = (
    <>
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
    </>
  );

  return (
    <DetailLayout
      presentation="ficha"
      title={title}
      backHref="/dashboard/sessions"
      backLabel="Sessions"
      contentLabel="Session content"
      badges={
        <>
          <StatusPill status={row.status} />
          <Badge>{row.agent}</Badge>
          <span className="ficha-byline">
            in <b>{row.projectSlug ?? '—'}</b>, started <Time value={row.startedAt} />
          </span>
        </>
      }
      primaryActions={
        <>
          <DetailCopy text={markdown} />
          <DetailShare data={shareData} />
          {lifecycleActions}
        </>
      }
      actionsLabel="Session actions"
      notices={
        row.deletedAt ? (
          <Flash tone="danger" label="SOFT-DELETED">
            Removed from the active list on <Time value={row.deletedAt} />. Memories that reference
            it keep their <code className="font-mono">session_id</code> pointer intact.
          </Flash>
        ) : null
      }
      metadata={
        <DetailDisclosure presentation="ficha" title="Properties">
          <dl>
            <dt>ID</dt>
            <dd>{row.id}</dd>
            <dt>Status</dt>
            <dd>
              <StatusPill status={row.status} />
            </dd>
            <dt>Agent</dt>
            <dd>{row.agent}</dd>
            <dt>Project</dt>
            <dd>{row.projectSlug ?? '—'}</dd>
            <dt>Token</dt>
            <dd>
              {row.tokenName ? `${row.tokenName}${row.tokenRevokedAt ? ' (revoked)' : ''}` : '—'}
            </dd>
            <dt>Started</dt>
            <dd>
              <Time value={row.startedAt} />
            </dd>
            <dt>Ended</dt>
            <dd>
              <Time value={row.endedAt} />
            </dd>
            <dt>{running ? 'Running for' : 'Duration'}</dt>
            <dd>{duration ?? '—'}</dd>
            <dt>Memories</dt>
            <dd>{memories.length}</dd>
            <dt>Prompts</dt>
            <dd>{prompts.length}</dd>
          </dl>
        </DetailDisclosure>
      }
      secondary={
        <>
          <section className="ficha-section" aria-label="Stats">
            <h2>Stats</h2>
            <dl className="grid grid-cols-3 gap-2">
              {shareData.stats?.map((stat) => (
                <div
                  key={stat.label}
                  className="min-w-0 rounded-[16px] border border-border bg-card p-3 text-xs text-muted-foreground first:[&_dd]:text-primary"
                >
                  <dt className="mb-1">{stat.label}</dt>
                  <dd className="text-xl font-semibold tracking-tight text-foreground wrap-anywhere">
                    {stat.value}
                  </dd>
                </div>
              ))}
            </dl>
          </section>
          <section className="ficha-section" aria-label="History">
            <h2>
              History <span>{`${memories.length} memories · ${prompts.length} prompts`}</span>
            </h2>
            <ol className="m-0 min-w-0 list-none p-0">
              {events.slice(0, middleStart).map(historyEvent)}
              {captures.length > 5 ? (
                <li className="relative before:absolute before:inset-y-0 before:left-0 before:w-px before:bg-border [&>button]:mb-3 [&>button]:ml-5">
                  <DetailExpand
                    label={`Show ${captures.length - 5} more events`}
                    collapsedContent={
                      <ol>
                        {middle
                          .filter((event) => event.kind !== 'memory' && event.kind !== 'prompt')
                          .map(historyEvent)}
                      </ol>
                    }
                  >
                    <ol>{middle.map(historyEvent)}</ol>
                  </DetailExpand>
                </li>
              ) : null}
              {events.slice(middleEnd).map(historyEvent)}
            </ol>
            {!row.endedAt ? (
              <p className="mt-2 text-xs text-muted-foreground">
                {row.status === 'active' && !row.deletedAt
                  ? 'Still running'
                  : `${row.status} · End time not recorded.`}
              </p>
            ) : null}
          </section>
        </>
      }
    >
      <MarkdownPanel
        presentation="reading"
        hideToolbar
        title="What happened in this run"
        markdown={prose || (summary ? '' : 'No summary has been recorded for this session.')}
      />
      {summary && !row.summaryFinal ? (
        <>
          <span className="mb-3 inline-flex rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
            RAW
          </span>
          <pre
            tabIndex={0}
            aria-label="Raw summary"
            className="mb-5 overflow-x-auto rounded-[16px] border border-border bg-card p-4 font-mono text-base leading-7 whitespace-pre-wrap text-foreground wrap-anywhere"
          >
            {summary}
          </pre>
        </>
      ) : null}
      <footer className="ficha-footer">
        <span>
          Started <Time value={row.startedAt} />
        </span>
        {row.endedAt ? (
          <span>
            Ended <Time value={row.endedAt} />
          </span>
        ) : null}
      </footer>
    </DetailLayout>
  );
}
