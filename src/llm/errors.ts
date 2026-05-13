/**
 * Typed errors emitted by the LLM client. Callers can branch on `code`
 * without parsing message strings.
 */

export type LlmErrorCode =
  | 'http_error'
  | 'timeout'
  | 'network'
  | 'invalid_response'
  | 'schema_violation'
  | 'rate_limited'
  | 'auth';

export class LlmError extends Error {
  public readonly code: LlmErrorCode;
  public override readonly cause?: unknown;

  constructor(code: LlmErrorCode, message: string, cause?: unknown) {
    super(message);
    this.name = 'LlmError';
    this.code = code;
    this.cause = cause;
  }
}
