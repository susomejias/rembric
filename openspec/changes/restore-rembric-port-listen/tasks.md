## 1. Launcher

- [x] 1.1 Add `apps/web/server.js` resolving `REMBRIC_PORT` → `PORT` → `8787`, throwing on an invalid non-empty value and publishing the result as `PORT`.
- [x] 1.2 Add a `--healthcheck` mode that probes `/healthz` on the resolved port with the admin bearer token.
- [x] 1.3 Guard direct execution so importing the module in tests has no side effects.

## 2. Image wiring

- [x] 2.1 Rename the generated standalone server to `next-server.js` in the builder assembly and update the build-gate path.
- [x] 2.2 Copy the launcher to `apps/web/server.js` in the runner stage, keeping `ENTRYPOINT` unchanged.
- [x] 2.3 Replace the hard-coded HEALTHCHECK with the launcher `--healthcheck` probe.

## 3. Tests

- [x] 3.1 Focused launcher tests: precedence, default, empty-as-unset, invalid fail-fast, published `PORT`.
- [x] 3.2 Structural image invariants: entrypoint, rename contract, launcher healthcheck, no hard-coded probe port.
- [x] 3.3 Capture RED before the launcher and Dockerfile exist; GREEN after.

## 4. Verification

- [x] 4.1 Run `pnpm --filter @rembric/web exec vitest run src/test/invariants.test.ts`.
- [x] 4.2 Run `pnpm --filter @rembric/web run typecheck`.
- [x] 4.3 Run `git diff --check`.
- [x] 4.4 Targeted mutation proof for precedence, invalid fail-fast, default, published port, rename contract and healthcheck probe.
- [ ] 4.5 Runtime container rehearsal (build image, bring up old Compose at `REMBRIC_PORT=8799`, assert public `/healthz` 200). Untested here; scheduled separately.
