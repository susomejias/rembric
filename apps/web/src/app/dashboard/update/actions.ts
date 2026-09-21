import { redirect } from 'next/navigation';

import { getUpdates } from './update-service';

import type { ActionState } from '@/components/dashboard/action-form';
import { guardAction, guardFailure } from '@/lib/actions/guard';

export const UPDATE_CHECK_FORM = 'update.check';

/**
 * The guard runs first, so a refused submission never reaches the release check;
 * the check is the process's own singleton, so a manual run refreshes the cache
 * the next render reads. `redirect()` sits outside any `try`, which would swallow
 * its control-flow throw.
 */
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
