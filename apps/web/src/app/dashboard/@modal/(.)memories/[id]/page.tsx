import { notFound } from 'next/navigation';

import { DetailSheet } from '@/components/dashboard/detail-sheet';
import { loadMemoryDetail, MemoryDetail } from '@/components/dashboard/memory-detail';

/**
 * The memory detail as a slide-over, over the list the operator clicked from.
 *
 * `(.)memories/[id]` is an *intercepting* route: a client-side navigation from
 * `/dashboard/memories` to `/dashboard/memories/<id>` renders here — in the
 * layout's `@modal` slot, with the list still mounted behind it — while the URL
 * stays the item's own. A hard load of that URL skips the interception and
 * renders `memories/[id]/page.tsx`, which is why both files exist and why both
 * read the same `loadMemoryDetail`.
 */
export const dynamic = 'force-dynamic';

export default async function MemoryDetailSheet({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = loadMemoryDetail(id);
  if (!data) notFound();

  const { row, projectLabel, confirmCount } = data;

  return (
    <DetailSheet
      title={row.title}
      subtitle={`${row.type} · ${projectLabel} · ${row.status} · ${confirmCount} confirm${
        confirmCount === 1 ? '' : 's'
      }`}
    >
      <MemoryDetail data={data} />
    </DetailSheet>
  );
}
