import type { RawOutcome } from './types.js';

/**
 * A retriever claiming abstention while returning rows fails the run. The
 * converse is deliberately NOT enforced: `memory/spec.md` mandates
 * `abstained: false` for an empty page sliced past a non-empty candidate pool,
 * so failing on it would put the harness against the retrieval contract.
 *
 * Called with the outcomes at MAX_K, the k the retriever was actually invoked
 * with — a truncated page at a smaller k is not the retriever's verdict.
 */
export function checkAbstentionFlags(retriever: string, outcomes: RawOutcome[]): string[] {
  const failures: string[] = [];
  for (const o of outcomes) {
    if (o.reportedAbstained === true && o.retrieved.length > 0) {
      failures.push(
        `${retriever} '${o.query.id}' reported abstained=${o.reportedAbstained} while returning ${o.retrieved.length} result(s) — the flag disagrees with the behaviour it describes`,
      );
    }
  }
  return failures;
}
