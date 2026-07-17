import { randomUUID } from 'node:crypto';

import { logger } from '../logger.js';

/**
 * Log an unexpected (non-domain) error with a correlatable id and return
 * that id — never the error's own message, which may contain internal
 * details (file paths, constraint text, stack fragments). Every surface
 * that can throw something other than a `DomainError` — MCP tool handlers
 * (`mcp/errors.ts::errToMcp`) and the HTTP surfaces below — funnels through
 * this so the "log server-side, return a generic message + errorId"
 * contract can't drift between them.
 */
export function logInternalError(err: unknown, context: string): string {
  const errorId = randomUUID();
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error(context, { errorId, message, stack });
  return errorId;
}

export interface InternalErrorBody {
  ok: false;
  code: 'internal_error';
  message: string;
  errorId: string;
}

/** Shared HTTP JSON body for an unexpected error — see `logInternalError`. */
export function httpInternalError(err: unknown, context: string): InternalErrorBody {
  const errorId = logInternalError(err, context);
  return { ok: false, code: 'internal_error', message: 'An unexpected error occurred.', errorId };
}
