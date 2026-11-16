'use client';

import { AlertTriangle, GitBranch } from 'lucide-react';
import { useActionState, useEffect, useState, type ReactNode } from 'react';

import {
  FINGERPRINT_FORMAT_MESSAGE,
  FINGERPRINT_PATTERN,
} from '@/app/dashboard/projects/repository-forms';
import { ActionForm, type ActionState, type FormAction } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import { LABEL, Time, TonePill, type Tone } from '@/components/dashboard/ui';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

export interface ConnectedRepository extends BoundRepository {
  readonly project: ProjectRef;
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

export function repositoryName(row: {
  readonly remotes: readonly string[];
  readonly rootName?: string | null;
  readonly fingerprintPrefix?: string;
}): string {
  if (row.remotes.length > 0) return row.remotes.join(', ');
  if (row.rootName) return row.rootName;
  return row.fingerprintPrefix
    ? `repository ${row.fingerprintPrefix}`
    : 'repository without remote';
}

export function isConflict(row: PendingRepository): boolean {
  return row.kind === 'suggestion' && row.bindings.some((b) => b.id !== row.project?.id);
}

export function suggestedSlug(row: {
  readonly remotes: readonly string[];
  readonly rootName: string | null;
}): string {
  const source = row.rootName ?? row.remotes[0]?.split('/').pop() ?? '';
  return source
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
}

const KIND: Record<string, { label: string; tone: Tone }> = {
  unbound: { label: 'new', tone: 'dim' },
  suggestion: { label: 'suggested', tone: 'lime' },
  conflict: { label: 'conflict', tone: 'amber' },
  unknown_remote: { label: 'new remote', tone: 'amber' },
};

export function KindPill({ row }: { row: PendingRepository }) {
  const kind = KIND[isConflict(row) ? 'conflict' : row.kind]!;
  return <TonePill tone={kind.tone}>{kind.label}</TonePill>;
}

export function pendingReason(row: PendingRepository): string {
  const others = row.bindings.filter((b) => b.id !== row.project?.id).map((b) => b.slug);
  const target = row.project?.slug ?? 'a project';
  if (row.kind === 'unknown_remote') {
    return `Same repository as one connected to ${target}, but seen at ${row.unseenRemotes.join(', ')}, a remote ${target} has never seen. It may be a fork.`;
  }
  if (row.kind === 'suggestion') {
    return isConflict(row)
      ? `Connected to ${others.join(', ')}, but its .rembric file asks for ${target}.`
      : `Its .rembric file asks for ${target}.`;
  }
  return others.length > 0
    ? `Connected to ${others.join(', ')}, which the agents that saw it cannot reach.`
    : 'New: no project yet, so its memory is saved in default.';
}

export function PendingMeta({ row }: { row: PendingRepository }) {
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 gap-y-1 font-mono text-[11px] text-muted-foreground">
      <span>fingerprint {row.fingerprintPrefix}</span>
      <span aria-hidden="true">·</span>
      <span>seen by {row.tokens.length > 0 ? row.tokens.join(', ') : 'no remaining token'}</span>
      <span aria-hidden="true">·</span>
      <span>
        first <Time value={row.firstSeenAt} />
      </span>
      <span aria-hidden="true">·</span>
      <span>
        last <Time value={row.lastSeenAt} />
      </span>
    </p>
  );
}

export function BindChoice({
  conflicts,
  label,
  disabled = false,
}: {
  conflicts: readonly ProjectRef[];
  label: string;
  disabled?: boolean;
}) {
  if (conflicts.length === 0) {
    return (
      <Button type="submit" disabled={disabled}>
        {label}
      </Button>
    );
  }
  return (
    <div className="flex w-full flex-col gap-2" data-bind-choice>
      <p className="text-xs leading-5 text-muted-foreground">
        This repository already feeds{' '}
        <span className="text-foreground">{conflicts.map((c) => c.slug).join(', ')}</span>. Move it,
        or keep both projects: an agent whose token reaches both then hits an ambiguity and must
        pick one with a .rembric file.
      </p>
      <div className="flex flex-wrap gap-2">
        {conflicts.map((c) => (
          <Button key={c.id} type="submit" name="moveFrom" value={c.id} disabled={disabled}>
            Move from {c.slug}
          </Button>
        ))}
        <Button type="submit" variant="outline" name="choice" value="add" disabled={disabled}>
          Keep both
        </Button>
      </div>
    </div>
  );
}

