# Tasks — show-server-version-in-dashboard-brand

## 1. Render version in brand surfaces

- [x] 1.1 In `apps/server/src/dashboard/components.ts`, import `REMBRIC_VERSION` from `../version.js` and replace the `SELF-HOSTED` small with `<small>v${REMBRIC_VERSION}</small>` in `renderSidebar`'s `.label-stack`
- [x] 1.2 Apply the same replacement in `renderMobileBar`'s `.label-stack`; confirm no CSS changes are needed (mobile `·` separator comes from the existing `.mob-bar .brand .label-stack small::before` rule)
- [x] 1.3 In `apps/server/src/server/dashboard-router.ts` `renderLogin`, replace the `SELF-HOSTED` line with a `t-mono-up fg-dim` line rendering `v${REMBRIC_VERSION}`

## 2. Tests

- [x] 2.1 In `apps/server/src/dashboard/components.test.ts`, assert `renderSidebar` output contains `v${REMBRIC_VERSION}` and does NOT contain `SELF-HOSTED` (import the constant; do not hardcode the version)
- [x] 2.2 Same assertions for `renderMobileBar`, alongside the existing REMBRIC / ☰ MENU assertions
- [x] 2.3 In `apps/server/src/test/dashboard-e2e.test.ts`, assert the login page HTML contains `v${REMBRIC_VERSION}` and the authenticated home does too
- [x] 2.4 `pnpm vitest run src/dashboard/components.test.ts src/test/dashboard-e2e.test.ts` (from `apps/server/`) passes

## 3. Validation gates

- [x] 3.1 `pnpm run typecheck` clean
- [x] 3.2 `pnpm run lint` clean (watch import-group ordering for the new `../version.js` imports)
- [x] 3.3 `pnpm test` full suite green
- [x] 3.4 Visual smoke (operator-only): load login + dashboard at desktop, ≤980 px and ≤640 px viewports; confirm `REMBRIC` / `v<version>` renders in login brand, sidebar and mob-bar with no `SELF-HOSTED` remnants and no layout breakage
