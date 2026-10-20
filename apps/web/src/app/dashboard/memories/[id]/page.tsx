import {
  annotationKindFor,
  compareAnnotations,
  deriveReviewState,
  DomainError,
} from '@rembric/core';
import { projectScope } from '@rembric/db';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import { ActionForm, type ActionState } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { CsrfField } from '@/components/dashboard/csrf-field';
import { DetailDisclosure, DetailLayout } from '@/components/dashboard/detail-layout';
import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { shortId, singleParam, truncate } from '@/components/dashboard/support';
import { MetaRow, ReviewPill, StatusPill, Time } from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';

export const dynamic = 'force-dynamic';

const ARCHIVE_FORM = 'memory.archive';
const CONFIRM_FORM = 'memory.confirm';

const NO_PROJECT_MESSAGE =
  'This memory predates the default project and has no project to act in. An older image wrote it; it cannot be archived or confirmed from the dashboard.';

async function archiveMemory(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, ARCHIVE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const id = readField(formData, 'id');
  const row = guard.services.memory.unsafeGetById(id);
  if (!row) redirect('/dashboard/memories');
  if (!row.projectId) return { error: NO_PROJECT_MESSAGE };

  try {
    guard.services.memory.archive(id, projectScope(row.projectId));
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  redirect(`/dashboard/memories/${id}`);
}

async function confirmMemory(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, CONFIRM_FORM);
  if (!guard.ok) return guardFailure(guard);

  const id = readField(formData, 'id');
  const row = guard.services.memory.unsafeGetById(id);
  if (!row) redirect('/dashboard/memories');
  if (!row.projectId) return { error: NO_PROJECT_MESSAGE };

  try {
    guard.services.memory.confirm(id, projectScope(row.projectId), {
      source: { agent: 'dashboard-operator' },
    });
  } catch (err) {
    if (err instanceof DomainError) return { error: err.message };
    throw err;
  }
  redirect(`/dashboard/memories/${id}?confirmed=1`);
}

function readField(form: FormData, name: string): string {
  const value = form.get(name);
  return (typeof value === 'string' ? value : '').trim();
}

