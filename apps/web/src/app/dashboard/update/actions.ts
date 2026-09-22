import { redirect } from 'next/navigation';

import { getUpdates } from './update-service';

import type { ActionState } from '@/components/dashboard/action-form';
import { guardAction, guardFailure } from '@/lib/actions/guard';

export const UPDATE_CHECK_FORM = 'update.check';

export async function checkForUpdates(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, UPDATE_CHECK_FORM);
  if (!guard.ok) return guardFailure(guard);

  const updates = getUpdates();
  if (!updates.enabled) redirect('/dashboard/update');

  const { outcome } = await updates.checkNow();
  redirect(outcome === 'update' ? '/dashboard/update' : `/dashboard/update?checked=${outcome}`);
}
