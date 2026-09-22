import type { DomainError } from '@rembric/core';

/**
 * Server-side error logging for the non-domain branch below, injected at the
 * application boundary (`CreateMcpServerOptions.logInternalError`). It mints
 * the correlatable error id returned to the client and writes the real message
 * and stack to the server log. The implementation stays application-side so the
 * "log server-side, return a generic message + errorId" contract cannot drift
 * between the MCP and HTTP surfaces — and so this package never reaches for a
 * logger it does not own.
 */
export type LogInternalError = (err: unknown, context: string) => string;

/** Every `build*Handlers` deps object, so no tool module can forget to wire it. */
export interface ErrorReportingDeps {
  logInternalError: LogInternalError;
}

/**
 * `DomainError` identified by shape rather than by class identity.
 *
 * Turbopack assigns a distinct module id to `@rembric/core` per chunk group,
 * so the `DomainError` a service throws and the one a caller imported can be
 * two different classes and `instanceof` is false across them (measured in
 * `apps/web`: the standalone `/.next/server/chunks/` carries two copies, and
 * every invalid or revoked bearer came back 500 instead of 401). `name` plus a
 * string `code` is the contract both copies share
 * (`packages/core/src/services/errors.ts`); the `name` clause is what keeps a
 * better-sqlite3 `SqliteError` — which also carries a string `code`, e.g.
 * `SQLITE_BUSY` — from being classified as a domain error.
 */
export function isDomainError(err: unknown): err is DomainError {
  return (
    err instanceof Error &&
    err.name === 'DomainError' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

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
export function errToMcp(err: unknown, logInternalError: LogInternalError) {
  if (isDomainError(err)) {
    return mcpError(err.code, err.message, err.details);
  }
  const errorId = logInternalError(err, 'unhandled MCP tool error');
  return mcpError('internal_error', 'An unexpected error occurred.', { errorId });
}
