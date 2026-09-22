import type { RawOutcome } from './types.js';

export function checkAbstentionFlags(retriever: string, outcomes: RawOutcome[]): string[] {
  const failures: string[] = [];
  for (const o of outcomes) {
    if (o.reportedAbstained === true && o.retrieved.length > 0) {
      failures.push(
        `${retriever} '${o.query.id}' reported abstained=true while returning ${o.retrieved.length} result(s) — the flag disagrees with the behaviour it describes`,
      );
    }
  }
  return failures;
}
