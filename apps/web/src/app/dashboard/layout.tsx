import { REVIEW_TTL_MS } from '@rembric/core';
import type { MemoryType } from '@rembric/db';
import type { ReactNode } from 'react';

import { getUpdates } from './update/update-service';

import { SidebarFrame } from '@/components/dashboard/app-sidebar';
import { type BadgeBreakdown, type NavBadgeCounters } from '@/lib/nav';
import { getServices } from '@/lib/services';
import { REMBRIC_VERSION } from '@/lib/version';

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
