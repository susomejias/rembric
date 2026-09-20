/**
 * Version reported by `/healthz` and the placeholder home page.
 *
 * The operator-visible version is `apps/server`'s package version today
 * (`apps/server/src/version.ts` reads it from that app's `package.json`), and
 * that module is not importable from `apps/web`. `'0.0.0'` is the same sentinel
 * `apps/server/src/version.ts` falls back to, so a wrong version can never be
 * mistaken for a real one.
 *
 * TODO(migrate-to-nextjs): replace with a version constant exported by
 * `@rembric/core` once `apps/server` is retired (phase 6), and delete this file.
 */
export const REMBRIC_VERSION = '0.0.0';
