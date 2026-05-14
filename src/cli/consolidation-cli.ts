import { loadConfig } from '../config.js';

/**
 * `rembric consolidation run-now` — POST to the local server's admin
 * endpoint and stream back the result.
 *
 * We talk to the server over HTTP (rather than open a second SQLite
 * writer) because the server already holds the exclusive db handle,
 * cron timer, and embedding worker — running consolidation out-of-band
 * would race against them. Going through the admin endpoint keeps the
 * server as the single point of mutation.
 */
export async function runConsolidationRunNow(opts: {
  token?: string;
  url?: string;
}): Promise<void> {
  const config = loadConfig();
  const baseUrl = opts.url ?? `http://${config.host}:${config.port}`;
  const token = opts.token ?? process.env['REMBRIC_ADMIN_TOKEN'];

  if (!token) {
    process.stderr.write(
      'rembric consolidation run-now: no token provided. Pass --token or set REMBRIC_ADMIN_TOKEN.\n',
    );
    process.exit(2);
    return;
  }

  const url = `${baseUrl.replace(/\/$/, '')}/admin/consolidation/run`;
  process.stderr.write(`rembric: triggering consolidation at ${url} …\n`);

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stdout.write(
      JSON.stringify(
        {
          ok: false,
          code: 'unreachable',
          message: `cannot reach server at ${baseUrl}: ${message}`,
        },
        null,
        2,
      ) + '\n',
    );
    process.exit(1);
    return;
  }

  const payloadText = await response.text();
  let payload: unknown;
  try {
    payload = payloadText ? JSON.parse(payloadText) : null;
  } catch {
    payload = { ok: false, code: 'invalid_response', raw: payloadText };
  }

  process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  process.exit(response.ok ? 0 : 1);
}
