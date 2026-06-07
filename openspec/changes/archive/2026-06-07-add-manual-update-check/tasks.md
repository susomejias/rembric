# Tasks: add-manual-update-check

## 1. Service: force-check with outcome

- [x] 1.1 Add `checkNow(): Promise<{ outcome: 'update' | 'none' | 'error'; info: UpdateInfo | null }>` to `UpdateCheckService` (`apps/server/src/services/update-check.ts`): forces a refresh bypassing the interval, dedupes against `inflight`, maps fetch failure to `'error'` and a non-newer result to `'none'`; returns `'none'`-shaped no-op when disabled. Expose `lastCheckedAt` (null until first check) and `enabled` as readonly accessors. Automatic `peek()` path byte-for-byte unchanged.
- [x] 1.2 Tests in `apps/server/src/services/update-check.test.ts`: `checkNow` bypasses the 24h window; outcome `update` on newer release; `none` on same/older release and on 304; `error` on network failure and non-OK status; disabled service never fetches; `lastCheckedAt` reflects both manual and automatic checks. Verify with `pnpm vitest run apps/server/src/services/update-check.test.ts`.

## 2. Route: POST /dashboard/update/check

- [x] 2.1 Add `POST /check` to `createUpdateRouter` (`apps/server/src/dashboard/update.ts`) following the `/start` pattern: session guard, `readFormAndVerifyCsrf` with action `update.check`, `await deps.updates.checkNow()`, redirect to `/dashboard/update` (plain on `update`, `?checked=none` / `?checked=error` otherwise). Reject (redirect, no fetch) when the service is disabled.
- [x] 2.2 Map `checked=none` to an info flash ("Checked — no newer release is known.") and `checked=error` to an error flash naming the GitHub fetch failure and noting it is expected on air-gapped hosts, alongside the existing `?err=` mapping in the GET handler.
- [x] 2.3 Router tests in `apps/server/src/dashboard/update.test.ts` (extend existing): POST requires session + CSRF; outcome→redirect mapping; flash rendering for both query params; disabled service short-circuits without fetching.

## 3. Update page: CHECK NOW + last checked

- [x] 3.1 In the up-to-date branch of `GET /dashboard/update`, render the CSRF-protected CHECK NOW form (no `data-confirm`) and, when `lastCheckedAt` is non-null, a "Last checked" line via `formatTs`. When the check is disabled, render the existing disabled-note copy with no form.
- [x] 3.2 View tests: up-to-date state contains the form posting to `/dashboard/update/check`; last-checked line renders only after a check; disabled state has no form.

## 4. Brand-block slot: persistent

- [x] 4.1 Add a quiet-slot renderer next to `updateBadge` in `apps/server/src/dashboard/update-modal.ts` (muted link to `/dashboard/update`, label decided against the brutalist style — e.g. `UP TO DATE ›`). Extend `updateShellExtras` to return it when no update state exists and the check is enabled, and `null` when disabled; thread the `enabled` signal through `apps/server/src/server/dashboard-router.ts`.
- [x] 4.2 CSS for the muted variant in `apps/server/src/dashboard/styles/` reusing the `.sb-update` layout and locked design tokens (no inline styles, no new fonts/colors).
- [x] 4.3 Shell tests (`apps/server/src/dashboard/components.test.ts` / router tests): badge renders when update known (unchanged assertions); quiet link renders when none known and check enabled; nothing renders when `REMBRIC_UPDATE_CHECK=off`. Verify sidebar and mobile bar both carry the slot.

## 5. Verification

- [x] 5.1 `pnpm run typecheck && pnpm run lint && pnpm test` clean.
- [x] 5.2 Smoke against the dev stack (`pnpm run dev:docker:up`, see rembric-smoke-tests skill): quiet link visible in sidebar + mobile bar, CHECK NOW round-trips with the "no newer release" flash, simulate a newer release (point the service at a stub or temporarily lower `currentVersion`) to see the update view + badge, `REMBRIC_UPDATE_CHECK=off` hides slot and form. Iterate on the quiet-slot UI with the operator before archiving — label/styling is explicitly open for review.
