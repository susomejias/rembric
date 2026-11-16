'use client';

import { Check, GitBranch, RotateCcw } from 'lucide-react';
import { useState } from 'react';

import { ActionForm, type FormAction } from '@/components/dashboard/action-form';
import {
  BindChoice,
  KindPill,
  PendingMeta,
  ProjectSelect,
  isConflict,
  pendingReason,
  repositoryName,
  suggestedSlug,
  type PendingRepository,
  type ProjectRef,
  type RepositoryActions,
  type RepositoryCsrf,
} from '@/components/dashboard/repositories-section';
import { Time } from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { SelectItem, SelectSeparator } from '@/components/ui/select';

const NEW_PROJECT = '__new';
const SLUG_PATTERN = '[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?';

export interface CreateProjectBinding {
  readonly action: FormAction;
  readonly csrf: string | null;
  readonly returnTo: string;
}

export function NeedsProjectList({
  rows,
  projects,
  actions,
  csrf,
  create,
}: {
  rows: readonly PendingRepository[];
  projects: readonly ProjectRef[];
  actions: RepositoryActions;
  csrf: RepositoryCsrf;
  create: CreateProjectBinding;
}) {
  return (
    <ul className="flex flex-col" aria-label="Repositories that need a project">
      {rows.map((row) => (
        <PendingRepositoryRow
          key={row.id}
          row={row}
          projects={projects}
          actions={actions}
          csrf={csrf}
          create={create}
        />
      ))}
    </ul>
  );
}

function initialChoice(row: PendingRepository, projects: readonly ProjectRef[]): string {
  if (row.project === null) return '';
  return projects.some((p) => p.id === row.project?.id) ? row.project.id : '';
}

function PendingRepositoryRow({
  row,
  projects,
  actions,
  csrf,
  create,
}: {
  row: PendingRepository;
  projects: readonly ProjectRef[];
  actions: RepositoryActions;
  csrf: RepositoryCsrf;
  create: CreateProjectBinding;
}) {
  const name = repositoryName(row);
  const [choice, setChoice] = useState(() => initialChoice(row, projects));
  const [slug, setSlug] = useState(() => suggestedSlug(row));
  const trustsRemote = row.kind === 'unknown_remote' && choice === row.project?.id;
  const conflicts =
    choice === '' || choice === NEW_PROJECT ? [] : row.bindings.filter((b) => b.id !== choice);
  const keepLabel = isConflict(row)
    ? `Keep ${row.bindings
        .filter((b) => b.id !== row.project?.id)
        .map((b) => b.slug)
        .join(', ')}`
    : 'Ignore';

  return (
    <li
      data-pending-kind={row.kind}
      className="flex flex-col gap-4 border-t border-border px-5 py-4 first:border-t-0 lg:flex-row lg:items-start lg:justify-between"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <GitBranch aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-all text-[15px] font-medium text-foreground">{name}</span>
          <KindPill row={row} />
        </div>
        <p className="text-sm leading-6 text-muted-foreground">{pendingReason(row)}</p>
        <PendingMeta row={row} />
      </div>

      <div className="flex w-full flex-col gap-2 lg:w-[440px] lg:shrink-0">
        <div className="flex flex-wrap items-start gap-2">
          <ProjectSelect
            projects={projects}
            value={choice}
            onValueChange={setChoice}
            label={`Project for ${name}`}
            className="flex-[1_1_200px]"
            extra={
              <>
                <SelectSeparator />
                <SelectItem value={NEW_PROJECT}>New project…</SelectItem>
              </>
            }
          />
          {choice === NEW_PROJECT || conflicts.length > 0 ? null : trustsRemote ? (
            <ActionForm action={actions.acceptRemotes} className="flex">
              <input type="hidden" name="csrf" value={csrf.acceptRemotes ?? ''} />
              <input type="hidden" name="pendingId" value={row.id} />
              <Button type="submit">
                <Check aria-hidden="true" />
                Connect
              </Button>
            </ActionForm>
          ) : (
            <ActionForm action={actions.bind} className="flex">
              <input type="hidden" name="csrf" value={csrf.bind ?? ''} />
              <input type="hidden" name="pendingId" value={row.id} />
              <input type="hidden" name="projectId" value={choice} />
              <Button type="submit" disabled={choice === ''}>
                <Check aria-hidden="true" />
                Connect
              </Button>
            </ActionForm>
          )}
          <ActionForm action={actions.discard} className="flex">
            <input type="hidden" name="csrf" value={csrf.discard ?? ''} />
            <input type="hidden" name="pendingId" value={row.id} />
            <Button type="submit" variant="ghost">
              {keepLabel}
            </Button>
          </ActionForm>
        </div>

        {trustsRemote ? (
          <p className="text-xs leading-5 text-muted-foreground">
            Connecting trusts {row.unseenRemotes.join(', ')} as a remote of {row.project?.slug}.
          </p>
        ) : null}

        {conflicts.length > 0 ? (
          <ActionForm action={actions.bind} className="flex">
            <input type="hidden" name="csrf" value={csrf.bind ?? ''} />
            <input type="hidden" name="pendingId" value={row.id} />
            <input type="hidden" name="projectId" value={choice} />
            <BindChoice conflicts={conflicts} label="Connect" />
          </ActionForm>
        ) : null}

        {choice === NEW_PROJECT ? (
          <ActionForm action={create.action} className="flex flex-col gap-2">
            <input type="hidden" name="csrf" value={create.csrf ?? ''} />
            <input type="hidden" name="pendingId" value={row.id} />
            <input type="hidden" name="returnTo" value={create.returnTo} />
            <div className="flex items-start gap-2">
              <Input
                name="slug"
                aria-label="New project slug"
                required
                pattern={SLUG_PATTERN}
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                className="font-mono"
              />
              <Button type="submit">Create and connect</Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Lowercase letters, digits and dashes. Agents address the project by this slug.
            </p>
          </ActionForm>
        ) : null}
      </div>
    </li>
  );
}

export function IgnoredRepositoryList({
  rows,
  actions,
  csrf,
}: {
  rows: readonly PendingRepository[];
  actions: RepositoryActions;
  csrf: RepositoryCsrf;
}) {
  return (
    <ul className="flex flex-col" aria-label="Ignored repositories">
      {rows.map((row) => (
        <li
          key={row.id}
          data-pending-kind={row.kind}
          className="flex flex-col gap-3 border-t border-border px-5 py-4 first:border-t-0 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex min-w-0 flex-col gap-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <GitBranch aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 break-all text-[15px] font-medium text-foreground">
                {repositoryName(row)}
              </span>
              <KindPill row={row} />
            </div>
            <p className="font-mono text-[11px] text-muted-foreground">
              fingerprint {row.fingerprintPrefix} · seen by{' '}
              {row.tokens.length > 0 ? row.tokens.join(', ') : 'no remaining token'}
              {row.discardedAt === null ? null : (
                <>
                  {' '}
                  · ignored <Time value={row.discardedAt} />
                </>
              )}
            </p>
          </div>
          <ActionForm action={actions.restore} className="flex">
            <input type="hidden" name="csrf" value={csrf.restore ?? ''} />
            <input type="hidden" name="pendingId" value={row.id} />
            <Button type="submit" variant="outline" size="sm">
              <RotateCcw aria-hidden="true" />
              Restore
            </Button>
          </ActionForm>
        </li>
      ))}
    </ul>
  );
}