export function ProjectSelect({
  projects,
  value,
  onValueChange,
  placeholder = 'Choose a project…',
  label,
  extra,
  className,
}: {
  projects: readonly ProjectRef[];
  value: string;
  onValueChange: (value: string) => void;
  placeholder?: string;
  label: string;
  extra?: ReactNode;
  className?: string;
}) {
  return (
    <Select value={value === '' ? undefined : value} onValueChange={onValueChange}>
      <SelectTrigger aria-label={label} className={cn('w-full min-w-0', className)}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {projects.map((p) => (
          <SelectItem key={p.id} value={p.id}>
            {p.slug}
          </SelectItem>
        ))}
        {extra}
      </SelectContent>
    </Select>
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
      <div className="flex flex-col gap-1">
        <h3 id={`repositories-${project.id}`} className="text-sm font-semibold text-foreground">
          Repositories
        </h3>
        <p className="text-xs leading-5 text-muted-foreground">
          Agents working in these git repositories save and recall memory in {project.slug}.
        </p>
      </div>

      {data.conflicts.map((row) => (
        <Alert key={row.id} variant="warn" data-repository-conflict>
          <AlertTriangle aria-hidden="true" />
          <AlertDescription>
            A checkout of {repositoryName(row)} asks for {row.project?.slug ?? 'another project'}{' '}
            through its root .rembric, while the repository is connected here.
          </AlertDescription>
        </Alert>
      ))}

      <Group title="Connected">
        {data.bound.length === 0 ? (
          <Empty>No repository is connected to this project yet.</Empty>
        ) : (
          <ul className="flex flex-col gap-2">
            {data.bound.map((binding) => (
              <Item key={binding.fingerprint}>
                <ItemName name={repositoryName(binding)} prefix={binding.fingerprintPrefix} />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    Connected <Time value={binding.createdAt} className="font-mono" /> by{' '}
                    {binding.createdBy}
                  </p>
                  <ActionForm action={actions.remove} className="flex">
                    <input type="hidden" name="csrf" value={csrf.remove ?? ''} />
                    <input type="hidden" name="fingerprint" value={binding.fingerprint} />
                    <input type="hidden" name="projectId" value={project.id} />
                    <ConfirmSubmit
                      tone="warn"
                      title={`Disconnect ${repositoryName(binding)}?`}
                      description={`Memories and sessions already written stay in ${project.slug}. Later sessions from this repository stop resolving here and use the default project.`}
                      confirmLabel="Disconnect"
                    >
                      <Button type="button" variant="warn" size="sm">
                        Disconnect
                      </Button>
                    </ConfirmSubmit>
                  </ActionForm>
                </div>
              </Item>
            ))}
          </ul>
        )}
      </Group>

      {project.archived ? (
        <Empty>An archived project accepts no new repository.</Empty>
      ) : (
        <>
          <Group title="Waiting for a project">
            {data.pending.length === 0 ? (
              <Empty>No repository is waiting.</Empty>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.pending.map((row) => (
                  <Item key={row.id}>
                    <div className="flex flex-wrap items-center gap-2">
                      <KindPill row={row} />
                    </div>
                    <ItemName name={repositoryName(row)} prefix={row.fingerprintPrefix} />
                    <p className="text-xs leading-5 text-muted-foreground">{pendingReason(row)}</p>
                    {row.kind === 'unknown_remote' && row.project?.id === project.id ? (
                      <ActionForm action={actions.acceptRemotes} className="flex">
                        <input type="hidden" name="csrf" value={csrf.acceptRemotes ?? ''} />
                        <input type="hidden" name="pendingId" value={row.id} />
                        <Button type="submit" size="sm">
                          Trust remote
                        </Button>
                      </ActionForm>
                    ) : (
                      <ActionForm action={actions.bind} className="flex">
                        <input type="hidden" name="csrf" value={csrf.bind ?? ''} />
                        <input type="hidden" name="pendingId" value={row.id} />
                        <input type="hidden" name="projectId" value={project.id} />
                        <BindChoice
                          conflicts={row.bindings.filter((b) => b.id !== project.id)}
                          label="Connect here"
                        />
                      </ActionForm>
                    )}
                  </Item>
                ))}
              </ul>
            )}
          </Group>

          <Group title="Connect by fingerprint">
            <FingerprintBindForm projectId={project.id} action={actions.bind} csrf={csrf.bind} />
          </Group>
        </>
      )}
    </section>
  );
}

