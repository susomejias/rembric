import { DomainError } from '../services/errors.js';

/**
 * Build an MCP-shaped error response with a stable `code` field embedded
 * in the JSON payload so clients (and tests) can branch on it without
 * parsing message strings.
 */
export function mcpError(code: string, message: string, extra?: Record<string, unknown>) {
  return {
    isError: true,
    content: [
      {
        type: 'text' as const,
        text: JSON.stringify({ ok: false, code, message, ...(extra ?? {}) }, null, 2),
      },
    ],
  };
}

/**
 * Map a thrown error to an MCP response: domain errors keep their stable
 * `code`; anything else becomes `internal_error`. The single mapping shared
 * by every tool-handler module.
 */
export function errToMcp(err: unknown) {
  if (err instanceof DomainError) {
    return mcpError(err.code, err.message);
  }
  const message = err instanceof Error ? err.message : String(err);
  return mcpError('internal_error', message);
}
