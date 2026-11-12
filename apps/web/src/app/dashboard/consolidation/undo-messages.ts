import type { KeptVerdict, SkippedRow } from '@rembric/core';

import type { ActionState } from '@/components/dashboard/action-form';
import { shortId } from '@/components/dashboard/support';

export function partialUndo(result: {
  skipped: SkippedRow[];
  keptVerdicts: KeptVerdict[];
}): ActionState | null {
  const notes: string[] = [];
  if (result.skipped.length > 0) {
    const rows = result.skipped
      .map((s) => `${shortId(s.id)} (topic ${s.topicKey} now held by ${shortId(s.occupiedBy)})`)
      .join('; ');
    notes.push(
      `${result.skipped.length} row(s) were not reactivated — a newer memory now owns their topic ` +
        `slot. The rest of the undo was applied. ${rows}`,
    );
  }
  if (result.keptVerdicts.length > 0) {
    const rows = result.keptVerdicts
      .map(
        (k) => `${shortId(k.judgmentId)} (${k.relation ? `${k.status} ${k.relation}` : k.status})`,
      )
      .join('; ');
    notes.push(
      `${result.keptVerdicts.length} relation(s) were not restored to pending — a later verdict ` +
        `exists, so the undo kept it. The op is marked reverted. ${rows}`,
    );
  }
  return notes.length > 0 ? { error: notes.join(' ') } : null;
}
