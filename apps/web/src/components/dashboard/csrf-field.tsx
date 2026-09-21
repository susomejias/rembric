import { dashboardCsrfToken } from '@/lib/session';

/**
 * The hidden `csrf` input every dashboard form carries — `csrfInput` in
 * `apps/server/src/dashboard/csrf.ts`, as a server component.
 *
 * It resolves the token itself rather than taking one as a prop so a form cannot
 * be rendered with a token bound to a different form name, and it renders
 * nothing when there is no live session to bind a token to: an empty value would
 * be refused by the guard anyway, and the retired view omitted the field in the
 * same state.
 *
 * Server component, so the token never reaches the client bundle as data — the
 * operator's browser only ever sees it as a form field.
 */
export async function CsrfField({ form }: { form: string }) {
  const token = await dashboardCsrfToken(form);
  if (token === null) return null;
  return <input type="hidden" name="csrf" value={token} />;
}
