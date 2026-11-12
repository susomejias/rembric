import type { KeptOrphaned, KeptVerdict, SkippedRow } from '@rembric/core';

import type { ActionState } from '@/components/dashboard/action-form';
import { shortId } from '@/components/dashboard/support';

export function partialUndo(result: {
  skipped: SkippedRow[];
  keptVerdicts: KeptVerdict[];
  keptOrphaned?: KeptOrphaned[];
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
  const keptOrphaned = result.keptOrphaned ?? [];
  if (keptOrphaned.length > 0) {
    const rows = keptOrphaned
      .map((k) => `${shortId(k.judgmentId)} (${shortId(k.retiredId)} is still retired)`)
      .join('; ');
    notes.push(
      `${keptOrphaned.length} judgment(s) stay orphaned — one of their memories is still ` +
        `retired, so no agent could judge them. Their ops stay active. ${rows}`,
    );
  }
  return notes.length > 0 ? { error: notes.join(' ') } : null;
}
