'use client';

import type { ReactNode } from 'react';

import { useActionFormId } from '@/components/dashboard/action-form';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';

/**
 * Confirm-before-submit, the port of the dashboard's `form[data-confirm]`
 * interception (`apps/server/src/dashboard/templates.ts`): the trigger opens a
 * dialog, and only the dialog's confirm button submits.
 *
 * The submit crosses a portal: Radix renders `AlertDialogContent` into
 * `document.body`, so the confirm button is no longer inside the form element.
 * Committing it by `form={id}` — the form's id discovered through
 * `ActionForm`'s context — is what re-associates the two; the browser then treats
 * it exactly like a submit button that never left the form. `type="submit"` is
 * what makes the native submit happen at all, since Radix defaults it to
 * `type="button"`.
 *
 * `title`/`description` carry main's single `data-confirm` string split at its
 * question mark, so the copy is verbatim and the dialog still has the accessible
 * title Radix requires.
 */
export function ConfirmSubmit({
  tone,
  title,
  description,
  confirmLabel,
  children,
}: {
  /** `warn` is main's amber tone for a reversible action; `danger` is its red. */
  tone: 'warn' | 'danger';
  title: ReactNode;
  description: ReactNode;
  confirmLabel: ReactNode;
  /** The dialog's trigger. Give it `type="button"` so the click only opens the dialog. */
  children: ReactNode;
}) {
  const formId = useActionFormId();

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>{children}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>CANCEL</AlertDialogCancel>
          <AlertDialogAction
            type="submit"
            form={formId ?? undefined}
            variant={tone === 'danger' ? 'destructive' : 'default'}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
