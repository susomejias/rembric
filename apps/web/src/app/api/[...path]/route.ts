import { methodFallback } from '../../../lib/api';

export const dynamic = 'force-dynamic';

/**
 * Every path and method this surface does not declare answers
 * `{ ok: false, code: 'not_found', path }` with a 404, rather than Next's HTML
 * 404 or a 405.
 *
 * One disclosed divergence: a path that falls under `:slug/sessions|memory|debug`
 * but matches no declared route would reach an auth middleware first in a
 * middleware-ordered router, so an unauthenticated caller would get 401 there and
 * 404 here. No client reaches such a path — the eight declared
 * routes are the whole surface — and 404 leaks nothing an unauthenticated
 * caller could not already observe.
 */
export const GET = methodFallback;
export const POST = methodFallback;
export const PUT = methodFallback;
export const PATCH = methodFallback;
export const DELETE = methodFallback;
export const OPTIONS = methodFallback;
