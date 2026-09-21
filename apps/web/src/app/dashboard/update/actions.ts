import { redirect } from 'next/navigation';

import { getUpdates } from './update-service';

import type { ActionState } from '@/components/dashboard/action-form';
import { guardAction, guardFailure } from '@/lib/actions/guard';

/**
 * `apps/server/src/dashboard/update.ts`'s `UPDATE_CHECK_FORM`: the form name the
 * CSRF token is bound to.
 */
export const UPDATE_CHECK_FORM = 'update.check';

/**
 * `POST /dashboard/update/check`, as a Server Action.
 *
 * The guard runs first (admin scope, then the token bound to this form name), so
 * a refused submission never reaches the release check. The check itself is the
 * process's own singleton (`update-service.ts`) — the same instance the page and
 * the sidebar badge peek — so a manual check refreshes the cache the next render
 * reads instead of a throwaway service's.
 *
 * The two redirects are main's, verbatim: a found update needs no flash (the
 * refreshed cache re-renders the page as the "update available" state), while
 * `none`/`error` come back as the `checked` flash the page reads. `redirect()`
 * is called outside any `try` — it signals by throwing, and a `catch` would
 * swallow it.
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