export function FingerprintBindForm({
  projectId,
  projects,
  action,
  csrf,
  onBound,
}: {
  projectId?: string;
  projects?: readonly ProjectRef[];
  action: BindAction;
  csrf: string | null;
  onBound?: () => void;
}) {
  const [state, dispatch, pending] = useActionState(action, { error: null } as BindState);
  const [value, setValue] = useState('');
  const [chosen, setChosen] = useState('');
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    if (!submitted || pending) return;
    setSubmitted(false);
    if (state.error !== null) return;
    setValue('');
    onBound?.();
  }, [state, pending, submitted, onBound]);
  const target = projectId ?? chosen;
  const inputId = `repository-fingerprint-${projectId ?? 'any'}`;

  return (
    <form
      action={(formData) => {
        setSubmitted(true);
        dispatch(formData);
      }}
      className="flex flex-col gap-3"
    >
      {state.error === null ? null : (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertDescription>{state.error}</AlertDescription>
        </Alert>
      )}
      <input type="hidden" name="csrf" value={csrf ?? ''} />
      <input type="hidden" name="projectId" value={target} />
      <div className="flex flex-col gap-2">
        <Label htmlFor={inputId} className={projects === undefined ? 'sr-only' : undefined}>
          Root commit
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
      </div>
      {projects === undefined ? null : (
        <div className="flex flex-col gap-2">
          <Label>Project</Label>
          <ProjectSelect
            projects={projects}
            value={chosen}
            onValueChange={setChosen}
            label="Project to connect the repository to"
          />
        </div>
      )}
      <div
        className={cn(
          'flex',
          projects !== undefined && 'justify-end',
          pending && 'pointer-events-none opacity-60',
        )}
      >
        <BindChoice
          conflicts={state.conflict?.bound ?? []}
          label="Connect"
          disabled={target === ''}
        />
      </div>
    </form>
  );
}

export function FingerprintHint({ id }: { id: string }) {
  return (
    <p id={id} className="text-xs leading-5 text-muted-foreground">
      {FINGERPRINT_FORMAT_MESSAGE} Print it in the repository with{' '}
      <code className="rounded-md bg-muted px-1 py-0.5 font-mono text-foreground">
        git rev-list --first-parent --max-parents=0 HEAD
      </code>
      .
    </p>
  );
}

export function CreateRepositoryFields({ pending }: { pending: readonly PendingRepository[] }) {
  return (
    <fieldset className="flex flex-col gap-3 border-t border-border pt-4">
      <legend className="mb-1 text-sm font-semibold text-foreground">Repositories</legend>
      <p className="text-xs text-muted-foreground">
        Optional. Connected right after the project is created.
      </p>
      {pending.map((row) => (
        <div key={row.id} className="flex items-start gap-2.5">
          <Checkbox
            id={`create-pending-${row.id}`}
            name="pendingId"
            value={row.id}
            className="mt-0.5"
          />
          <Label
            htmlFor={`create-pending-${row.id}`}
            className="flex min-w-0 flex-col items-start gap-0.5 font-normal"
          >
            <span className="break-all font-mono text-xs text-foreground">
              {repositoryName(row)}
            </span>
            <span className="font-mono text-[11px] text-muted-foreground">
              fingerprint {row.fingerprintPrefix}
            </span>
          </Label>
        </div>
      ))}
      <Label htmlFor="project-create-fingerprint" className={cn(LABEL, 'text-muted-foreground')}>
        Connect by fingerprint
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
      <h4 className={cn(LABEL, 'text-muted-foreground')}>{title}</h4>
      <div className="flex flex-col gap-2">{children}</div>
    </div>
  );
}

function Item({ children }: { children: ReactNode }) {
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-border bg-background/40 p-3">
      {children}
    </li>
  );
}

export function ItemName({ name, prefix }: { name: string; prefix: string }) {
  return (
    <div className="flex min-w-0 items-start gap-2">
      <GitBranch aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="break-all text-sm font-medium text-foreground">{name}</span>
        <span className="font-mono text-[11px] text-muted-foreground">fingerprint {prefix}</span>
      </div>
    </div>
  );
}

function Empty({ children }: { children: ReactNode }) {
  return <p className="text-xs text-muted-foreground">{children}</p>;
}
