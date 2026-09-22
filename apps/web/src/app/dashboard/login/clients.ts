/**
 * The login page's data, kept out of the markup so a test can read one source:
 * the client footer's canonical order and the `next` sanitiser.
 */

/**
 * The five shipped clients plus the generic entry. The order is the contract,
 * not a decoration: the footer is how an operator recognises which connectors
 * this install serves.
 */
export const LOGIN_CLIENTS = [
  'CLAUDE CODE',
  'OPENCODE',
  'CODEX CLI',
  'PI',
  'HERMES',
  'MCP CLIENTS',
] as const;

/**
 * Only the OAuth consent hand-off may carry a post-login destination, so the
 * login form can never be turned into an open redirect. Everything else logs in
 * and lands on the dashboard.
 */
export function safeNext(next: string | undefined | null): string | null {
  if (!next) return null;
  return next.startsWith('/dashboard/oauth/') ? next : null;
}

/**
 * The refusal copy. The form POST answers with a `302` back to
 * `/dashboard/login` (a plain form POST cannot be answered with the page it came
 * from and keep the browser's navigation sane), so the status is carried as the
 * `?error=` code below and the copy moves with it.
 *
 * `unavailable`: boot refused to start without a session secret, while this
 * process may only refuse the sign-in.
 */
export const LOGIN_ERROR_MESSAGES = {
  missing: 'Token is required.',
  invalid: 'Invalid token.',
  locked: 'Too many attempts. Try again shortly.',
  unavailable: 'This server has no session secret configured.',
} as const;

export type LoginErrorCode = keyof typeof LOGIN_ERROR_MESSAGES;

/**
 * The copy for an `?error=` value, or `null` for an absent or unrecognised one.
 * An unknown code renders nothing rather than echoing the query string.
 */
export function loginErrorMessage(code: string | null | undefined): string | null {
  if (!code) return null;
  return code in LOGIN_ERROR_MESSAGES ? LOGIN_ERROR_MESSAGES[code as LoginErrorCode] : null;
}
