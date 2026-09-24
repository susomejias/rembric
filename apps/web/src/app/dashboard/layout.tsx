import type { ReactNode } from 'react';

import { startUpdate, UPDATE_START_FORM } from './update/actions';
import { getSelfUpdate, isUpdateRunning } from './update/self-update-service';
import { getUpdates } from './update/update-service';

import { CommandFrame } from '@/components/dashboard/command-bar';
import { UpdateModal } from '@/components/dashboard/update-modal';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';
import { REMBRIC_VERSION } from '@/lib/version';

export const dynamic = 'force-dynamic';

export default async function DashboardLayout({ children }: { children: ReactNode }) {
  const updates = getUpdates();
  const info = updates.peek();
  const announceUpdate = info !== null && !isUpdateRunning(getSelfUpdate().status());
  const csrfToken = announceUpdate ? await dashboardCsrfToken(UPDATE_START_FORM) : null;

  return (
    <CommandFrame
      totals={navTotals()}
      version={REMBRIC_VERSION}
      updater={{
        enabled: updates.enabled,
        latestVersion: info?.latestVersion ?? null,
        lastCheckedAt: updates.lastCheckedAt,
      }}
    >
      {children}
      {announceUpdate && csrfToken !== null && info !== null ? (
        <UpdateModal info={info} csrfToken={csrfToken} startUpdate={startUpdate} />
      ) : null}
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
