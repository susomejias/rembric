import { notFound } from 'next/navigation';

import { ReviewBadge, StatusBadge } from '@/components/dashboard/badges';
import { shortId } from '@/components/dashboard/format';
import { loadMemoryDetail, MemoryDetail } from '@/components/dashboard/memory-detail';
import { BackLink, ViewHead } from '@/components/dashboard/view-head';

/**
 * The memory detail page — the direct-link carrier of the body the intercepted
 * `@modal/(.)memories/[id]` route opens as a slide-over. Both carriers read the
 * same `loadMemoryDetail` and render the same `MemoryDetail`, so the sheet and
 * the page cannot drift; this one adds the header and the way back to the list,
 * which a panel opened from that list does not need.
 */
export const dynamic = 'force-dynamic';

export default async function MemoryDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = loadMemoryDetail(id);
  if (!data) notFound();

  const { row, projectLabel, reviewState } = data;

  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        title={row.title}
        meta={[
          { k: 'ID', v: <span className="font-mono">{shortId(row.id)}</span> },
          { k: 'STATUS', v: row.status.toUpperCase() },
          { k: 'PROJECT', v: projectLabel },
        ]}
      />

      <div className="flex flex-wrap items-center gap-3">
        <BackLink href="/dashboard/memories" label="BACK TO MEMORIES" />
        <StatusBadge status={row.status} />
        {reviewState === 'needs_review' ? <ReviewBadge /> : null}
      </div>

      <MemoryDetail data={data} />
    </div>
  );
}
