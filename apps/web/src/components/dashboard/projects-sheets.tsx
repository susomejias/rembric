'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState } from 'react';

import type { ActionState, FormAction } from '@/components/dashboard/action-form';
import {
  CreateRepositoryFields,
  RepositoriesSection,
  type PendingRepository,
  type ProjectRepositories,
  type RepositoryActions,
  type RepositoryCsrf,
} from '@/components/dashboard/repositories-section';
import { Flash, LABEL } from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

const INITIAL_STATE: ActionState = { error: null };

const SHEET_CONTENT = 'w-full gap-0 overflow-y-auto border-border bg-card sm:max-w-md';
const SHEET_HEAD = 'border-b border-border px-4 py-4';
const SHEET_BODY = 'flex flex-col gap-4 px-4 py-5';

/** The slug shape the server action enforces, mirrored as native validation. */
const SLUG_PATTERN = '[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?';

export interface RenameTarget {
  readonly id: string;
  readonly label: string;
  readonly slug: string;
  readonly displayName: string | null;
  readonly archived?: boolean;
  readonly repositories?: ProjectRepositories;
}

export function CreateProjectSheet({
  action,
  csrf,
  pending = [],
}: {
  action: FormAction;
  csrf: string | null;
  pending?: readonly PendingRepository[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" size="sm" className="rounded-[10px]">
          New project
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className={SHEET_CONTENT}>
        <SheetHeader className={SHEET_HEAD}>
          <SheetTitle>New project</SheetTitle>
          <SheetDescription>
            A project is created by its slug and cannot be renamed afterwards; only its display name
            can change.
          </SheetDescription>
        </SheetHeader>
        <CreateProjectForm
          action={action}
          csrf={csrf}
          pending={pending}
          onDone={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  );
}

export function RenameProjectSheet({
  target,
  open,
  onOpenChange,
  action,
  csrf,
  repositoryActions,
  repositoryCsrf,
}: {
  target: RenameTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  action: FormAction;
  csrf: string | null;
  repositoryActions?: RepositoryActions;
  repositoryCsrf?: RepositoryCsrf;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className={SHEET_CONTENT}>
        <SheetHeader className={SHEET_HEAD}>
          <SheetTitle>Edit project</SheetTitle>
          <SheetDescription>
            {target === null
              ? 'Update the display name this project shows across the dashboard.'
              : `The slug ${target.slug} never changes; only the label does.`}
          </SheetDescription>
        </SheetHeader>
        {target === null ? null : (
          <RenameProjectForm
            key={target.id}
            target={target}
            action={action}
            csrf={csrf}
            onDone={() => onOpenChange(false)}
          />
        )}
        {target?.repositories === undefined ||
        repositoryActions === undefined ||
        repositoryCsrf === undefined ? null : (
          <RepositoriesSection
            key={`repositories-${target.id}`}
            project={{ id: target.id, slug: target.slug, archived: target.archived ?? false }}
            data={target.repositories}
            actions={repositoryActions}
            csrf={repositoryCsrf}
          />
        )}
      </SheetContent>
    </Sheet>
  );
}

function CreateProjectForm({
  action,
  csrf,
  pending,
  onDone,
}: {
  action: FormAction;
  csrf: string | null;
  pending: readonly PendingRepository[];
  onDone: () => void;
}) {
  const { state, formAction, pending: submitting } = useSheetForm(action, onDone);

  return (
    <form action={formAction} className={SHEET_BODY}>
      <SheetError error={state.error} />
      <input type="hidden" name="csrf" value={csrf ?? ''} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-create-slug" className={cn(LABEL, 'text-muted-foreground')}>
          Slug
        </Label>
        <Input
          id="project-create-slug"
          name="slug"
          required
          pattern={SLUG_PATTERN}
          placeholder="my-project"
          autoComplete="off"
          autoCapitalize="none"
        />
        <p className="text-xs text-muted-foreground">
          Lowercase letters, digits and dashes. This is the value agents pass through{' '}
          <code className="font-mono">/mcp/&lt;slug&gt;</code>.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-create-name" className={cn(LABEL, 'text-muted-foreground')}>
          Display name
        </Label>
        <Input
          id="project-create-name"
          name="displayName"
          placeholder="display name (optional)"
          autoComplete="off"
        />
      </div>
      <CreateRepositoryFields pending={pending} />
      <SheetFooter className="mt-0 p-0">
        <Button type="submit" size="sm" disabled={submitting}>
          Create project
        </Button>
      </SheetFooter>
    </form>
  );
}

function RenameProjectForm({
  target,
  action,
  csrf,
  onDone,
}: {
  target: RenameTarget;
  action: FormAction;
  csrf: string | null;
  onDone: () => void;
}) {
  const { state, formAction, pending } = useSheetForm(action, onDone);

  return (
    <form action={formAction} className={SHEET_BODY}>
      <SheetError error={state.error} />
      <input type="hidden" name="csrf" value={csrf ?? ''} />
      <input type="hidden" name="id" value={target.id} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="project-rename-name" className={cn(LABEL, 'text-muted-foreground')}>
          Display name
        </Label>
        <Input
          id="project-rename-name"
          name="displayName"
          required
          defaultValue={target.displayName ?? ''}
          placeholder={target.slug}
          autoComplete="off"
        />
      </div>
      <SheetFooter className="mt-0 p-0">
        <Button type="submit" size="sm" disabled={pending}>
          Save
        </Button>
      </SheetFooter>
    </form>
  );
}

function SheetError({ error }: { error: string | null }) {
  if (error === null) return null;
  return (
    <Flash tone="danger" label="ERROR">
      {error}
    </Flash>
  );
}

/**
 * A sheet closes and refreshes only once its submission settled without an
 * error; a rejected submission leaves the sheet open with the message inline.
 */
function useSheetForm(action: FormAction, onDone: () => void) {
  const router = useRouter();
  const [state, dispatch, pending] = useActionState(action, INITIAL_STATE);
  const submitted = useRef(false);

  useEffect(() => {
    if (!submitted.current || pending) return;
    submitted.current = false;
    if (state.error !== null) return;
    onDone();
    router.refresh();
  }, [state, pending, onDone, router]);

  const formAction = (formData: FormData) => {
    submitted.current = true;
    dispatch(formData);
  };

  return { state, formAction, pending };
}
