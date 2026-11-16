import Link from 'next/link';

import {
  acceptRepositoryRemotes,
  bindRepository,
  discardPendingRepository,
  removeRepositoryBinding,
  restorePendingRepository,
} from '../actions';
import { loadRepositoryData } from '../repositories-data';
import {
  ACCEPT_REMOTES_FORM,
  BIND_FORM,
  DISCARD_FORM,
  REMOVE_FORM,
  RESTORE_FORM,
} from '../repository-forms';

import { PageHelp } from '@/components/dashboard/page-help';
import { PendingRepositoryList } from '@/components/dashboard/repositories-pending';
import { singleParam } from '@/components/dashboard/support';
import { LABEL, Page } from '@/components/dashboard/ui';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';
import { cn } from '@/lib/utils';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

const TAB = 'rounded-[10px] border px-3 py-1.5 text-xs font-medium transition-colors';

export default async function PendingRepositoriesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const discarded = singleParam(params['view']) === 'discarded';

  const services = getServices();
  const active = services.projects.list();
  const all = [...active, ...services.projects.listArchived()];
  const data = loadRepositoryData(
    services,
    all.map((p) => ({ id: p.id, slug: p.slug })),
  );

  const csrf = {
    bind: await dashboardCsrfToken(BIND_FORM),
    remove: await dashboardCsrfToken(REMOVE_FORM),
    acceptRemotes: await dashboardCsrfToken(ACCEPT_REMOTES_FORM),
    discard: await dashboardCsrfToken(DISCARD_FORM),
    restore: await dashboardCsrfToken(RESTORE_FORM),
  };

  const tabs = [
    {
      href: '/dashboard/projects/repositories',
      label: 'Pending',
      count: data.live.length,
      on: !discarded,
    },
    {
      href: '/dashboard/projects/repositories?view=discarded',
      label: 'Discarded',
      count: data.discarded.length,
      on: discarded,
    },
  ];

  return (
    <Page className="flex flex-col gap-4">
      <section className="flex flex-col gap-2">
        <Link
          href="/dashboard/projects"
          className={cn(LABEL, 'text-muted-foreground hover:text-foreground')}
        >
          ← Projects
        </Link>
        <div className="flex items-center gap-2">
          <h1 className="text-3xl font-semibold tracking-tight text-foreground">
            Pending repositories
          </h1>
          <PageHelp text="Repositories agents worked in that no project is bound to yet, root .rembric suggestions and remotes a binding has never seen." />
        </div>
      </section>

      <nav aria-label="Pending repository views" className="flex flex-wrap gap-2">
        {tabs.map((tab) => (
          <Link
            key={tab.label}
            href={tab.href}
            aria-current={tab.on ? 'page' : undefined}
            className={cn(
              TAB,
              tab.on
                ? 'border-primary/50 bg-primary/10 text-foreground'
                : 'border-border text-muted-foreground hover:text-foreground',
            )}
          >
            {tab.label} <span className="font-mono">{tab.count}</span>
          </Link>
        ))}
      </nav>

      <PendingRepositoryList
        rows={discarded ? data.discarded : data.live}
        projects={active.map((p) => ({ id: p.id, slug: p.slug }))}
        actions={{
          bind: bindRepository,
          remove: removeRepositoryBinding,
          acceptRemotes: acceptRepositoryRemotes,
          discard: discardPendingRepository,
          restore: restorePendingRepository,
        }}
        csrf={csrf}
        discarded={discarded}
      />
    </Page>
  );
}
