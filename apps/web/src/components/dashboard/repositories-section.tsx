'use client';

import { useActionState, useEffect, useState, type ReactNode } from 'react';

import {
  FINGERPRINT_FORMAT_MESSAGE,
  FINGERPRINT_PATTERN,
} from '@/app/dashboard/projects/repository-forms';
import { ActionForm, type ActionState, type FormAction } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { Flash, LABEL, Notice, Pill, Time } from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export interface ProjectRef {
  readonly id: string;
  readonly slug: string;
}

export interface BoundRepository {
  readonly fingerprint: string;
  readonly fingerprintPrefix: string;
  readonly remotes: readonly string[];
  readonly createdAt: Date;
  readonly createdBy: string;
}

export type PendingRepositoryKind = 'unbound' | 'suggestion' | 'unknown_remote';

export interface PendingRepository {
  readonly id: string;
  readonly kind: PendingRepositoryKind;
  readonly fingerprint: string;
  readonly fingerprintPrefix: string;
  readonly remotes: readonly string[];
  readonly rootName: string | null;
  readonly project: ProjectRef | null;
  readonly unseenRemotes: readonly string[];
  readonly bindings: readonly ProjectRef[];
  readonly tokens: readonly string[];
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly discardedAt: Date | null;
}

export interface ProjectRepositories {
  readonly bound: readonly BoundRepository[];
  readonly pending: readonly PendingRepository[];
  readonly conflicts: readonly PendingRepository[];
}

export type BindState = ActionState & { conflict?: { bound: ProjectRef[] } };
export type BindAction = (state: BindState, formData: FormData) => Promise<BindState>;

export interface RepositoryActions {
  readonly bind: BindAction;
  readonly remove: FormAction;
  readonly acceptRemotes: FormAction;
  readonly discard: FormAction;
  readonly restore: FormAction;
}

export interface RepositoryCsrf {
  readonly bind: string | null;
  readonly remove: string | null;
  readonly acceptRemotes: string | null;
  readonly discard: string | null;
  readonly restore: string | null;
}

export const SELECT_CLASS =
  'h-8 min-w-0 flex-1 rounded-[12px] border border-input bg-input/30 px-2.5 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

export function repositoryName(row: {
  readonly remotes: readonly string[];
  readonly rootName?: string | null;
}): string {
  if (row.remotes.length > 0) return row.remotes.join(', ');
  return row.rootName ?? 'no remote';
}

export function isConflict(row: PendingRepository): boolean {
  return row.kind === 'suggestion' && row.bindings.some((b) => b.id !== row.project?.id);
}

export function KindPill({ row }: { row: PendingRepository }) {
  if (row.kind === 'unknown_remote') return <Pill tone="amber">unknown remote</Pill>;
  if (row.kind === 'suggestion') {
    return isConflict(row) ? (
      <Pill tone="amber">conflict</Pill>
    ) : (
      <Pill tone="lime">suggestion</Pill>
    );
  }
  return <Pill tone="dim">unbound</Pill>;
}

export function BindChoice({
  conflicts,
  label,
}: {
  conflicts: readonly ProjectRef[];
  label: string;
}) {
  if (conflicts.length === 0) {
    return (
      <Button type="submit" size="sm" className="w-fit">
        {label}
      </Button>
    );
  }
  return (
    <div className="flex flex-col gap-2" data-bind-choice>
      <p className="text-xs text-warn">
        Already bound to {conflicts.map((c) => c.slug).join(', ')}. Move that binding, or add a
        second one: tokens that reach both projects then get an ambiguity and must select a project
        with a .rembric file.
      </p>
      <div className="flex flex-wrap gap-2">
        {conflicts.map((c) => (
          <Button key={c.id} type="submit" size="sm" name="moveFrom" value={c.id}>
            Move from {c.slug}
          </Button>
        ))}
        <Button type="submit" size="sm" variant="outline" name="choice" value="add">
          Add a second binding
        </Button>
      </div>
    </div>
  );
}

