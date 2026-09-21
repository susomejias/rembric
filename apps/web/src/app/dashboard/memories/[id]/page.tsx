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
import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { shortId, singleParam, truncate } from '@/components/dashboard/support';
import {
  BackLink,
  Chip,
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
  ReviewPill,
  SectionBar,
  StatCard,
  StatusPill,
  TableEmpty,
  Time,
  ViewHead,
} from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { guardAction, guardFailure } from '@/lib/actions/guard';
import { getServices } from '@/lib/services';

/**
 * The memory detail hub, in the production dashboard's composition: the head
 * with the id/status/project meta, the review flash, the key/value grid, the
 * content as rendered markdown with a copy control, and the lineage and
 * judgment tables.
 *
 * The reads are the retired `memories.ts` `/:id` handler's own — the same
 * repository methods, the same derived review state, the uncapped and
 * unpaginated judgment list — so the dashboard's per-memory view did not change
 * its meaning, only its surface.
 *
 * The Archive and Confirm verbs are `apps/server/src/dashboard/memories.ts`'s
 * `/:id/archive` and `/:id/confirm` POST handlers: guard first, then the row is
 * read unscoped and its own project's scope is what the service call is pinned
 * to, then the same redirect main landed on (`?confirmed=1` after a confirm).
 */
export const dynamic = 'force-dynamic';

const ARCHIVE_FORM = 'memory.archive';
const CONFIRM_FORM = 'memory.confirm';

/** `dashboard/memories.ts`' refusal for a row that has no project to act in. */
const NO_PROJECT_MESSAGE =
  'This memory predates the default project and has no project to act in. An older image wrote it; it cannot be archived or confirmed from the dashboard.';

async function archiveMemory(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, ARCHIVE_FORM);
  if (!guard.ok) return guardFailure(guard);

  const id = readField(formData, 'id');
  // Scope resolution mirrors the retired handler: the row is read unscoped,
  // then its own project's scope is what the service call is pinned to.
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

