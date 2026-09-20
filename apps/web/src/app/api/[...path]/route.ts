import { methodFallback } from '../../../lib/api';

export const dynamic = 'force-dynamic';

/**
 * The counterpart of `api-router.ts`'s `app.all('/*')` fallback: every path and
 * method this surface does not declare answers `{ ok: false, code: 'not_found',
 * path }` with a 404, rather than Next's HTML 404 or a 405.
 *
 * One disclosed divergence, from the Hono router's middleware ordering: a path
 * that falls under `:slug/sessions|memory|debug` but matches no declared route
 * passes that router's auth middleware first, so an unauthenticated caller gets
 * 401 there and 404 here. No client reaches such a path — the eight declared
 * routes are the whole surface — and 404 leaks nothing an unauthenticated
 * caller could not already observe.
 */
export const GET = methodFallback;
export const POST = methodFallback;
export const PUT = methodFallback;
export const PATCH = methodFallback;
export const DELETE = methodFallback;
export const OPTIONS = methodFallback;
