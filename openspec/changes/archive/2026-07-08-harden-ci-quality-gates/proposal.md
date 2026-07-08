# Make CI enforce what the docs promise: coverage gate, lint reach, honest dev scripts

## Why

Several developer-facing guarantees are documented but not enforced, or documented wrong: (1) `CONTRIBUTING.md` states "Every PR must keep coverage above the thresholds enforced by Vitest: statements ≥ 90%, branches ≥ 85%, functions ≥ 85%, lines ≥ 85%" and "`pnpm run test:coverage` … CI matches this" — but CI never runs coverage (the Test step is `pnpm test` = `vitest run`, no `--coverage`), and the real thresholds in `apps/server/vitest.config.ts` are 50/50/50/50. The coverage config is dead letter and the docs are a lie. (2) `apps/plugin/**` is entirely excluded from ESLint (`eslint.config.js`), so the runtime bridges `rembric-bridge.mjs` and `rembric-dotenv.mjs` — real Node code shipped to users — get no static analysis at all. (3) `README.md`/`CONTRIBUTING.md` tell contributors to run `pnpm run dev`, `pnpm start`, `pnpm run test:watch`, `pnpm run test:coverage` from the repo root, but those scripts exist only in `apps/server/package.json`; from the root they fail with "No script found", and `CONTRIBUTING.md` points at an invariants-test path (`apps/server/src/**/__tests__/invariants/`) that does not exist (the real files are `apps/server/src/test/invariants.test.ts` and `runtime-invariants.test.ts`). (4) `install.test.ts` runs twice per CI run (once via the Test step's vitest `include`, once via the separate installer-e2e step).

## What Changes

- **MODIFIED** CI `Test` step enforces the coverage gate: run `pnpm --filter @rembric/server run test:coverage` so the configured thresholds actually gate PRs. The threshold values are set to an honest floor at or below current real coverage (the implementer measures it; the gate must be real, never aspirational).
- **MODIFIED** `CONTRIBUTING.md` coverage section states the ACTUAL enforced thresholds and the ratchet-up policy; removes the false "CI matches this" claim's inaccuracy by making it true. Fixes the invariants-test path to the real location.
- **MODIFIED** `eslint.config.js` stops ignoring `apps/plugin/bin/**`; the two runtime `.mjs` bridges get at least `js.configs.recommended` (non-type-checked, since they're outside `projectService`). `apps/plugin/**` otherwise stays ignored.
- **MODIFIED** root `package.json` gains pass-through scripts (`dev`, `start`, `test:watch`, `test:coverage`) delegating to `@rembric/server`, so the documented commands work from the repo root; OR the docs are corrected to `cd apps/server` — the implementer picks one and makes docs+scripts consistent.
- **MODIFIED** CI no longer double-runs `install.test.ts`: it is excluded from the default vitest `include` (kept solely in the installer-e2e step) or dropped from the e2e step's vitest invocation — one run per CI, `sh -n` coverage preserved.
- Optional (low priority): a `node: [22, 24]` matrix on the Test job to catch forward-compat breaks in native modules before Node 22 leaves LTS.

Explicitly OUT of scope here (tracked separately): hardening of the published Docker image (boot smoke in the publish path, vulnerability scan, SBOM/provenance) — that touches the release pipeline and is unverifiable outside a real publish, so it is a separate proposal for owner review. Dependabot PR triage is an operator action, not a code change.

## Capabilities

### New Capabilities

(none)

### Modified Capabilities

- `development-environment`: adds a requirement that CI enforces the coverage gate and that developer-facing scripts/docs/thresholds are consistent with what CI actually runs, and that shipped plugin runtime code is linted.

## Impact

- `.github/workflows/ci.yml` (Test step → coverage; optional Node matrix; install.test.ts single-run).
- `apps/server/vitest.config.ts` (threshold values set to the honest measured floor).
- `eslint.config.js` (un-ignore `apps/plugin/bin/**`).
- `package.json` (root pass-through scripts) and/or `README.md` + `CONTRIBUTING.md` (script + threshold + invariants-path corrections).
- No product/runtime code, no DB, no spec-governed behavior of the server itself. Supply-chain knobs (`--frozen-lockfile`, `ignore-scripts`, `minimumReleaseAge`, `blockExoticSubdeps`) untouched — this only ADDS enforcement.
