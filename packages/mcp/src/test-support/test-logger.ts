import { randomUUID } from 'node:crypto';

/**
 * Test double for `logInternalError`.
 *
 * Same contract: return a correlatable `errorId` and log the real error
 * server-side — never the error's own message, which may contain internal
 * details (file paths, constraint text, stack fragments). Writes one line to
 * stderr in the app logger's shape (`[error] <context> <json>`), so suites that
 * spy on `console.error` observe both the errorId and the raw message. Suites
 * inject this into the MCP handler `logInternalError` option.
 */
export function logInternalError(err: unknown, context: string): string {
  const errorId = randomUUID();
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(`[error] ${context} ${JSON.stringify({ errorId, message, stack })}`);
  return errorId;
}
