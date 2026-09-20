import { notFound } from 'next/navigation';

import { shortId } from '@/components/dashboard/format';
import { loadSessionDetail, SessionDetail } from '@/components/dashboard/session-detail';
import { BackLink, ViewHead } from '@/components/dashboard/view-head';

/**
 * The session detail page — the direct-link carrier of the body the intercepted
 * `@modal/(.)sessions/[id]` route opens as a slide-over. One read, one body, two
 * carriers; this one adds the header and the link back to the list.
 */
export const dynamic = 'force-dynamic';

export default async function SessionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = loadSessionDetail(id);
  if (!data) notFound();

  const { row, title } = data;

  return (
    <div className="flex flex-col gap-4">
      <ViewHead
        title={title}
        meta={[
          { k: 'ID', v: <span className="font-mono">{shortId(row.id)}</span> },
          { k: 'STATUS', v: row.status.toUpperCase() },
        ]}
      />

      <BackLink href="/dashboard/sessions" label="BACK TO SESSIONS" />

      <SessionDetail data={data} />
    </div>
  );
}
