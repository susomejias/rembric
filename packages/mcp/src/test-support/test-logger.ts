import { randomUUID } from 'node:crypto';

export function logInternalError(err: unknown, context: string): string {
  const errorId = randomUUID();
  const message = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  console.error(`[error] ${context} ${JSON.stringify({ errorId, message, stack })}`);
  return errorId;
}