/** The trimmed string field `dashboard/memories.ts` reads; a repeated field takes its first value. */
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
  // `adminGetByIds` has no ORDER BY; sorting restores the chronological contract.
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
  // `findSuccessorId` returns the id alone; the row behind it is the title this
  // view has to show, so it is read here rather than linked blind.
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
    <Page>
      <ViewHead
        num="02"
        title={row.title}
        meta={[
          { k: 'ID', v: shortId(row.id) },
          { k: 'STATUS', v: row.status.toUpperCase() },
          { k: 'PROJECT', v: projectLabel },
        ]}
        titleVisible
      />

      <div className="mt-4 mb-5">
        <BackLink href="/dashboard/memories" label="BACK TO MEMORIES" />
      </div>

      {justConfirmed ? (
        <Flash tone="lime" label="CONFIRMED">
          Review affirmed just now.
        </Flash>
      ) : null}

      {reviewState === 'needs_review' ? (
        <Flash tone="amber" label="NEEDS REVIEW">
          Not re-affirmed since <Time value={reviewAfter} />. Re-affirming it with{' '}
          <code className="font-mono">memory.confirm</code> moves it back to fresh.
          <div className="mt-3">{confirmForm}</div>
        </Flash>
      ) : null}

      <KvGrid>
        <Kv k="Status" v={<StatusPill status={row.status} />} />
        <Kv k="Project" v={projectLabel} />
        <Kv k="Type" v={row.type} />
        <Kv k="Confirms" v={confirmCount} />
        <Kv k="Created" v={<Time value={row.createdAt} />} mono />
        <Kv k="Last seen" v={<Time value={row.lastSeenAt} />} mono />
        <Kv k="Scope" v={row.scope} mono />
        <Kv k="Topic key" v={row.topicKey ?? '—'} mono />
        <Kv k="Source" v={row.source?.agent ?? '—'} mono />
        {successor ? (
          <Kv
            k="Superseded by"
            v={
              <Link
                href={`/dashboard/memories/${successor.id}`}
                className="text-primary hover:underline"
              >
                {shortId(successor.id)}
              </Link>
            }
            mono
          />
        ) : null}
        {reviewState !== null && reviewAfter !== null ? (
          <>
            <Kv
              k="Review"
              v={reviewState === 'needs_review' ? <ReviewPill /> : 'fresh'}
              tone={reviewState === 'needs_review' ? 'amber' : 'lime'}
            />
            <Kv k="Review after" v={<Time value={reviewAfter} />} mono />
          </>
        ) : null}
      </KvGrid>

      <MarkdownPanel eyebrow="Memory content" title="Durable context" markdown={markdown} />

      <SectionBar name="TAGS" />
      <div className="mb-6 flex flex-wrap gap-2">
        {row.tags.length === 0 ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          row.tags.map((tag) => <Chip key={tag}>{tag}</Chip>)
        )}
      </div>

      <SectionBar name="REPLACES" />
      <div className="mb-6 flex flex-wrap gap-3 font-mono text-xs">
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

      <SectionBar name={`PREDECESSORS (${predecessors.length})`} />
      {predecessors.length === 0 ? (
        <TableEmpty>NO PREDECESSORS</TableEmpty>
      ) : (
        <DataTable>
          <DataHead>
            <DataTh>status</DataTh>
            <DataTh>title</DataTh>
            <DataTh>content</DataTh>
            <DataTh>created</DataTh>
          </DataHead>
          <DataBody>
            {predecessors.map((predecessor) => (
              <DataTr key={predecessor.id}>
                <DataTd>
                  <StatusPill status={predecessor.status} />
                </DataTd>
                <DataTd>
                  <Link
                    href={`/dashboard/memories/${predecessor.id}`}
                    className="transition-colors hover:text-primary"
                  >
                    {truncate(predecessor.title, 120)}
                  </Link>
                </DataTd>
                <DataTd className="max-w-[420px] truncate text-muted-foreground">
                  {truncate(predecessor.content, 160)}
                </DataTd>
                <DataTd className="font-mono text-xs text-muted-foreground">
                  <Time value={predecessor.createdAt} />
                </DataTd>
              </DataTr>
            ))}
          </DataBody>
        </DataTable>
      )}

      <div className="mt-6">
        <SectionBar name={`JUDGMENTS (${touching.length})`} />
      </div>
      {touching.length === 0 ? (
        <TableEmpty>NO JUDGMENTS TOUCH THIS MEMORY</TableEmpty>
      ) : (
        <DataTable>
          <DataHead>
            <DataTh>kind</DataTh>
            <DataTh>status</DataTh>
            <DataTh>counterpart</DataTh>
            <DataTh>timestamp</DataTh>
          </DataHead>
          <DataBody>
            {touching.map(({ relation, kind }) => {
              const isSource = relation.sourceId === row.id;
              const counterpartId = isSource ? relation.targetId : relation.sourceId;
              const counterpartTitle = isSource ? relation.targetTitle : relation.sourceTitle;
              return (
                <DataTr key={relation.id}>
                  <DataTd>
                    <Pill tone={kind === 'pending_conflict' ? 'amber' : 'lime'}>{kind}</Pill>
                  </DataTd>
                  <DataTd>
                    <StatusPill status={relation.status} />
                  </DataTd>
                  <DataTd>
                    <Link
                      href={`/dashboard/memories/${counterpartId}`}
                      className="transition-colors hover:text-primary"
                    >
                      {truncate(counterpartTitle, 80)}
                    </Link>
                  </DataTd>
                  <DataTd className="text-muted-foreground">
                    <Link
                      href={`/dashboard/judgments/${relation.id}`}
                      className="hover:text-primary"
                    >
                      <Time value={relation.judgedAt ?? relation.createdAt} />
                    </Link>
                  </DataTd>
                </DataTr>
              );
            })}
          </DataBody>
        </DataTable>
      )}

      <div className="mt-6">
        <SectionBar name="ACTIONS" />
      </div>
      <div className="mb-6 flex flex-wrap items-center gap-3">
        {row.status === 'active' ? archiveForm : null}
        {reviewState !== 'needs_review' ? confirmForm : null}
      </div>

      <div className="mt-6 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard k="CONFIRMATIONS" v={confirmCount} sub={<span>memory.confirm</span>} />
        <StatCard k="JUDGMENTS" v={touching.length} sub={<span>TOUCHING THIS ROW</span>} />
        <StatCard k="PREDECESSORS" v={predecessors.length} sub={<span>REPLACED</span>} />
        <StatCard
          k="STATE"
          v={reviewState === 'needs_review' ? 'REVIEW' : 'FRESH'}
          tone={reviewState === 'needs_review' ? 'amber' : 'lime'}
          sub={<span>{row.status.toUpperCase()}</span>}
        />
      </div>
    </Page>
  );
}
