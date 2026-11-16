'use client';

import { ArrowRight, GitBranch, Plus, Search } from 'lucide-react';
import { useActionState, useEffect, useState } from 'react';

import { ActionForm } from '@/components/dashboard/action-form';
import { ConfirmSubmit } from '@/components/dashboard/confirm-submit';
import {
  FingerprintBindForm,
  ProjectSelect,
  repositoryName,
  type BindState,
  type ConnectedRepository,
  type ProjectRef,
  type RepositoryActions,
  type RepositoryCsrf,
} from '@/components/dashboard/repositories-section';
import { Time, TonePill } from '@/components/dashboard/ui';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';

export function ConnectedRepositoryList({
  rows,
  projects,
  actions,
  csrf,
}: {
  rows: readonly ConnectedRepository[];
  projects: readonly ProjectRef[];
  actions: RepositoryActions;
  csrf: RepositoryCsrf;
}) {
  const [query, setQuery] = useState('');
  const needle = query.trim().toLowerCase();
  const visible = rows.filter(
    (row) =>
      needle === '' || `${repositoryName(row)} ${row.project.slug}`.toLowerCase().includes(needle),
  );

  return (
    <section
      aria-labelledby="connected-repositories"
      className="overflow-hidden rounded-2xl border border-border bg-card shadow-lg shadow-black/20"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
        <h2
          id="connected-repositories"
          className="flex items-center gap-2.5 text-base font-semibold text-foreground"
        >
          <span aria-hidden="true" className="size-2 rounded-full bg-primary" />
          Connected
          <span className="font-mono text-xs font-normal text-muted-foreground">{rows.length}</span>
        </h2>
        <div className="flex w-full items-center gap-2 sm:w-auto">
          <div className="relative min-w-0 flex-1 sm:w-64 sm:flex-none">
            <Search
              aria-hidden="true"
              className="pointer-events-none absolute top-2 left-2.5 size-4 text-muted-foreground"
            />
            <Input
              type="search"
              aria-label="Search connected repositories"
              placeholder="Search repository or project…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              className="pl-8"
            />
          </div>
          <AddRepositoryDialog projects={projects} actions={actions} csrf={csrf} />
        </div>
      </div>
      {rows.length === 0 ? (
        <p className="border-t border-border px-5 py-8 text-center text-sm text-muted-foreground">
          No repository is connected yet. Connect one from the list above, or add it by hand.
        </p>
      ) : visible.length === 0 ? (
        <p className="border-t border-border px-5 py-8 text-center text-sm text-muted-foreground">
          No connected repository matches “{query.trim()}”.
        </p>
      ) : (
        <ul aria-label="Connected repositories" className="flex flex-col">
          {visible.map((row) => (
            <ConnectedRow
              key={`${row.fingerprint}:${row.project.id}`}
              row={row}
              projects={projects}
              actions={actions}
              csrf={csrf}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function ConnectedRow({
  row,
  projects,
  actions,
  csrf,
}: {
  row: ConnectedRepository;
  projects: readonly ProjectRef[];
  actions: RepositoryActions;
  csrf: RepositoryCsrf;
}) {
  const name = repositoryName(row);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(row.project.id);
  const [state, dispatch, pending] = useActionState(actions.bind, { error: null } as BindState);
  const [submitted, setSubmitted] = useState(false);
  useEffect(() => {
    if (!submitted || pending) return;
    setSubmitted(false);
    if (state.error === null) setEditing(false);
  }, [state, pending, submitted]);

  return (
    <li
      data-connected-repository={row.fingerprintPrefix}
      className="flex flex-col gap-3 border-t border-border px-5 py-4 lg:flex-row lg:items-center lg:justify-between"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <GitBranch aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="min-w-0 break-all text-[15px] font-medium text-foreground">{name}</span>
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">
          fingerprint {row.fingerprintPrefix} · connected <Time value={row.createdAt} /> by{' '}
          {row.createdBy}
        </p>
      </div>

      {editing ? (
        <div className="flex w-full flex-col gap-2 lg:w-[420px] lg:shrink-0">
          {state.error === null ? null : (
            <Alert variant="destructive">
              <AlertDescription>{state.error}</AlertDescription>
            </Alert>
          )}
          <form
            action={(formData) => {
              setSubmitted(true);
              dispatch(formData);
            }}
            className="flex flex-wrap items-center gap-2"
          >
            <input type="hidden" name="csrf" value={csrf.bind ?? ''} />
            <input type="hidden" name="fingerprint" value={row.fingerprint} />
            <input type="hidden" name="projectId" value={draft} />
            <input type="hidden" name="moveFrom" value={row.project.id} />
            <div className="min-w-0 flex-1">
              <ProjectSelect
                projects={projects}
                value={draft}
                onValueChange={setDraft}
                label={`New project for ${name}`}
              />
            </div>
            <Button type="submit" disabled={pending || draft === row.project.id}>
              Save
            </Button>
            <Button type="button" variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </form>
          <ActionForm action={actions.remove} className="flex">
            <input type="hidden" name="csrf" value={csrf.remove ?? ''} />
            <input type="hidden" name="fingerprint" value={row.fingerprint} />
            <input type="hidden" name="projectId" value={row.project.id} />
            <ConfirmSubmit
              tone="warn"
              title={`Disconnect ${name} from ${row.project.slug}?`}
              description={`Memories and sessions already written stay in ${row.project.slug}. Later sessions from this repository stop resolving there and use the default project.`}
              confirmLabel="Disconnect"
            >
              <Button type="button" variant="warn" size="sm">
                Disconnect…
              </Button>
            </ConfirmSubmit>
          </ActionForm>
        </div>
      ) : (
        <div className="flex items-center gap-3 lg:w-[420px] lg:shrink-0">
          <ArrowRight aria-hidden="true" className="size-4 shrink-0 text-primary" />
          <TonePill tone="lime">{row.project.slug}</TonePill>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => {
              setDraft(row.project.id);
              setEditing(true);
            }}
          >
            Change
          </Button>
        </div>
      )}
    </li>
  );
}

function AddRepositoryDialog({
  projects,
  actions,
  csrf,
}: {
  projects: readonly ProjectRef[];
  actions: RepositoryActions;
  csrf: RepositoryCsrf;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline">
          <Plus aria-hidden="true" />
          Add by hand
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Add a repository by hand</DialogTitle>
          <DialogDescription>
            Usually not needed: a repository shows up above the first time an agent works in it. Use
            this to connect one before that happens.
          </DialogDescription>
        </DialogHeader>
        <FingerprintBindForm
          projects={projects}
          action={actions.bind}
          csrf={csrf.bind}
          onBound={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
