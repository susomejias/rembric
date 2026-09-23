import { NextResponse } from 'next/server';

/**
 * A `302` whose `Location` is left origin-relative.
 *
 * The handlers used to build the redirect URL from `request.url`, and inside
 * the Next standalone server that URL carries the Dockerfile-baked
 * `HOSTNAME`/`PORT` (`0.0.0.0:8787`), so the browser was sent to a
 * connection-refused address. A relative `Location` keeps the redirect on the
 * origin the browser actually used. The response is built directly rather than
 * through `NextResponse.redirect`, whose URL validation also throws in the
 * proxy/edge runtime when handed the relative path.
 *
 * `302`, not the `307` `NextResponse.redirect` defaults to: a 307 preserves the
 * method, so a form POST would re-POST to the destination instead of navigating
 * with a GET.
 */
export function relativeRedirect(location: string): NextResponse {
  const response = new NextResponse(null, { status: 302 });
  response.headers.set('location', location);
  return response;
}
