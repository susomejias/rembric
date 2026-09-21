import { REVIEW_TTL_MS } from '@rembric/core';
import type { MemoryType } from '@rembric/db';
import type { ReactNode } from 'react';

import { SidebarFrame } from '@/components/dashboard/app-sidebar';
import { type BadgeBreakdown, type NavBadgeCounters } from '@/lib/nav';
import { getServices } from '@/lib/services';

/**
 * The dashboard shell. Two things live here rather than in the navigation
 * component, because both are server-side facts:
 *
 * - **The rail's two badge counts.** They come from the service graph, so the
 *   client component is handed values and never the repositories. Every
 *   `/dashboard` page is `force-dynamic`, so this runs per request and never
 *   during `next build`.
 * - **The theme bootstrap.** It runs during HTML parsing, before the body
 *   paints, because the class it sets is the difference between loading in the
 *   stored theme and flashing dark first. `.dark` is server-rendered on
 *   `<html>` (`app/layout.tsx`), so the script only has to *remove* it for an
 *   operator who chose light; an absent key leaves the document as rendered.
 *
 * `THEME_STORAGE_KEY` is declared here, in the server component that renders the
 * script, and threaded down to the toggle as a prop rather than exported from
 * `site-header.tsx`: an export of a `'use client'` module is a client reference,
 * so reading it during the server render throws instead of returning the string.
 */
export const dynamic = 'force-dynamic';

const THEME_STORAGE_KEY = 'rembric-theme';

const TTL_BY_TYPE = Object.entries(REVIEW_TTL_MS).filter(
  (entry): entry is [MemoryType, number] => typeof entry[1] === 'number',
);

export default function DashboardLayout({ children }: { children: ReactNode }) {
  return (
    <>
      <script>{themeScript()}</script>
      <SidebarFrame counters={badgeCounters()} themeStorageKey={THEME_STORAGE_KEY}>
        {children}
      </SidebarFrame>
      <script>{timezoneScript()}</script>
    </>
  );
}

/**
 * The rail's badges, grouped by project the way main's sidebar groups them
 * (`apps/server/src/server/dashboard-router.ts::computeBadgeCounters`). A badge
 * carries its per-project split as well as its total because the dashboard reads
 * across every project at once: a bare total would say "3" where the operator
 * needs to know which project to open, and the split is what the item's `title`
 * renders as one line per project.
 *
 * The breakdown is not merely a display detail — it is why the total is read from
 * the *grouped* siblings of the counters this shell used to read. They are also a
 * narrower definition, and deliberately so: `adminPendingAdjudicableByProject`
 * counts pending pairs whose source and target memories are both still active,
 * which is the set `memory.judge` can actually resolve and therefore the set the
 * badge's own tooltip promises. A pair with an archived endpoint is not a
 * candidate, so the judgments badge can read lower than a raw pending count.
 */
function badgeCounters(): NavBadgeCounters {
  const { repos } = getServices();
  const projectSlugs = new Map(
    repos.projects.adminListAll().map((project) => [project.id, project.slug]),
  );

  const toBreakdown = (
    rows: ReadonlyArray<{ projectId: string | null; count: number }>,
  ): BadgeBreakdown => ({
    total: rows.reduce((acc, row) => acc + row.count, 0),
    byProject: rows.map((row) => ({
      label: row.projectId === null ? 'global' : (projectSlugs.get(row.projectId) ?? row.projectId),
      count: row.count,
    })),
  });

  return {
    pendingJudgments: toBreakdown(repos.relations.adminPendingAdjudicableByProject()),
    needsReview: toBreakdown(
      repos.memory.adminCountNeedsReviewByProject({ nowMs: Date.now(), ttlByType: TTL_BY_TYPE }),
    ),
  };
}

function themeScript(): string {
  return `(function(){try{var t=localStorage.getItem('${THEME_STORAGE_KEY}');var r=document.documentElement;if(t==='light'){r.classList.remove('dark')}else if(t==='dark'){r.classList.add('dark')}}catch(e){}})()`;
}

/**
 * Upgrades every `[data-rembric-ts]` text node from its UTC fallback to the
 * viewer's timezone. The UTC string is what the server rendered, so this is a
 * progressive improvement rather than a correctness requirement: a document
 * without JavaScript keeps the unambiguous UTC reading instead of a wrong one.
 */
function timezoneScript(): string {
  return `(function(){try{var tz=Intl.DateTimeFormat().resolvedOptions().timeZone;var f=new Intl.DateTimeFormat(undefined,{year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',timeZone:tz});document.querySelectorAll('[data-rembric-ts]').forEach(function(el){var d=new Date(el.getAttribute('datetime')||'');if(!isNaN(d.getTime())){el.textContent=f.format(d).replace(',',', ')}})}catch(e){}})()`;
}
