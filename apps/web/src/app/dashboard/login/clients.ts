export const LOGIN_CLIENTS = [
  'CLAUDE CODE',
  'OPENCODE',
  'CODEX CLI',
  'PI',
  'HERMES',
  'MCP CLIENTS',
] as const;

export function safeNext(next: string | undefined | null): string | null {
  if (!next) return null;
  return next.startsWith('/dashboard/oauth/') ? next : null;
}

export const LOGIN_ERROR_MESSAGES = {
  missing: 'Token is required.',
  invalid: 'Invalid token.',
  locked: 'Too many attempts. Try again shortly.',
  unavailable: 'This server has no session secret configured.',
} as const;

export type LoginErrorCode = keyof typeof LOGIN_ERROR_MESSAGES;

export function loginErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return code in LOGIN_ERROR_MESSAGES ? LOGIN_ERROR_MESSAGES[code as LoginErrorCode] : null;
}
