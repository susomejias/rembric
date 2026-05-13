/**
 * Domain errors emitted by services. The HTTP layer maps these to MCP /
 * dashboard responses; tests assert on `code` rather than message strings.
 */

export type DomainErrorCode =
  | 'invalid_scope'
  | 'memory_not_found'
  | 'project_not_found'
  | 'project_archived'
  | 'invalid_input'
  | 'forbidden'
  | 'token_not_found'
  | 'token_revoked'
  | 'token_expired'
  | 'admin_token_required'
  | 'conflict';

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
