import { dashboardCsrfToken } from '@/lib/session';

/**
 * Resolves the token itself rather than taking one as a prop, so a form cannot be
 * rendered with a token bound to a different form name. Renders nothing when
 * there is no live session to bind one to, and being a server component keeps the
 * token out of the client bundle.
 */
export async function CsrfField({ form }: { form: string }) {
  const token = await dashboardCsrfToken(form);
  if (token === null) return null;
  return <input type="hidden" name="csrf" value={token} />;
}