export function RepositoriesSection({
  project,
  data,
  actions,
  csrf,
}: {
  project: ProjectRef & { readonly archived: boolean };
  data: ProjectRepositories;
  actions: RepositoryActions;
  csrf: RepositoryCsrf;
}) {
  return (
    <section
      aria-labelledby={`repositories-${project.id}`}
      className="flex flex-col gap-5 border-t border-border px-4 py-5"
    >
      <h3 id={`repositories-${project.id}`} className={cn(LABEL, 'text-muted-foreground')}>
        Repositories
      </h3>

      {data.conflicts.map((row) => (
        <Notice key={row.id} tone="amber" badge="conflict">
          A checkout of {repositoryName(row)} selects {row.project?.slug ?? 'another project'}{' '}
          through its root .rembric, while the repository is bound here.
        </Notice>
      ))}

      <Group title="Bound">
        {data.bound.length === 0 ? (
          <Empty>No repository is bound to this project.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.bound.map((binding) => (
              <Item key={binding.fingerprint}>
                <ItemName name={repositoryName(binding)} prefix={binding.fingerprintPrefix} />
                <p className="text-xs text-muted-foreground">
                  Bound <Time value={binding.createdAt} className="font-mono" /> by{' '}
                  {binding.createdBy}
                </p>
                <ActionForm action={actions.remove} className="flex">
                  <input type="hidden" name="csrf" value={csrf.remove ?? ''} />
                  <input type="hidden" name="fingerprint" value={binding.fingerprint} />
                  <input type="hidden" name="projectId" value={project.id} />
                  <ConfirmSubmit
                    tone="warn"
                    title={`Unbind ${repositoryName(binding)}?`}
                    description={`Memories and sessions already written stay in ${project.slug}. Later sessions from this repository stop resolving here.`}
                    confirmLabel="UNBIND"
                  >
                    <Button type="button" variant="ghost" size="sm" className="text-warn">
                      Unbind
                    </Button>
                  </ConfirmSubmit>
                </ActionForm>
              </Item>
            ))}
          </ul>
        )}
      </Group>

      {project.archived ? (
        <Empty>An archived project accepts no new binding.</Empty>
      ) : (
        <>
          <Group title="Pending">
            {data.pending.length === 0 ? (
              <Empty>No pending repository.</Empty>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.pending.map((row) => (
                  <Item key={row.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <KindPill row={row} />
                    </div>
                    <ItemName name={repositoryName(row)} prefix={row.fingerprintPrefix} />
                    {row.kind === 'unknown_remote' && row.project?.id === project.id ? (
                      <ActionForm action={actions.acceptRemotes} className="flex flex-col gap-2">
                        <input type="hidden" name="csrf" value={csrf.acceptRemotes ?? ''} />
                        <input type="hidden" name="pendingId" value={row.id} />
                        <p className="text-xs text-muted-foreground">
                          Unseen remote {row.unseenRemotes.join(', ')}.
                        </p>
                        <Button type="submit" size="sm" className="w-fit">
                          Accept remote
                        </Button>
                      </ActionForm>
                    ) : (
                      <ActionForm action={actions.bind} className="flex flex-col gap-2">
                        <input type="hidden" name="csrf" value={csrf.bind ?? ''} />
                        <input type="hidden" name="pendingId" value={row.id} />
                        <input type="hidden" name="projectId" value={project.id} />
                        <BindChoice
                          conflicts={row.bindings.filter((b) => b.id !== project.id)}
                          label="Bind here"
                        />
                      </ActionForm>
                    )}
                  </Item>
                ))}
              </ul>
            )}
          </Group>

          <Group title="Bind by fingerprint">
            <FingerprintBindForm projectId={project.id} action={actions.bind} csrf={csrf.bind} />
          </Group>
        </>
      )}
    </section>
  );
}

export function FingerprintBindForm({
  projectId,
  action,
  csrf,
}: {
  projectId: string;
  action: BindAction;
  csrf: string | null;
}) {
  const [state, dispatch, pending] = useActionState(action, { error: null } as BindState);
  const [value, setValue] = useState('');
  useEffect(() => {
    if (state.error === null) setValue('');
  }, [state]);
  const inputId = `repository-fingerprint-${projectId}`;

  return (
    <form action={dispatch} className="flex flex-col gap-2">
      {state.error === null ? null : (
        <Flash tone="danger" label="ERROR">
          {state.error}
        </Flash>
      )}
      <input type="hidden" name="csrf" value={csrf ?? ''} />
      <input type="hidden" name="projectId" value={projectId} />
      <Label htmlFor={inputId} className="sr-only">
        Repository fingerprint
      </Label>
      <Input
        id={inputId}
        name="fingerprint"
        required
        pattern={FINGERPRINT_PATTERN}
        title={FINGERPRINT_FORMAT_MESSAGE}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="root commit hash"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="font-mono"
        aria-describedby={`${inputId}-hint`}
      />
      <FingerprintHint id={`${inputId}-hint`} />
      <div className={cn(pending && 'pointer-events-none opacity-60')}>
        <BindChoice conflicts={state.conflict?.bound ?? []} label="Bind" />
      </div>
    </form>
  );
}

export function FingerprintHint({ id }: { id: string }) {
  return (
    <p id={id} className="text-xs text-muted-foreground">
      {FINGERPRINT_FORMAT_MESSAGE} Print it in the repository with{' '}
      <code className="font-mono">git rev-list --first-parent --max-parents=0 HEAD</code>.
    </p>
  );
}

export function CreateRepositoryFields({ pending }: { pending: readonly PendingRepository[] }) {
  return (
    <fieldset className="flex flex-col gap-3 border-t border-border pt-4">
      <legend className={cn(LABEL, 'mb-2 text-muted-foreground')}>Repositories</legend>
      <p className="text-xs text-muted-foreground">
        Optional. Bound right after the project is created.
      </p>
      {pending.map((row) => (
        <label key={row.id} className="flex items-start gap-2 text-sm">
          <input
            type="checkbox"
            name="pendingId"
            value={row.id}
            className="mt-1 size-4 accent-primary"
          />
          <span className="flex min-w-0 flex-col">
            <span className="break-all font-mono text-xs text-foreground">
              {repositoryName(row)}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              fingerprint {row.fingerprintPrefix}
            </span>
          </span>
        </label>
      ))}
      <Label htmlFor="project-create-fingerprint" className={cn(LABEL, 'text-muted-foreground')}>
        Bind by fingerprint
      </Label>
      <Input
        id="project-create-fingerprint"
        name="fingerprint"
        pattern={FINGERPRINT_PATTERN}
        title={FINGERPRINT_FORMAT_MESSAGE}
        placeholder="root commit hash (optional)"
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        className="font-mono"
        aria-describedby="project-create-fingerprint-hint"
      />
      <FingerprintHint id="project-create-fingerprint-hint" />
    </fieldset>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <h4 className={cn(LABEL, 'text-[10px] text-muted-foreground')}>{title}</h4>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function Item({ children }: { children: ReactNode }) {
  return (
    <li className="flex flex-col gap-2 rounded-[12px] border border-border bg-background/40 p-3">
      {children}
    </li>
  );
}

export function ItemName({ name, prefix }: { name: string; prefix: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="break-all font-mono text-xs text-foreground">{name}</span>
      <span className="font-mono text-[11px] text-muted-foreground">fingerprint {prefix}</span>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
