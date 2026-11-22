import { DomainError, type MemoryService } from '@rembric/core';
import { projectScope } from '@rembric/db';

import { guardAction, guardFailure } from '@/lib/actions/guard';

export const PIN_FORM = 'memory.pin';

export type PinOutcome = { error: string } | { error: null; id: string };

const NO_PROJECT_MESSAGE =
  'This memory predates the default project and has no project to act in; it cannot be pinned.';

function pinnedTitles(err: DomainError): string {
  const pinned = err.details?.['pinned'];
  if (!Array.isArray(pinned)) return '';
  const titles = pinned.map((p) => (p as { title?: unknown }).title).filter((t) => t);
  return titles.length > 0 ? ` Pinned now: ${titles.join(' · ')}.` : '';
}

export async function applyMemoryPin(formData: FormData): Promise<PinOutcome> {
  const guard = await guardAction(formData, PIN_FORM);
  if (!guard.ok) return guardFailure(guard);
  return pinFromForm(guard.services.memory, formData);
}

export function pinFromForm(
  memory: Pick<MemoryService, 'unsafeGetById' | 'setPinned'>,
  formData: FormData,
): PinOutcome {
  const raw = formData.get('id');
  const id = (typeof raw === 'string' ? raw : '').trim();
  const pinned = formData.get('pinned') === '1';
  const row = memory.unsafeGetById(id);
  if (!row) return { error: 'Memory not found.' };
  if (!row.projectId) return { error: NO_PROJECT_MESSAGE };

  try {
    memory.setPinned(id, projectScope(row.projectId), pinned, {
      cause: 'operator',
      name: 'dashboard-operator',
    });
  } catch (err) {
    if (err instanceof DomainError) {
      return {
        error: err.code === 'pin_limit_reached' ? err.message + pinnedTitles(err) : err.message,
      };
    }
    throw err;
  }
  return { error: null, id };
}
