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
 * The submit crosses a Radix portal: `AlertDialogContent` renders into
 * `document.body`, so the confirm button is no longer inside the form element.
 * Committing it by `form={id}` — the form's id discovered through `ActionForm`'s
 * context — re-associates the two. `type="submit"` is required because Radix
 * defaults the action to `type="button"`.
 */
export function ConfirmSubmit({
  tone,
  title,
  description,
  confirmLabel,
  children,
}: {
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
