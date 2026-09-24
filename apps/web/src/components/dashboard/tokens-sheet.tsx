'use client';

import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useRef, useState } from 'react';

import type { ActionState, FormAction } from '@/components/dashboard/action-form';
import { Flash, LABEL } from '@/components/dashboard/ui';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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

const SHEET_CONTENT = 'w-full gap-0 border-border bg-card sm:max-w-md';
const SHEET_HEAD = 'border-b border-border px-4 py-4';
const SHEET_BODY = 'flex flex-col gap-4 px-4 py-5';

export interface TokenProjectOption {
  readonly id: string;
  readonly slug: string;
}

export function CreateTokenSheet({
  action,
  csrf,
  projects,
}: {
  action: FormAction;
  csrf: string | null;
  projects: readonly TokenProjectOption[];
}) {
  const [open, setOpen] = useState(false);

  return (
    <Sheet open={open} onOpenChange={setOpen}>
      <SheetTrigger asChild>
        <Button type="button" size="sm" className="rounded-[10px]">
          New token
        </Button>
      </SheetTrigger>
      <SheetContent side="right" className={SHEET_CONTENT}>
        <SheetHeader className={SHEET_HEAD}>
          <SheetTitle>New token</SheetTitle>
          <SheetDescription>
            The plaintext is shown once, right after creation, and never again.
          </SheetDescription>
        </SheetHeader>
        <CreateTokenForm
          action={action}
          csrf={csrf}
          projects={projects}
          onDone={() => setOpen(false)}
        />
      </SheetContent>
    </Sheet>
  );
}

export function CopyPlaintextButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  const copy = (): void => {
    if (navigator.clipboard === undefined) return;
    void navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
    });
  };

  return (
    <Button type="button" variant="outline" size="sm" onClick={copy} className="rounded-[10px]">
      {copied ? 'Copied' : 'Copy'}
    </Button>
  );
}

function CreateTokenForm({
  action,
  csrf,
  projects,
  onDone,
}: {
  action: FormAction;
  csrf: string | null;
  projects: readonly TokenProjectOption[];
  onDone: () => void;
}) {
  const { state, formAction, pending } = useSheetForm(action, onDone);

  return (
    <form action={formAction} className={SHEET_BODY}>
      <SheetError error={state.error} />
      <input type="hidden" name="csrf" value={csrf ?? ''} />
      <div className="flex flex-col gap-2">
        <Label htmlFor="token-create-name" className={cn(LABEL, 'text-muted-foreground')}>
          Name
        </Label>
        <Input
          id="token-create-name"
          name="name"
          required
          placeholder="claude-laptop"
          autoComplete="off"
        />
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className={cn(LABEL, 'text-muted-foreground')}>Projects (optional)</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {projects.map((project) => (
            <div key={project.id} className="flex items-center gap-2">
              <Checkbox
                id={`token-create-project-${project.id}`}
                name="project"
                value={project.slug}
              />
              <Label
                htmlFor={`token-create-project-${project.id}`}
                className="font-mono text-xs font-normal"
              >
                {project.slug}
              </Label>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          None selected: ADMIN, every project + dashboard login. One: that project only. Two or
          more: exactly those, and still not admin.
        </p>
      </fieldset>

      <div className="flex flex-col gap-2">
        <Label htmlFor="token-create-access" className={cn(LABEL, 'text-muted-foreground')}>
          Access
        </Label>
        <Select name="access" defaultValue="write">
          <SelectTrigger id="token-create-access" className="w-full">
            <SelectValue placeholder="select access" />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="write">write (read and write)</SelectItem>
              <SelectItem value="read">read (read only)</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="token-create-expires" className={cn(LABEL, 'text-muted-foreground')}>
          Expires (optional, ISO 8601)
        </Label>
        <Input
          id="token-create-expires"
          name="expires"
          placeholder="2027-01-01T00:00:00Z"
          autoComplete="off"
        />
      </div>

      <SheetFooter className="mt-0 p-0">
        <Button type="submit" size="sm" disabled={pending}>
          Create token
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
