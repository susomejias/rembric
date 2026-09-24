import type { ReactNode } from 'react';

import { getUpdates } from './update/update-service';

import { CommandFrame } from '@/components/dashboard/command-bar';
import { getServices } from '@/lib/services';
import { REMBRIC_VERSION } from '@/lib/version';

export const dynamic = 'force-dynamic';

export default function DashboardLayout({ children }: { children: ReactNode }) {
  const updates = getUpdates();

  return (
    <CommandFrame
      totals={navTotals()}
      version={REMBRIC_VERSION}
      updater={{
        enabled: updates.enabled,
        latestVersion: updates.peek()?.latestVersion ?? null,
        lastCheckedAt: updates.lastCheckedAt,
      }}
    >
      {children}
    </CommandFrame>
  );
}

function navTotals(): Record<string, number> {
  const { repos } = getServices();

  return {
    memories: repos.memory.countRowsByStatus().reduce((acc, row) => acc + row.count, 0),
    sessions: repos.agentSessions.adminCount({ deleted: false }),
    judgments: (['pending', 'judged', 'orphaned'] as const).reduce(
      (acc, status) => acc + repos.relations.adminCountByStatus(status),
      0,
    ),
    entities: repos.entities.adminCountsByKind().reduce((acc, row) => acc + row.count, 0),
    projects: repos.projects.count(),
    tokens: repos.tokens.count(),
  };
}
