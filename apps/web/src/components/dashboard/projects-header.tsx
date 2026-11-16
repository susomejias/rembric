import type { ReactNode } from 'react';

import { PageHelp } from '@/components/dashboard/page-help';
import { RouteTabs } from '@/components/dashboard/route-tabs';
import { TonePill } from '@/components/dashboard/ui';

export function ProjectsHeader({
  active,
  projectCount,
  pendingCount,
  actions,
}: {
  active: 'projects' | 'repositories';
  projectCount: number;
  pendingCount: number;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">Projects</h1>
          <PageHelp text="Projects scope memory. Git repositories connected to a project send their agents' memory there." />
        </div>
        {actions ? (
          <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
        ) : null}
      </section>
      <RouteTabs
        label="Projects sections"
        tabs={[
          {
            href: '/dashboard/projects',
            label: 'Projects',
            active: active === 'projects',
            badge: <TonePill tone="dim">{projectCount}</TonePill>,
          },
          {
            href: '/dashboard/projects/repositories',
            label: 'Repositories',
            active: active === 'repositories',
            badge: (
              <span data-pending-repositories={pendingCount}>
                {pendingCount > 0 ? (
                  <TonePill tone="amber">{pendingCount} to connect</TonePill>
                ) : null}
              </span>
            ),
          },
        ]}
      />
    </div>
  );
}
