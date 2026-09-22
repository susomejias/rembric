import { REVIEW_TTL_MS } from '@rembric/core';
import type { MemoryType } from '@rembric/db';
import type { ReactNode } from 'react';

import { getUpdates } from './update/update-service';

import { SidebarFrame } from '@/components/dashboard/app-sidebar';
import { type BadgeBreakdown, type NavBadgeCounters } from '@/lib/nav';
import { getServices } from '@/lib/services';
import { REMBRIC_VERSION } from '@/lib/version';

/**
 * The dashboard shell. Two things live here rather than in the navigation
 * component, because both are server-side facts:
 *
 * - **The rail's two badge counts.** They come from the service graph, so the
 *   client component is handed values and never the repositories. Every
 *   `/dashboard` page is `force-dynamic`, so this runs per request and never
 *   during `next build`.
 * - **The update read-state.** The rail's update slot reflects what the
 *   release-check service currently knows, and nothing on the client can reach
 *   it. Only the facts are passed down — whether the check is enabled, the
 *   release it found and when it last ran — so the wording lives in one place.
 *   The check is the service's own lazy one: reading it here is the same request
 *   main's shell made, and `force-dynamic` below is what keeps it per-request.
 */
export const dynamic = 'force-dynamic';

const TTL_BY_TYPE = Object.entries(REVIEW_TTL_MS).filter(
  (entry): entry is [MemoryType, number] => typeof entry[1] === 'number',
);

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const updates = getUpdates();

  return (
    <SidebarFrame
      counters={badgeCounters()}
      version={REMBRIC_VERSION}
      updater={{
        enabled: updates.enabled,
        latestVersion: updates.peek()?.latestVersion ?? null,
        lastCheckedAt: updates.lastCheckedAt,
      }}
    >
      {children}
    </SidebarFrame>
  );
}

/**
 * The rail's badges, grouped by project. A badge
 * carries its per-project split as well as its total because the dashboard reads
 * across every project at once: a bare total would say "3" where the operator
 * needs to know which project to open, and the split is what the item's `title`
 * renders as one line per project.
 *
 * The breakdown is not merely a display detail — it is why the total is read from
 * the *grouped* siblings of the counters. They are also a
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
