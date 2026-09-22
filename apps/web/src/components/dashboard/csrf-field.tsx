import { dashboardCsrfToken } from '@/lib/session';

export async function CsrfField({ form }: { form: string }) {
  const token = await dashboardCsrfToken(form);
  if (token === null) return null;
  return <input type="hidden" name="csrf" value={token} />;
}