export default async function MemoryDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ confirmed?: string | string[] }>;
}) {
  const { id } = await params;
  const justConfirmed = singleParam((await searchParams).confirmed) !== '';
  const { memory: memoryService, repos } = getServices();

  const row = memoryService.unsafeGetById(id);
  if (!row) notFound();

  const project = row.projectId ? repos.projects.adminFindById(row.projectId) : undefined;
  const predecessors = repos.memory
    .adminGetByIds(row.replaces)
    .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  const confirmCount = repos.memory.adminCountConfirmations(row.id);
  const reviewTimestamps = repos.memory.reviewTimestampsByIds([row.id]).get(row.id);
  const { reviewState, reviewAfter } = deriveReviewState(
    {
      type: row.type,
      createdAt: row.createdAt,
      status: row.status,
      lastConfirmedAt: reviewTimestamps?.affirmedAt ?? null,
      lastRefutedAt: reviewTimestamps?.refutedAt ?? null,
    },
    new Date(),
  );
  const successorId =
    row.status === 'superseded' ? repos.memory.findSuccessorId(row.id) : undefined;
  const successor = successorId ? repos.memory.adminGetByIds([successorId]).at(0) : undefined;

  const touching = repos.relations
    .adminListTouching(row.id)
    .map((relation) => ({ relation, kind: annotationKindFor(relation, row.id) }))
    .sort((a, b) =>
      compareAnnotations({ ...a.relation, kind: a.kind }, { ...b.relation, kind: b.kind }),
    );

  const projectLabel = project?.slug ?? '—';
  const markdown = `# ${row.title}\n\n${row.content}`;

  const confirmForm = (
    <ActionForm action={confirmMemory}>
      <CsrfField form={CONFIRM_FORM} />
      <input type="hidden" name="id" value={row.id} />
      <Button type="submit" size="sm">
        CONFIRM
      </Button>
    </ActionForm>
  );

  const archiveForm = (
    <ActionForm action={archiveMemory}>
      <CsrfField form={ARCHIVE_FORM} />
      <input type="hidden" name="id" value={row.id} />
      <ConfirmSubmit
        tone="warn"
        title="Archive this memory?"
        description="It will stop appearing in active recall. You can re-save the topic later to bring it back."
        confirmLabel="ARCHIVE"
      >
        <Button type="button" variant="outline" size="sm">
          ARCHIVE
        </Button>
      </ConfirmSubmit>
    </ActionForm>
  );

  return (
    <DetailLayout
      title={row.title}
      backHref="/dashboard/memories"
      backLabel="BACK TO MEMORIES"
      contentLabel="Memory content"
      badges={
        <>
          <StatusPill status={row.status} />
          {reviewState === 'needs_review' ? <ReviewPill /> : null}
          <span className="text-sm text-muted-foreground">
            {row.type} · {projectLabel}
          </span>
        </>
      }
      actionsLabel="Memory actions"
      actions={
        <>
          {row.status === 'active' ? archiveForm : null}
          {reviewState !== 'needs_review' ? confirmForm : null}
        </>
      }
      notices={
        <>
          {justConfirmed ? (
            <p role="status" className="mb-4 text-sm text-primary">
              CONFIRMED · Review affirmed just now.
            </p>
          ) : null}
          {reviewState === 'needs_review' ? (
            <div className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-warn/30 bg-card px-4 py-3 text-sm">
              <p className="flex-1 text-warn">
                NEEDS REVIEW · Not re-affirmed since <Time value={reviewAfter} />.
              </p>
              {confirmForm}
            </div>
          ) : null}
          {successor ? (
            <p className="mb-4 rounded-xl border border-warn/30 bg-card px-4 py-3 text-sm">
              Superseded by{' '}
              <Link
                href={`/dashboard/memories/${successor.id}`}
                className="text-primary hover:underline"
              >
                {successor.title} · {shortId(successor.id)}
              </Link>
            </p>
          ) : null}
        </>
      }
      metadata={
        <>
          <DetailDisclosure title="Details and tags" inspector>
            <dl className="detail-fields">
              <MetaRow k="ID" v={row.id} mono />
              <MetaRow k="Status" v={<StatusPill status={row.status} />} />
              <MetaRow k="Project" v={projectLabel} />
              <MetaRow k="Type" v={row.type} />
              <MetaRow k="Confirms" v={confirmCount} />
              <MetaRow k="Created" v={<Time value={row.createdAt} />} mono />
              <MetaRow k="Last seen" v={<Time value={row.lastSeenAt} />} mono />
              <MetaRow k="Scope" v={row.scope} mono />
              <MetaRow k="Topic key" v={row.topicKey ?? '—'} mono />
              <MetaRow k="Source" v={row.source?.agent ?? '—'} mono />
            </dl>
            <section aria-label="Tags" className="pt-4">
              <h2 className="mb-2 font-mono text-xs text-muted-foreground">Tags</h2>
              <div className="flex flex-wrap gap-2">
                {row.tags.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  row.tags.map((tag) => (
                    <span
                      key={tag}
                      className="rounded-full border border-border px-2.5 py-1 font-mono text-xs text-muted-foreground"
                    >
                      {tag}
                    </span>
                  ))
                )}
              </div>
            </section>
          </DetailDisclosure>
        </>
      }
      secondary={
        <>
          {reviewState !== null && reviewAfter !== null ? (
            <DetailDisclosure title="Review" inspector>
              <dl className="detail-fields">
                <MetaRow
                  k="Review"
                  v={reviewState === 'needs_review' ? <ReviewPill /> : 'fresh'}
                  tone={reviewState === 'needs_review' ? 'amber' : 'lime'}
                />
                <MetaRow k="Review after" v={<Time value={reviewAfter} />} mono />
                <MetaRow k="Confirmations" v={confirmCount} />
              </dl>
              <p className="mt-3 text-xs text-muted-foreground">
                Re-affirm with <code>memory.confirm</code> to refresh review.
              </p>
            </DetailDisclosure>
          ) : null}
          <DetailDisclosure title={`PREDECESSORS (${predecessors.length})`}>
            <h2 className="mb-2 font-mono text-xs text-muted-foreground">REPLACES</h2>
            <div className="mb-4 flex flex-wrap gap-2 font-mono text-xs">
              {row.replaces.length === 0 ? (
                <span className="text-muted-foreground">—</span>
              ) : (
                row.replaces.map((rid) => (
                  <Link
                    key={rid}
                    href={`/dashboard/memories/${rid}`}
                    className="text-primary hover:underline"
                  >
                    {rid}
                  </Link>
                ))
              )}
            </div>
            {predecessors.length === 0 ? (
              <p className="text-xs text-muted-foreground">NO PREDECESSORS</p>
            ) : (
              <ul className="space-y-4">
                {predecessors.map((predecessor) => (
                  <li key={predecessor.id} className="space-y-2 border-t border-border pt-3">
                    <Link
                      href={`/dashboard/memories/${predecessor.id}`}
                      className="text-sm font-medium hover:text-primary"
                    >
                      {predecessor.title}
                    </Link>
                    <div>
                      <StatusPill status={predecessor.status} />
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {truncate(predecessor.content, 160)}
                    </p>
                    <p className="font-mono text-xs text-muted-foreground">
                      <Time value={predecessor.createdAt} />
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </DetailDisclosure>
          <DetailDisclosure title={`JUDGMENTS (${touching.length})`}>
            {touching.length === 0 ? (
              <p className="text-xs text-muted-foreground">NO JUDGMENTS TOUCH THIS MEMORY</p>
            ) : (
              <ul className="space-y-4">
                {touching.map(({ relation, kind }) => {
                  const isSource = relation.sourceId === row.id;
                  const counterpartId = isSource ? relation.targetId : relation.sourceId;
                  const counterpartTitle = isSource ? relation.targetTitle : relation.sourceTitle;
                  return (
                    <li key={relation.id} className="space-y-2 border-t border-border pt-3">
                      <Link
                        href={`/dashboard/memories/${counterpartId}`}
                        className="text-sm font-medium hover:text-primary"
                      >
                        {counterpartTitle}
                      </Link>
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-mono text-xs text-muted-foreground">{kind}</span>
                        <StatusPill status={relation.status} />
                      </div>
                      <Link
                        href={`/dashboard/judgments/${relation.id}`}
                        className="block font-mono text-xs text-muted-foreground hover:text-primary"
                      >
                        <Time value={relation.judgedAt ?? relation.createdAt} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </DetailDisclosure>
        </>
      }
    >
      <MarkdownPanel
        presentation="reading"
        hideTitle
        eyebrow="Memory content"
        title="Durable context"
        markdown={row.content}
        copyMarkdown={markdown}
        copyLabel="Copy"
      />
    </DetailLayout>
  );
}
