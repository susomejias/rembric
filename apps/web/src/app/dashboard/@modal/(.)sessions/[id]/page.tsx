import { notFound } from 'next/navigation';

import { DetailSheet } from '@/components/dashboard/detail-sheet';
import { loadSessionDetail, SessionDetail } from '@/components/dashboard/session-detail';

/**
 * The session detail as a slide-over, over the sessions list. The intercepted
 * twin of `sessions/[id]/page.tsx`: same `loadSessionDetail` read, same
 * `SessionDetail` body, different carrier — `@modal` keeps the list mounted
 * behind the panel, the page serves a direct link.
 */
export const dynamic = 'force-dynamic';

export default async function SessionDetailSheet({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = loadSessionDetail(id);
  if (!data) notFound();

  const { row, title } = data;

  return (
    <DetailSheet
      title={title}
      subtitle={`${row.agent} · ${row.status} · ${row.projectSlug ?? 'no project'} · ${row.id}`}
    >
      <SessionDetail data={data} />
    </DetailSheet>
  );
}
