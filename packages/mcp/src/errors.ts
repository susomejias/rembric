import type { DomainError } from '@rembric/core';

export type LogInternalError = (err: unknown, context: string) => string;

/** Every `build*Handlers` deps object, so no tool module can forget to wire it. */
export interface ErrorReportingDeps {
  logInternalError: LogInternalError;
}

export function isDomainError(err: unknown): err is DomainError {
  return (
    err instanceof Error &&
    err.name === 'DomainError' &&
    typeof (err as { code?: unknown }).code === 'string'
  );
}

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

export function errToMcp(err: unknown, logInternalError: LogInternalError) {
  if (isDomainError(err)) {
    return mcpError(err.code, err.message, err.details);
  }
  const errorId = logInternalError(err, 'unhandled MCP tool error');
  return mcpError('internal_error', 'An unexpected error occurred.', { errorId });
}
