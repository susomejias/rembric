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
import { DetailCopy } from '@/components/dashboard/detail-copy';
import { DetailExpand } from '@/components/dashboard/detail-expand';
import { DetailDisclosure, DetailLayout } from '@/components/dashboard/detail-layout';
import { DetailShare } from '@/components/dashboard/detail-share';
import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { shortId, singleParam, truncate } from '@/components/dashboard/support';
import { StatusPill, Time } from '@/components/dashboard/ui';
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
  const visited = new Set([row.id]);
  const unresolved = new Set<string>();
  const predecessors: (typeof row)[] = [];
  let frontier = row.replaces;
  while (frontier.length > 0) {
    const ids = [...new Set(frontier)].filter((rid) => !visited.has(rid));
    if (ids.length === 0) break;
    ids.forEach((rid) => visited.add(rid));
    const found = repos.memory.adminGetByIds(ids);
    const foundIds = new Set(found.map((candidate) => candidate.id));
    ids.filter((rid) => !foundIds.has(rid)).forEach((rid) => unresolved.add(rid));
    const inScope = found.filter(
      (candidate) => candidate.projectId === row.projectId && candidate.scope === row.scope,
    );
    predecessors.push(...inScope);
    frontier = inScope.flatMap((candidate) => candidate.replaces);
  }
  predecessors.sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id),
  );
  const confirmCount = repos.memory.adminCountConfirmations(row.id);
  const reviewTimestamps = repos.memory.reviewTimestampsByIds([row.id]).get(row.id);
  const now = new Date();
  const { reviewState, reviewAfter, reviewBaseline } = deriveReviewState(
    {
      type: row.type,
      createdAt: row.createdAt,
      status: row.status,
      lastConfirmedAt: reviewTimestamps?.affirmedAt ?? null,
      lastRefutedAt: reviewTimestamps?.refutedAt ?? null,
    },
    now,
  );
  const successorId =
    row.status === 'superseded' ? repos.memory.findSuccessorId(row.id) : undefined;
  const successor = successorId
    ? repos.memory
        .adminGetByIds([successorId])
        .find((candidate) => candidate.projectId === row.projectId && candidate.scope === row.scope)
    : undefined;
  const annotations = repos.relations
    .adminListTouching(row.id)
    .map((relation) => ({ relation, kind: annotationKindFor(relation, row.id) }))
    .sort((a, b) =>
      compareAnnotations({ ...a.relation, kind: a.kind }, { ...b.relation, kind: b.kind }),
    );
  const pending = annotations.filter(({ relation }) => relation.status === 'pending');
  const touching = [
    ...pending,
    ...annotations.filter(({ relation }) => relation.status !== 'pending'),
  ];
  const visibleJudgmentCount = pending.length + 3;
  const dueDays = reviewAfter
    ? Math.ceil(Math.abs(reviewAfter.getTime() - now.getTime()) / 86_400_000)
    : 0;
  const elapsed =
    reviewAfter && reviewBaseline
      ? Math.max(
          0,
          Math.min(
            100,
            ((now.getTime() - reviewBaseline.getTime()) /
              (reviewAfter.getTime() - reviewBaseline.getTime())) *
              100,
          ),
        )
      : 0;
  const canConfirm = row.status !== 'superseded';
  const needsReview = canConfirm && reviewState === 'needs_review';
  const confirmForm = (
    <ActionForm action={confirmMemory}>
      <CsrfField form={CONFIRM_FORM} />
      <input type="hidden" name="id" value={row.id} />
      <Button type="submit" size="sm">
        Confirm
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
        confirmLabel="Archive"
      >
        <Button type="button" variant="outline" size="sm">
          Archive
        </Button>
      </ConfirmSubmit>
    </ActionForm>
  );
  const historyItem = (predecessor: typeof row) => (
    <li key={predecessor.id}>
      <Link href={`/dashboard/memories/${predecessor.id}`}>{predecessor.title}</Link>
      <div className="ficha-history-meta">
        <StatusPill status={predecessor.status} /> <Time value={predecessor.createdAt} />
      </div>
      <p className="ficha-snapshot">{truncate(predecessor.content, 160)}</p>
      {predecessor.replaces.length > 0 ? (
        <div className="ficha-replaces">
          Replaces{' '}
          {predecessor.replaces.map((rid) => (
            <Link key={rid} href={`/dashboard/memories/${rid}`}>
              {shortId(rid)}
            </Link>
          ))}
        </div>
      ) : null}
    </li>
  );
  const judgmentItem = ({ relation, kind }: (typeof touching)[number]) => {
    const isSource = relation.sourceId === row.id;
    return (
      <li key={relation.id}>
        <span className="ficha-kind">{kind}</span>
        <Link href={`/dashboard/memories/${isSource ? relation.targetId : relation.sourceId}`}>
          {isSource ? relation.targetTitle : relation.sourceTitle}
        </Link>
        <Link className="ficha-judgment-meta" href={`/dashboard/judgments/${relation.id}`}>
          <StatusPill status={relation.status} />{' '}
          <Time value={relation.judgedAt ?? relation.createdAt} />
        </Link>
      </li>
    );
  };
  const tag = (value: string) => (
    <span className="ficha-tag" key={value}>
      <span aria-hidden="true">#</span>
      {value}
    </span>
  );

  return (
    <DetailLayout
      presentation="ficha"
      title={row.title}
      backHref="/dashboard/memories"
      backLabel="Memories"
      topic={row.topicKey}
      contentLabel="Memory content"
      actionsLabel="Memory actions"
      badges={
        <>
          <StatusPill status={row.status} />
          <span className="ficha-byline">
            in{' '}
            {project ? (
              <Link href={`/dashboard/projects?q=${encodeURIComponent(project.slug)}`}>
                {project.slug}
              </Link>
            ) : (
              '—'
            )}
            , written by <b>{row.source?.agent ?? '—'}</b> on <Time value={row.createdAt} />
          </span>
        </>
      }
      tags={
        <div role="group" aria-label="Tags" className="ficha-tags">
          {row.tags.slice(0, 6).map(tag)}
          {row.tags.length > 6 ? (
            <DetailExpand
              label={`+${row.tags.length - 6}`}
              accessibleLabel={`Show all ${row.tags.length} tags`}
              className="ficha-extra-tags"
            >
              {row.tags.slice(6).map(tag)}
            </DetailExpand>
          ) : null}
        </div>
      }
      primaryActions={
        <>
          <DetailCopy text={`# ${row.title}\n\n${row.content}`} />
          <DetailShare
            data={{
              kind: 'memory',
              label: 'Memory',
              title: row.title,
              date: row.createdAt,
              byline: `Saved by ${row.source?.agent ?? 'unknown'}`,
              projectName: project?.slug ?? '—',
              content: { text: row.content, mode: 'markdown', label: 'Full content' },
              tags: row.tags,
            }}
          />
          {canConfirm && !needsReview ? confirmForm : null}
          {row.status === 'active' ? archiveForm : null}
        </>
      }
      notices={
        <>
          {justConfirmed ? (
            <p role="status" className="mb-4 text-sm text-primary">
              Confirmed · Review affirmed just now.
            </p>
          ) : null}
          {needsReview ? (
            <div className="ficha-notice ficha-review-notice">
              <p>
                Not re-affirmed since <Time value={reviewBaseline} />. Confirm it if it still holds,
                or save a new version under the same topic.
              </p>
              {confirmForm}
            </div>
          ) : null}
          {row.status === 'superseded' ? (
            <p className="ficha-notice">
              {successor ? (
                <>
                  Replaced on <Time value={successor.createdAt} /> by{' '}
                  <Link href={`/dashboard/memories/${successor.id}`}>
                    {successor.title} · {shortId(successor.id)}
                  </Link>
                  .{' '}
                </>
              ) : (
                'Superseded. '
              )}
              Kept for history; it no longer appears in recall.
            </p>
          ) : null}
        </>
      }
      metadata={
        <DetailDisclosure presentation="ficha" title="Properties">
          <dl>
            <dt>Type</dt>
            <dd>{row.type}</dd>
            <dt>Topic</dt>
            <dd>{row.topicKey ?? '—'}</dd>
            <dt>Scope</dt>
            <dd>{row.scope}</dd>
            <dt>Source</dt>
            <dd>{row.source?.agent ?? '—'}</dd>
            <dt>Confirmations</dt>
            <dd>{confirmCount}</dd>
            <dt>ID</dt>
            <dd>{row.id}</dd>
          </dl>
        </DetailDisclosure>
      }
      secondary={
        <>
          {row.status !== 'superseded' && reviewState !== null && reviewAfter !== null ? (
            <section className="ficha-section" aria-label="Review">
              <h2>
                Review <span>{reviewState === 'needs_review' ? 'overdue' : 'fresh'}</span>
              </h2>
              <div className="ficha-fresh-top">
                <b>{needsReview ? `Overdue by ${dueDays} days` : `Due in ${dueDays} days`}</b>
                <span>{confirmCount} confirmations</span>
              </div>
              <meter
                className={needsReview ? 'ficha-meter ficha-meter-overdue' : 'ficha-meter'}
                min={0}
                max={100}
                value={needsReview ? 100 : elapsed}
                aria-label="Review window used"
              />
              <div className="ficha-fresh-foot">
                <span>
                  {reviewTimestamps?.affirmedAt ? (
                    <>
                      Confirmed <Time value={reviewTimestamps.affirmedAt} />
                    </>
                  ) : (
                    <>
                      Created <Time value={row.createdAt} />
                    </>
                  )}
                </span>
                <span>
                  Due <Time value={reviewAfter} />
                </span>
              </div>
            </section>
          ) : null}
          <section className="ficha-section" aria-label="History">
            <h2>
              History <span>{predecessors.length + 1 + (successor ? 1 : 0)} versions</span>
            </h2>
            <ol className="ficha-history">
              {predecessors.length > 0 ? historyItem(predecessors[0]!) : null}
              {predecessors.length > 2 ? (
                <li className="ficha-history-gap">
                  <DetailExpand label={`+ ${predecessors.length - 2} intermediate versions`}>
                    <ol>{predecessors.slice(1, -1).map(historyItem)}</ol>
                  </DetailExpand>
                </li>
              ) : null}
              {predecessors.length > 1 ? historyItem(predecessors[predecessors.length - 1]!) : null}
              <li className="ficha-current">
                <span>This version</span>
                <div className="ficha-history-meta">
                  Since <Time value={row.createdAt} />
                </div>
              </li>
              {successor ? historyItem(successor) : null}
            </ol>
            {unresolved.size > 0 ? (
              <div className="ficha-replaces">
                Unresolved replaces{' '}
                {[...unresolved].map((rid) => (
                  <Link key={rid} href={`/dashboard/memories/${rid}`}>
                    {rid}
                  </Link>
                ))}
              </div>
            ) : null}
          </section>
          <DetailDisclosure
            presentation="ficha"
            label="Judgments"
            title={
              <>
                Judgments <span>{touching.length}</span>
              </>
            }
          >
            {touching.length === 0 ? (
              <p className="ficha-empty">No judgments touch this memory.</p>
            ) : (
              <>
                <ul className="ficha-judgments">
                  {touching.slice(0, visibleJudgmentCount).map(judgmentItem)}
                </ul>
                {touching.length > visibleJudgmentCount ? (
                  <DetailExpand label={`Show all ${touching.length} judgments`}>
                    <ul className="ficha-judgments">
                      {touching.slice(visibleJudgmentCount).map(judgmentItem)}
                    </ul>
                  </DetailExpand>
                ) : null}
              </>
            )}
          </DetailDisclosure>
        </>
      }
    >
      <MarkdownPanel
        presentation="reading"
        hideToolbar
        title="Durable context"
        markdown={row.content}
      />
      <footer className="ficha-footer">
        <span>
          Created <Time value={row.createdAt} />
        </span>
        <span>
          Last recalled <Time value={row.lastSeenAt} />
        </span>
      </footer>
    </DetailLayout>
  );
}
