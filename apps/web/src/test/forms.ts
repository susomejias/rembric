/** Pull the CSRF token out of a rendered dashboard form by its `action`. */
export function extractCsrf(html: string, action: string): string {
  const formRe = new RegExp(
    `<form[^>]*action="${action.replace(/[/.]/g, (m) => '\\' + m)}"[\\s\\S]*?</form>`,
  );
  const m = formRe.exec(html);
  if (!m) throw new Error(`form for action ${action} not found`);
  const c = /<input[^>]*name="csrf"[^>]*value="([^"]+)"/.exec(m[0]);
  if (!c?.[1]) throw new Error(`csrf input not found in form ${action}`);
  return c[1];
}
