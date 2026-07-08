# Tasks — harden-ci-quality-gates

## 1. Coverage gate becomes real

- [x] 1.1 Run `pnpm --filter @rembric/server run test:coverage`; record real lines/functions/branches/statements. Set `apps/server/vitest.config.ts` thresholds to a stable floor at or just below the measured values (round down; up-only ratchet).
- [x] 1.2 `.github/workflows/ci.yml`: replace the server portion of the Test step so it runs `test:coverage` (coverage gate enforced), keeping the Hermes plugin test path intact.
- [x] 1.3 `CONTRIBUTING.md`: state the exact enforced thresholds + up-only ratchet policy; remove/repair the inaccurate "statements ≥ 90% …" and "CI matches this" claims so they are true.

## 2. Lint reach

- [x] 2.1 `eslint.config.js`: remove `apps/plugin/bin/**` from `ignores`; add a flat-config override applying `js.configs.recommended` to `apps/plugin/bin/**/*.mjs` without type-checked rules.
- [x] 2.2 Fix any lint findings surfaced in the two bridges (narrow, justified `eslint-disable` only if a rule is genuinely wrong for a bridge). `pnpm run lint` green.

## 3. Honest dev scripts & doc paths

- [x] 3.1 Root `package.json`: add pass-through scripts `dev`, `start`, `test:watch`, `test:coverage` delegating to `@rembric/server` (design D3). (If the user prefers doc-only fix, correct README/CONTRIBUTING to `cd apps/server` instead — pick ONE and keep docs+scripts consistent.)
- [x] 3.2 `CONTRIBUTING.md`: fix the invariants-test path to `apps/server/src/test/{invariants,runtime-invariants}.test.ts`.

## 4. Single installer-suite run

- [x] 4.1 Ensure `install.test.ts` runs exactly once per CI run, via `e2e:installer` only. Deviation from the literal instruction: removing `'../../install.test.ts'` from the vitest `include` breaks `e2e:installer` too — vitest's positional file filter can only narrow an already-`include`d file, not add one outside it, so `vitest run ../../install.test.ts` fails with "No test files found" once it's dropped from `include`. Kept it in `include` (with a comment explaining why) and instead added `--exclude '../../install.test.ts'` to `apps/server/package.json`'s `test` and `test:coverage` scripts, so the default runs (and thus CI's Test step) skip it while `e2e:installer`'s explicit invocation still finds and runs it. Net effect matches the requirement: one run per CI, `sh -n` coverage unchanged.

## 5. Optional Node matrix

- [ ] 5.1 SKIPPED (optional). Not implemented — doubling the Test job's runtime for a forward-compat signal on a non-deploy-target Node version wasn't judged worth the added CI minutes for this change. Left as a future opt-in.

## 6. Gates

- [x] 6.1 `pnpm run typecheck && pnpm run lint && pnpm test && pnpm run e2e:installer` green locally; verified `pnpm --filter @rembric/server run test:coverage` passes at the new floor.
- [x] 6.2 `openspec validate harden-ci-quality-gates --strict` green.
- [x] 6.3 NOT VERIFIABLE LOCALLY: the CI workflow changes themselves only exercise on GitHub Actions — validated YAML syntax and logic by inspection; the first PR run is the real check.
