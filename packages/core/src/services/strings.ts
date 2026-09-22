import { DomainError } from './errors.js';

export function assertNoNul(callsite: string, field: string, value: string): void {
  if (value.includes('\0')) {
    throw new DomainError('invalid_input', `${callsite}: ${field} contains a NUL byte`);
  }
}

export function sliceWithoutSplittingSurrogatePair(s: string, maxLen: number): string {
  let end = maxLen;
  const code = s.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return s.slice(0, end);
}

/** The tail counterpart: the orphan risk is a LOW surrogate first, not a high one last. */
export function sliceTailWithoutSplittingSurrogatePair(s: string, maxLen: number): string {
  if (s.length <= maxLen) return s;
  const tail = s.slice(-maxLen);
  const code = tail.charCodeAt(0);
  return code >= 0xdc00 && code <= 0xdfff ? tail.slice(1) : tail;
}
