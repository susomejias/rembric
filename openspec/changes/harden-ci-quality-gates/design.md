# Design — harden-ci-quality-gates

## Context

CI (`.github/workflows/ci.yml`) runs lint → typecheck → `pnpm test` → installer-e2e → build. `pnpm test` resolves to `vitest run` with no coverage. `apps/server/vitest.config.ts` defines a v8 coverage config with thresholds of 50 and a comment saying they'll ratchet up. `CONTRIBUTING.md` claims 90/85 and "CI matches this". `eslint.config.js` ignores `apps/plugin/**` wholesale. Root `package.json` lacks `dev`/`start`/`test:watch`/`test:coverage`.

## Goals / Non-Goals

**Goals:** every documented developer guarantee is either enforced or corrected to the truth. No aspirational thresholds, no dead config, no docs that don't work.

**Non-Goals:**

- Raising coverage (a threshold ratchet is a follow-up once the gate is live; this change only makes the gate REAL).
- Type-checked linting of the plugin bridges (they're outside the TS `projectService`; recommended-rules lint is the right first bar).
- Docker publish/image hardening (separate owner-reviewed proposal).
- Any change to the supply-chain enforcement knobs.

## Decisions

### D1: Enforce the gate at the honest current floor, don't fake a number

The implementer runs `pnpm --filter @rembric/server run test:coverage` locally, reads the real numbers, and sets `vitest.config.ts` thresholds to a value at or just below current real coverage (rounded down to a stable floor). CI then runs `test:coverage` instead of `test` for the server package. This guarantees the gate is green on the current tree AND catches future regressions. `CONTRIBUTING.md` is updated to state these exact numbers plus "we ratchet these up as coverage grows; never lower them to make a PR pass".

**Alternative considered:** set thresholds to the documented 90/85 immediately. Rejected: if real coverage is below that, CI goes permanently red; the honest floor + ratchet policy is the sustainable path and matches the existing config comment's intent.

**Why run coverage instead of plain test in CI:** v8 coverage adds modest overhead but the model-prefetch + install already dominate CI wall-clock; a single coverage run replaces the plain run (not in addition), so the net cost is small and the gate becomes load-bearing.

### D2: Lint the shipped bridges, nothing else new under apps/plugin

Remove `apps/plugin/bin/**` from the ESLint `ignores`. Apply `js.configs.recommended` to `**/*.mjs` under that path (flat-config override without `languageOptions.parserOptions.projectService`, so no type-check requirement). Fix whatever `no-unused-vars`/`no-undef`/`no-floating-promises`-adjacent issues surface (expected: few or none — the bridges are small and careful). The rest of `apps/plugin/**` (per-client manifests, shell, Python) stays ignored.

### D3: Make root scripts match the docs (pass-throughs), not the reverse

Add to root `package.json`: `"dev": "pnpm --filter @rembric/server run dev"`, `"start": "pnpm --filter @rembric/server run start"`, `"test:watch": "pnpm --filter @rembric/server run test:watch"`, `"test:coverage": "pnpm --filter @rembric/server run test:coverage"`. Keeps the documented root-level ergonomics working. Also fix the `CONTRIBUTING.md` invariants-test path to `apps/server/src/test/{invariants,runtime-invariants}.test.ts`.

**Alternative considered:** rewrite the docs to say `cd apps/server`. Rejected: the root-level workflow is the friendlier onboarding path and cheap to support with pass-throughs.

### D4: Single install.test.ts run

The Test step already runs `install.test.ts` via the server vitest `include` (`'../../install.test.ts'`). Remove it from that default `include` so it runs ONLY in the dedicated installer-e2e step (which also does the `sh -n` shell-syntax checks the Test step doesn't). Net: one vitest execution of the installer suite per CI, `sh -n` coverage unchanged.

**Alternative considered:** drop the vitest call from `e2e:installer` and keep it in the Test include. Rejected: the e2e step is the semantically correct owner of installer verification (it pairs the vitest run with `sh -n`), and keeping the heavy suite out of the general Test include speeds the common path.

### D5: Node matrix is optional and gated on appetite

A `strategy.matrix.node: [22, 24]` on the Test job catches native-module forward-compat breaks (better-sqlite3, onnxruntime-node) before Node 22 leaves LTS. It doubles the Test job's runtime. Marked optional in tasks; implement only if the extra CI minutes are acceptable — the runtime image is `distroless/nodejs22`, so 24 is a forward-compat signal, not a deploy target.

## Risks / Trade-offs

- [Risk] Running coverage reveals real coverage below the 50 the config claims, and setting an honest floor looks like a "downgrade". → Mitigation: the 50 was never enforced, so there is no downgrade; the CHANGELOG states the gate is newly real at the measured floor.
- [Risk] Un-ignoring the bridges surfaces lint errors that block the PR. → Mitigation: fix them in the same change (they are small); if a rule is genuinely wrong for a bridge, disable it narrowly with a justifying comment.
- [Trade-off] Node matrix doubles Test time. → Accepted only if the user opts in; left optional.

## Migration Plan

CI-config only; effective on the next PR. No runtime, no image, no DB. Rollback: revert the workflow/config commit.

## Open Questions

(none — D1's exact threshold numbers are resolved by measurement during implementation)
