'use client';

import { ActionForm } from '@/components/dashboard/action-form';
import {
  BindChoice,
  ItemName,
  KindPill,
  SELECT_CLASS,
  isConflict,
  repositoryName,
  type PendingRepository,
  type ProjectRef,
  type RepositoryActions,
  type RepositoryCsrf,
} from '@/components/dashboard/repositories-section';
import { Time } from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';

export function pendingDescription(row: PendingRepository): string {
  const others = row.bindings.filter((b) => b.id !== row.project?.id).map((b) => b.slug);
  if (row.kind === 'unknown_remote') {
    return `Bound to ${row.project?.slug ?? 'a project'}, which has never seen ${row.unseenRemotes.join(', ')}.`;
  }
  if (row.kind === 'suggestion') {
    const target = row.project?.slug ?? 'a project';
    return isConflict(row)
      ? `Bound to ${others.join(', ')}; a root .rembric selects ${target}.`
      : `A root .rembric selects ${target}.`;
  }
  return others.length > 0
    ? `Bound to ${others.join(', ')}, which the sighting tokens cannot read.`
    : 'No project is bound to this repository.';
}

export function PendingRepositoryList({
  rows,
  projects,
  actions,
  csrf,
  discarded,
}: {
  rows: readonly PendingRepository[];
  projects: readonly ProjectRef[];
  actions: RepositoryActions;
  csrf: RepositoryCsrf;
  discarded: boolean;
}) {
  if (rows.length === 0) {
    return (
      <div className="rounded-[16px] border border-border bg-card px-5 py-10 text-center text-sm text-muted-foreground">
        {discarded ? 'NO DISCARDED REPOSITORY' : 'NO PENDING REPOSITORY'}
      </div>
    );
  }
  return (
    <ul
      className="flex flex-col gap-3"
      aria-label={discarded ? 'Discarded repositories' : 'Pending repositories'}
    >
      {rows.map((row) => (
        <PendingRepositoryCard
          key={row.id}
          row={row}
          projects={projects}
          actions={actions}
          csrf={csrf}
          discarded={discarded}
        />
      ))}
    </ul>
  );
}

function PendingRepositoryCard({
  row,
  projects,
  actions,
  csrf,
  discarded,
}: {
  row: PendingRepository;
  projects: readonly ProjectRef[];
  actions: RepositoryActions;
  csrf: RepositoryCsrf;
  discarded: boolean;
}) {
  const name = repositoryName(row);
  return (
    <li
      data-pending-kind={row.kind}
      className="flex flex-col gap-4 rounded-[16px] border border-border bg-card p-4 sm:flex-row sm:items-start sm:justify-between"
    >
      <div className="flex min-w-0 flex-col gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <KindPill row={row} />
        </div>
        <ItemName name={name} prefix={row.fingerprintPrefix} />
        <p className="text-sm text-foreground">{pendingDescription(row)}</p>
        <p className="text-xs text-muted-foreground">
          Sighted by {row.tokens.length > 0 ? row.tokens.join(', ') : 'no remaining token'}
        </p>
        <p className="font-mono text-[11px] text-muted-foreground">
          first <Time value={row.firstSeenAt} /> · last <Time value={row.lastSeenAt} />
          {row.discardedAt === null ? null : (
            <>
              {' '}
              · discarded <Time value={row.discardedAt} />
            </>
          )}
        </p>
      </div>

      <div className="flex min-w-0 flex-col gap-3 sm:w-72 sm:shrink-0">
        {discarded ? (
          <ActionForm action={actions.restore} className="flex">
            <input type="hidden" name="csrf" value={csrf.restore ?? ''} />
            <input type="hidden" name="pendingId" value={row.id} />
            <Button type="submit" size="sm">
              Restore
            </Button>
          </ActionForm>
        ) : (
          <>
            {row.kind === 'unknown_remote' ? (
              <ActionForm action={actions.acceptRemotes} className="flex">
                <input type="hidden" name="csrf" value={csrf.acceptRemotes ?? ''} />
                <input type="hidden" name="pendingId" value={row.id} />
                <Button type="submit" size="sm">
                  Accept remote into {row.project?.slug ?? 'its binding'}
                </Button>
              </ActionForm>
            ) : null}
            {row.kind === 'suggestion' && row.project !== null ? (
              <ActionForm action={actions.bind} className="flex flex-col gap-2">
                <input type="hidden" name="csrf" value={csrf.bind ?? ''} />
                <input type="hidden" name="pendingId" value={row.id} />
                <input type="hidden" name="projectId" value={row.project.id} />
                <BindChoice
                  conflicts={row.bindings.filter((b) => b.id !== row.project?.id)}
                  label={`Bind to ${row.project.slug}`}
                />
              </ActionForm>
            ) : (
              <ActionForm action={actions.bind} className="flex flex-col gap-2">
                <input type="hidden" name="csrf" value={csrf.bind ?? ''} />
                <input type="hidden" name="pendingId" value={row.id} />
                <select
                  name="projectId"
                  required
                  defaultValue=""
                  aria-label={`Project to bind ${name} to`}
                  className={SELECT_CLASS}
                >
                  <option value="" disabled>
                    {row.kind === 'unknown_remote' ? 'Another project…' : 'Choose a project…'}
                  </option>
                  {projects
                    .filter((p) => p.id !== row.project?.id)
                    .map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.slug}
                      </option>
                    ))}
                </select>
                <BindChoice conflicts={row.bindings} label="Bind" />
              </ActionForm>
            )}
            <ActionForm action={actions.discard} className="flex">
              <input type="hidden" name="csrf" value={csrf.discard ?? ''} />
              <input type="hidden" name="pendingId" value={row.id} />
              <Button type="submit" size="sm" variant="ghost" className="text-muted-foreground">
                Discard
              </Button>
            </ActionForm>
          </>
        )}
      </div>
    </li>
  );
}
