import { NextResponse } from 'next/server';

/**
 * A `302` whose `Location` is left origin-relative.
 *
 * `NextResponse.redirect` needs an absolute URL, and the handlers used to build
 * that URL from `request.url`. Inside the Next standalone server the Dockerfile
 * bakes `HOSTNAME=0.0.0.0`, so that URL carried the internal host and a browser
 * was sent to a connection-refused `http://0.0.0.0:8787/dashboard`; a relative
 * `Location` keeps the redirect on the origin the browser actually used. The
 * `http://localhost` below exists only to satisfy `redirect`'s validation and is
 * replaced before the response leaves this function.
 *
 * `302`, not the `307` `NextResponse.redirect` defaults to: a 307 preserves the
 * method, so a form POST would re-POST to the destination instead of navigating
 * with a GET.
 */
export function relativeRedirect(location: string): NextResponse {
  const response = NextResponse.redirect(new URL(location, 'http://localhost'), 302);
  response.headers.set('location', location);
  return response;
}
