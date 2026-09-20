import { annotationKindFor, compareAnnotations, deriveReviewState } from '@rembric/core';
import { ArrowLeft, Database, Tag } from 'lucide-react';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { ReactNode } from 'react';

import { MarkdownPanel } from '@/components/dashboard/markdown-panel';
import { shortId, truncate } from '@/components/dashboard/support';
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
 * The memory detail hub, in the v0 composition: the title block, the facts grid,
 * the durable content as rendered markdown with a copy control, the lineage and
 * judgment context, and the metadata aside.
 *
 * The reads are the retired `memory-detail.tsx` loader's own — the same
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

  const markdown = `# ${row.title}\n\n${row.content}`;

  return (
    <Page className="max-w-[1100px]">
      <Link
        href="/dashboard/memories"
        className="mb-6 flex items-center gap-2 text-xs text-(--ink)/40 transition-colors hover:text-(--accent-ink)"
      >
        <ArrowLeft className="size-3.5" />
        Back to memories
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-5">
        <div className="max-w-2xl">
          <div className="flex items-center gap-2 text-[10px] tracking-[.15em] text-(--accent-ink-strong)/70 uppercase">
            <Database className="size-3" />
            Memory · {row.type} · {row.scope}
          </div>
          <h1 className="mt-3 text-2xl font-medium tracking-[-.06em] md:text-4xl">{row.title}</h1>
          <p className="mt-3 text-sm leading-6 text-(--ink)/45">{truncate(row.content, 240)}</p>
        </div>
        <Pill
          tone={reviewState === 'needs_review' ? 'amber' : row.status === 'active' ? 'lime' : 'dim'}
        >
          {reviewState === 'needs_review' ? 'Needs review' : row.status}
        </Pill>
      </div>

      {reviewState === 'needs_review' ? (
        <Notice tone="amber" badge="Needs review" className="mt-6">
          Not re-affirmed since <Time value={reviewAfter} />. Re-affirming it with{' '}
          <code className="font-mono">memory.confirm</code> moves it back to fresh.
        </Notice>
      ) : null}

      <section className="mt-8 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Fact label="Project" value={project?.slug ?? 'global'} />
        <Fact label="Created" value={<Time value={row.createdAt} />} />
        <Fact label="Confirmations" value={confirmCount} />
        <Fact label="Last seen" value={<Time value={row.lastSeenAt} />} />
      </section>

      <MarkdownPanel eyebrow="Memory content" title="Durable context" markdown={markdown} />

      <div className="mt-6 grid gap-6 lg:grid-cols-[1.25fr_.75fr]">
        <Panel>
          <PanelHead eyebrow="Lineage" title="What this memory replaced, and what replaced it" />
          {predecessors.length === 0 && successor === undefined && touching.length === 0 ? (
            <p className="px-5 py-5 text-sm text-(--ink)/45 md:px-6">
              This memory stands alone: no predecessor, no successor, and no judgment recorded
              against it.
            </p>
          ) : (
            <Rows>
              {predecessors.map((predecessor) => (
                <Row key={predecessor.id} columns="md:grid-cols-[auto_1fr_auto]">
                  <span className="grid size-7 place-items-center rounded-lg bg-(--ink)/[5%] text-(--ink)/55">
                    <Tag className="size-3.5" />
                  </span>
                  <Link href={`/dashboard/memories/${predecessor.id}`} className="group">
                    <p className="text-sm text-(--ink)/80 group-hover:text-(--accent-ink)">
                      {predecessor.title}
                    </p>
                    <p className="mt-1 text-[10px] text-(--ink)/38">
                      replaced · {predecessor.status}
                    </p>
                  </Link>
                  <Pill tone="dim">Replaces</Pill>
                </Row>
              ))}
              {successor ? (
                <Row columns="md:grid-cols-[auto_1fr_auto]">
                  <span className="grid size-7 place-items-center rounded-lg bg-(--accent-ink)/[8%] text-(--accent-ink)/70">
                    <Tag className="size-3.5" />
                  </span>
                  <Link href={`/dashboard/memories/${successor.id}`} className="group">
                    <p className="text-sm text-(--ink)/80 group-hover:text-(--accent-ink)">
                      {successor.title}
                    </p>
                    <p className="mt-1 text-[10px] text-(--ink)/38">
                      superseded this memory · {successor.status}
                    </p>
                  </Link>
                  <Pill tone="lime">Superseded by</Pill>
                </Row>
              ) : null}
              {touching.map(({ relation, kind }) => (
                <Row key={relation.id} columns="md:grid-cols-[auto_1.3fr_1fr_auto]">
                  <span className="grid size-7 place-items-center rounded-lg bg-(--ink)/[5%] text-[10px] text-(--ink)/55">
                    {relation.judgmentId === '' ? '—' : relation.judgmentId.slice(0, 2)}
                  </span>
                  <Link
                    href={`/dashboard/memories/${relation.sourceId === row.id ? relation.targetId : relation.sourceId}`}
                    className="group"
                  >
                    <p className="text-sm text-(--ink)/80 group-hover:text-(--accent-ink)">
                      {relation.sourceId === row.id ? relation.targetTitle : relation.sourceTitle}
                    </p>
                    <p className="mt-1 text-[10px] text-(--ink)/38">
                      {relation.relation ?? 'pending'} · {relation.confidence ?? '—'} confidence
                    </p>
                  </Link>
                  <span className="text-[11px] text-(--ink)/45">
                    <Time value={relation.judgedAt ?? relation.createdAt} />
                  </span>
                  <Pill tone={kind === 'pending_conflict' ? 'amber' : 'lime'}>{kind}</Pill>
                </Row>
              ))}
            </Rows>
          )}
        </Panel>

        <aside className="rounded-2xl border border-(--ink)/[7.5%] bg-(--surface-panel) p-5">
          <p className="text-[10px] tracking-[.14em] text-(--ink)/38 uppercase">Metadata</p>
          <dl className="mt-5 flex flex-col gap-4 text-xs">
            <MetadataRow
              label="Memory id"
              value={<code className="font-mono">{shortId(row.id)}</code>}
            />
            <MetadataRow label="Type" value={row.type} />
            <MetadataRow label="Scope" value={row.scope} />
            <MetadataRow label="Topic key" value={row.topicKey ?? '—'} />
            <MetadataRow label="Tags" value={row.tags.length > 0 ? row.tags.join(', ') : '—'} />
            <MetadataRow label="Source session" value={shortId(row.sessionId)} />
            <MetadataRow label="Source agent" value={row.source?.agent ?? '—'} />
          </dl>
          <p className="mt-6 border-t border-(--ink)/[6%] pt-4 text-[11px] text-(--ink)/40">
            Local, append-only storage. Nothing here was edited after it was written.
          </p>
        </aside>
      </div>
    </Page>
  );
}

function MetadataRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="text-(--ink)/40">{label}</dt>
      <dd className="max-w-[60%] truncate text-right text-(--ink)/75">{value}</dd>
    </div>
  );
}
