import { logInternalError } from '../server/error-response.js';
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
 * Map a thrown error to an MCP response: domain errors keep their `code`;
 * anything else becomes `internal_error` with a correlatable error id, the
 * stack logged server-side but never returned to the client (mcp-api spec).
 */
export function errToMcp(err: unknown) {
  if (err instanceof DomainError) {
    return mcpError(err.code, err.message, err.details);
  }
  const errorId = logInternalError(err, 'unhandled MCP tool error');
  return mcpError('internal_error', 'An unexpected error occurred.', { errorId });
}
