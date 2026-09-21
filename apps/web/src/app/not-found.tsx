'use client';

import { PageNotFound } from '@/components/bento/empty-states';
import { NAV, NAV_GROUPS } from '@/lib/nav';

/**
 * The 404 every dashboard view falls through to. `memories/[id]/page.tsx` calls
 * `notFound()` for an unknown id (the retired view answered 404 there too), and
 * any path with no route lands here.
 *
 * It lives at the app root rather than under `dashboard/` on purpose: Next
 * renders the nearest `not-found.tsx` to the segment that failed, and a root
 * sibling covers both a dashboard route and a path that never matched the
 * dashboard subtree at all. That is also why it is a client component — the
 * destination list has to filter as the reader types, and `usePathname()` is
 * what supplies the path that was tried. One consequence is disclosed rather
 * than hidden: the root layout carries no shell, so this page renders without
 * the sidebar.
 *
 * The destinations are the sidebar's own table, group captions included, so the
 * 404 can only ever point at a route the product actually carries.
 */
const GROUP_LABEL = new Map(NAV_GROUPS.map((group) => [group.key, group.heading]));

const DESTINATIONS = NAV.map((entry) => ({
  label: entry.label,
  href: entry.href,
  section: GROUP_LABEL.get(entry.group),
}));

export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-svh w-full max-w-xl flex-col justify-center gap-6 p-6">
      <PageNotFound destinations={DESTINATIONS} />
    </div>
  );
}
