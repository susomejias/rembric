import { redirect } from 'next/navigation';

import { getSelfUpdate } from './self-update-service';
import { getUpdates } from './update-service';

import type { ActionState } from '@/components/dashboard/action-form';
import { guardAction, guardFailure } from '@/lib/actions/guard';

export const UPDATE_CHECK_FORM = 'update.check';
export const UPDATE_START_FORM = 'update.start';

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

export async function startUpdate(_prev: ActionState, formData: FormData): Promise<ActionState> {
  'use server';
  const guard = await guardAction(formData, UPDATE_START_FORM);
  if (!guard.ok) return guardFailure(guard);

  const info = getUpdates().peek();
  if (info === null) redirect('/dashboard/update?err=no_update');

  const result = await getSelfUpdate().start(info.latestVersion);
  if (!result.ok) redirect(`/dashboard/update?err=${result.code}`);
  redirect('/dashboard/update');
}
