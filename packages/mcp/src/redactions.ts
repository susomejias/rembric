import { SECRET_KINDS, type Redaction, type RedactionTally } from '@rembric/core';
import { z } from 'zod';

export const REDACTION_NOTE =
  'Credential-shaped text (API keys, tokens, private keys, passwords) is stored as [REDACTED:<kind>] and reported in redactions.';

export const redactionsOutput = z
  .array(z.object({ kind: z.enum(SECRET_KINDS), count: z.number() }))
  .optional();

export function redactionsField(tally: RedactionTally): { redactions?: Redaction[] } {
  const redactions = tally.list();
  return redactions.length > 0 ? { redactions } : {};
}
