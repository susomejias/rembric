/**
 * The login page's data, kept out of the markup so a test can read one source:
 * the client footer's canonical order and the `next` sanitiser.
 */

/**
 * The five shipped clients plus the generic entry, in the order the retired
 * login page named them. The order is the contract, not a decoration: the footer
 * is how an operator recognises which connectors this install serves.
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
 * `safeNext` from `apps/server/src/server/dashboard-router.ts`, unchanged: only
 * the OAuth consent hand-off may carry a post-login destination, so the login
 * form can never be turned into an open redirect. Everything else logs in and
 * lands on the dashboard.
 */
export function safeNext(next: string | undefined | null): string | null {
  if (!next) return null;
  return next.startsWith('/dashboard/oauth/') ? next : null;
}
