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
