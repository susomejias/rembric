'use client';

import { PageNotFound } from '@/components/bento/empty-states';
import { NAV, NAV_GROUPS } from '@/lib/nav';

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
