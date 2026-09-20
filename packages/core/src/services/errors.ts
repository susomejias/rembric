/**
 * Domain errors emitted by services. The HTTP layer maps these to MCP /
 * dashboard responses; tests assert on `code` rather than message strings.
 */

export type DomainErrorCode =
  | 'invalid_scope'
  | 'invalid_slug'
  | 'memory_not_found'
  | 'project_not_found'
  | 'project_archived'
  | 'project_switch_requires_confirm'
  | 'session_active_must_end'
  | 'session_already_ended'
  | 'session_not_found'
  | 'session_deleted'
  | 'invalid_input'
  | 'forbidden'
  | 'scope_locked'
  | 'token_not_found'
  | 'token_revoked'
  | 'token_expired'
  | 'admin_token_required'
  | 'conflict'
  | 'id_collision'
  | 'prompt_not_found'
  | 'prompt_scope_mismatch'
  | 'prompt_already_deleted'
  | 'prompt_not_deleted';

export class DomainError extends Error {
  constructor(
    public readonly code: DomainErrorCode,
    message: string,
    /**
     * Machine-readable extras `errToMcp` merges into the response body, so a
     * thrown error can carry what a hand-built `mcpError` would (e.g.
     * `suggestedSlugs` on `project_not_found`). The HTTP mapper drops them.
     */
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'DomainError';
  }
}
