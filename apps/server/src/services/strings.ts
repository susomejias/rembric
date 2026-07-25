import { DomainError } from './errors.js';

/**
 * Shared string guards used across the memory and session write paths.
 * See openspec/changes/fix-audited-defects.
 */

/**
 * Reject a NUL byte anywhere in `value`. SQLite's `length()` (and every
 * `CHECK` built on it, e.g. `title`'s `CHECK(length(title) BETWEEN 1 AND
 * 100)`) stops counting at the first NUL, so a value whose JS `.length`
 * satisfies a bound can still trip the database-level CHECK — surfacing as
 * an opaque `internal_error` with the row never written. Rejecting up front
 * with `invalid_input` naming the field is strictly better than a mutation
 * (silently stripping agent-supplied content is its own hazard).
 */
export function assertNoNul(callsite: string, field: string, value: string): void {
  if (value.includes('\0')) {
    throw new DomainError('invalid_input', `${callsite}: ${field} contains a NUL byte`);
  }
}

/**
 * Truncate `s` to at most `maxLen` UTF-16 code units without splitting a
 * surrogate pair — cutting mid-pair leaves a lone high surrogate, which
 * SQLite happily stores (its `length()` counts code units, not validated
 * codepoints) and which then decodes to U+FFFD wherever it is read back.
 */
export function sliceWithoutSplittingSurrogatePair(s: string, maxLen: number): string {
  let end = maxLen;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}
