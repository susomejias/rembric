import { ArrowLeft, ArrowRight } from 'lucide-react';
import Link from 'next/link';

import {
  acceptRepositoryRemotes,
  bindRepository,
  createProject,
  discardPendingRepository,
  removeRepositoryBinding,
  restorePendingRepository,
} from '../actions';
import { loadRepositoryData } from '../repositories-data';
import {
  ACCEPT_REMOTES_FORM,
  BIND_FORM,
  CREATE_FORM,
  DISCARD_FORM,
  REMOVE_FORM,
  RESTORE_FORM,
} from '../repository-forms';

import { ProjectsHeader } from '@/components/dashboard/projects-header';
import { ConnectedRepositoryList } from '@/components/dashboard/repositories-connected';
import {
  IgnoredRepositoryList,
  NeedsProjectList,
} from '@/components/dashboard/repositories-pending';
import { ResultAlerts } from '@/components/dashboard/result-alerts';
import { singleParam } from '@/components/dashboard/support';
import { Page, TonePill } from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { getServices } from '@/lib/services';
import { dashboardCsrfToken } from '@/lib/session';

export const dynamic = 'force-dynamic';

type SearchParams = Record<string, string | string[] | undefined>;

const PATH = '/dashboard/projects/repositories';
const CARD = 'overflow-hidden rounded-2xl border border-border bg-card shadow-lg shadow-black/20';

export default async function RepositoriesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const ignoredView = ['ignored', 'discarded'].includes(singleParam(params['view']));

  const services = getServices();
  const active = services.projects.list();
  const all = [...active, ...services.projects.listArchived()];
  const data = loadRepositoryData(
    services,
    all.map((p) => ({ id: p.id, slug: p.slug })),
  );
  const projects = active.map((p) => ({ id: p.id, slug: p.slug }));

  const csrf = {
    bind: await dashboardCsrfToken(BIND_FORM),
    remove: await dashboardCsrfToken(REMOVE_FORM),
    acceptRemotes: await dashboardCsrfToken(ACCEPT_REMOTES_FORM),
    discard: await dashboardCsrfToken(DISCARD_FORM),
    restore: await dashboardCsrfToken(RESTORE_FORM),
  };
  const actions = {
    bind: bindRepository,
    remove: removeRepositoryBinding,
    acceptRemotes: acceptRepositoryRemotes,
    discard: discardPendingRepository,
    restore: restorePendingRepository,
  };
  const waiting = data.live.length;

  return (
    <Page className="flex flex-col gap-5">
      <ProjectsHeader active="repositories" projectCount={all.length} pendingCount={waiting} />

      <ResultAlerts created={singleParam(params['created'])} error={singleParam(params['error'])} />

      {ignoredView ? (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
              Ignored repositories stop asking for a project. Agents working in them keep saving
              their memory in default.
            </p>
            <Button asChild variant="ghost" size="sm">
              <Link href={PATH}>
                <ArrowLeft aria-hidden="true" />
                Back to repositories
              </Link>
            </Button>
          </div>
          <section aria-label="Ignored repositories" className={CARD}>
            {data.discarded.length === 0 ? (
              <p className="px-5 py-8 text-center text-sm text-muted-foreground">
                No repository is ignored.
              </p>
            ) : (
              <IgnoredRepositoryList rows={data.discarded} actions={actions} csrf={csrf} />
            )}
          </section>
        </>
      ) : (
        <>
          <section className="flex flex-wrap items-center gap-x-8 gap-y-3">
            <p className="max-w-2xl min-w-0 flex-[1_1_420px] text-[15px] leading-6 text-muted-foreground">
              <span className="font-medium text-foreground">
                Connect each git repository to a project.
              </span>{' '}
              Whatever agents learn while working in that repository is then saved in, and recalled
              from, that project. A repository with no project saves into default.
            </p>
            <div aria-hidden="true" className="flex shrink-0 items-center gap-2.5">
              <TonePill tone="dim">repository</TonePill>
              <ArrowRight className="size-4 text-primary" />
              <TonePill tone="lime">project</TonePill>
            </div>
          </section>

          <section aria-labelledby="waiting-repositories" className={CARD}>
            <div className="flex flex-col gap-1 px-5 pt-5 pb-4">
              <h2
                id="waiting-repositories"
                className="flex items-center gap-2.5 text-base font-semibold text-foreground"
              >
                <span
                  aria-hidden="true"
                  className={
                    waiting > 0 ? 'size-2 rounded-full bg-warn' : 'size-2 rounded-full bg-primary'
                  }
                />
                {waiting === 0
                  ? 'Every repository has a project'
                  : waiting === 1
                    ? '1 repository needs a project'
                    : `${waiting} repositories need a project`}
              </h2>
              <p className="text-sm text-muted-foreground">
                {waiting === 0
                  ? 'A new one shows up here the first time an agent works in it.'
                  : 'Agents have worked in these. Until you choose, their memory is saved in default, mixed with everything else.'}
              </p>
            </div>
            {waiting === 0 ? null : (
              <div className="border-t border-border">
                <NeedsProjectList
                  rows={data.live}
                  projects={projects}
                  actions={actions}
                  csrf={csrf}
                  create={{
                    action: createProject,
                    csrf: await dashboardCsrfToken(CREATE_FORM),
                    returnTo: PATH,
                  }}
                />
              </div>
            )}
          </section>

          <ConnectedRepositoryList
            rows={data.connected}
            projects={projects}
            actions={actions}
            csrf={csrf}
          />

          <p className="text-xs leading-5 text-muted-foreground">
            A waiting repository no agent opens for 14 days leaves the list on its own.{' '}
            {data.discarded.length > 0 ? (
              <Link
                href={`${PATH}?view=ignored`}
                className="text-foreground underline underline-offset-4 hover:text-primary"
              >
                {data.discarded.length === 1
                  ? 'Show 1 ignored repository'
                  : `Show ${data.discarded.length} ignored repositories`}
              </Link>
            ) : null}
          </p>
        </>
      )}
    </Page>
  );
}
