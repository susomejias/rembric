import { NextResponse } from 'next/server';

/**
 * A `302` whose `Location` is left origin-relative.
 *
 * The handlers used to build the redirect URL from `request.url`, and inside
 * the Next standalone server that URL carries the Dockerfile-baked
 * `HOSTNAME`/`PORT` (`0.0.0.0:8787`), so the browser was sent to a
 * connection-refused address. A relative `Location` is also not an option: the
 * dev proxy re-dispatches redirects through `proxyRequest`, which requires an
 * absolute URL. The absolute Location is therefore rebuilt from the request's
 * own `Host`/`x-forwarded-proto` headers, which port mapping preserves.
 *
 * `302`, not the `307` `NextResponse.redirect` defaults to: a 307 preserves the
 * method, so a form POST would re-POST to the destination instead of navigating
 * with a GET.
 */
export function relativeRedirect(location: string, request: { headers: Headers }): NextResponse {
  const host =
    request.headers.get('x-forwarded-host') ?? request.headers.get('host') ?? 'localhost';
  const proto = request.headers.get('x-forwarded-proto') ?? 'http';
  return NextResponse.redirect(new URL(location, `${proto}://${host}`), 302);
}
