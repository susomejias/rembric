import { annotationKindFor, compareAnnotations, deriveReviewState } from '@rembric/core';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { shortId, truncate } from '@/components/dashboard/support';
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
 * The Confirm and Archive verbs are still NOT ported: both are mutations, and
 * their Server Action boundary is a separate slice. The view renders their state
 * — review state, review-after date, confirmation count, lifecycle status — and
 * no dead control.
 */
export const dynamic = 'force-dynamic';

export default async function MemoryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
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
      />

      <div className="mt-4 mb-5">
        <BackLink href="/dashboard/memories" label="BACK TO MEMORIES" />
      </div>

      {reviewState === 'needs_review' ? (
        <Flash tone="amber" label="NEEDS REVIEW">
          Not re-affirmed since <Time value={reviewAfter} />. Re-affirming it with{' '}
          <code className="font-mono">memory.confirm</code> moves it back to fresh.
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
