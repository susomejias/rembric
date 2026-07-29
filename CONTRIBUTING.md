# Contributing to Rembric

Thanks for your interest. This document covers the local workflow and the
quality gates the repository enforces automatically.

## Local setup

This repo uses **pnpm** as its package manager (pinned via the
`packageManager` field in `package.json`; currently `pnpm@11.1.2`). The fastest
way to get a compatible pnpm is via Corepack, which ships with Node 16.9+:

```bash
corepack enable
pnpm install
```

The `prepare` script wires up Husky on install. Husky's `prepare` is allowlisted
as `true` in `pnpm-workspace.yaml::allowBuilds` — every dependency not listed
there has its lifecycle scripts blocked by `.npmrc::ignore-scripts=true`. That
file is the complete, justified set: each entry carries the reason it exists on
its own line. See the [Adding a dependency](#adding-a-dependency) section below.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org/). The
`commit-msg` hook runs `commitlint` against every commit message and rejects
those that don't conform. Accepted types include:

- `feat:` — a new feature
- `fix:` — a bug fix
- `refactor:` — code change that neither fixes a bug nor adds a feature
- `perf:` — performance improvement
- `test:` — adds or updates tests
- `docs:` — documentation only
- `build:` — build system or external dependencies
- `ci:` — CI configuration
- `chore:` — other changes that don't affect the source code
- `style:` — formatting (rarely needed; Prettier handles this)
- `revert:` — reverts a previous commit

Examples:

```
feat(consolidation): add contradiction detector
fix(mcp): reject missing Authorization header with 401
docs(readme): document REMBRIC_ADMIN_TOKEN
```

A scope is optional. A body is encouraged for non-trivial changes; reference
the OpenSpec change name when relevant (`Refs: add-rembric`).

## Hooks (automatic on every commit/push)

| Hook         | What it runs                                                                        |
| ------------ | ----------------------------------------------------------------------------------- |
| `pre-commit` | `lint-staged` (Prettier + ESLint on staged files) then `tsc --noEmit --incremental` |
| `commit-msg` | `commitlint --edit "$1"`                                                            |
| `pre-push`   | `pnpm test` (full suite)                                                            |

If a hook fails, the commit or push is rejected. Fix the underlying issue
and try again — never bypass with `--no-verify` for normal development.

## Code style

- **TypeScript strict mode**. No `any` without a written justification in a
  comment, no `as unknown as T` without the same.
- **No floating promises**. The ESLint rule will reject any `await`-able you
  forgot to `await` or `void`.
- **Consistent type imports**. `import type { Foo } from '...'` for types,
  `import { foo } from '...'` for values. ESLint will auto-fix.
- **Imports ordered** by group (builtin / external / internal / relative)
  and alphabetized. ESLint auto-fixes.
- **Formatting** is Prettier's job. Don't argue with it.

## Tests

Every PR must keep coverage at or above the thresholds enforced by Vitest
(`apps/server/vitest.config.ts`). CI runs `pnpm --filter @rembric/server run
test:coverage`, so the gate below fails the build on any PR that drops below
it:

- statements ≥ 85%
- branches ≥ 78%
- functions ≥ 91%
- lines ≥ 85%

These are an enforced floor set at (rounded down from) current real coverage,
not an aspirational target. The ratchet is **up-only**: raise them as coverage
grows; never lower them to make a PR pass. Keep these numbers identical to the
`thresholds` block in `apps/server/vitest.config.ts`.

Critical invariants of the product (append-only, status state machine, scope
isolation, replaces-graph acyclicity, confirm-chain semantics) have
dedicated tests in
`apps/server/src/test/{invariants,runtime-invariants}.test.ts`. **Do not**
weaken or delete these. If a feature genuinely requires changing an invariant,
change the spec first via an OpenSpec change.

For new code, add unit tests in `apps/server/src/**/*.test.ts` next to the module, and
integration / E2E tests where the boundary lives. Run with:

```bash
pnpm test                # full suite, one-shot
pnpm run test:watch      # watch mode
pnpm run test:coverage   # gated thresholds; CI matches this
```

## OpenSpec

Behavioral changes are tracked under `openspec/changes/<change-name>/`.
Before changing a requirement, read the existing spec and the design
document. If you're proposing a behavior change, open a new change with
`openspec new change <name>` and follow the spec-driven workflow.

**`openspec/specs/` is edit-gated in CI.** A diff that changes a published
`openspec/specs/<capability>/spec.md` must also add the archived change folder
that carries the delta for that same capability — which is what archiving does,
so following the workflow satisfies it automatically. Check before pushing:

```bash
pnpm run check:spec-provenance
```

To record a deliberate exception (correcting spec text that was merely wrong or
incomplete, or renaming a capability), add a `Spec-Provenance-Exempt: <reason>`
trailer to a commit in the range. The reason has to say something — `n/a` and
`-` are rejected. The gate proves provenance, not correctness: it says nothing
about whether the spec text is true.

## Running locally

```bash
export REMBRIC_ADMIN_TOKEN=$(openssl rand -hex 32)
pnpm run dev    # tsc --watch in one terminal
pnpm start      # run the built server (after pnpm run build)
```

## Adding a dependency

Read [`.agents/skills/npm-security-best-practices/SKILL.md`](.agents/skills/npm-security-best-practices/SKILL.md)
before adding any new runtime or dev dependency. The full 17-practice
reference and the per-package-manager support matrix live there. For day-to-day
work, the load-bearing items are:

- **Lockfile integrity** is enforced by three pnpm-native defenses inside
  `pnpm install --frozen-lockfile` (the `Install` step in
  `.github/workflows/ci.yml`): (a) lockfile must exactly match `package.json`,
  (b) every tarball's integrity hash must match what the lockfile claims, and
  (c) `blockExoticSubdeps: true` refuses git URLs and non-registry tarballs.
  `lockfile-lint` v4.x does NOT support `pnpm-lock.yaml`, so it isn't used here
  — see `.agents/skills/npm-security-best-practices/SKILL.md` practice #5 for
  the rationale.
- **Lifecycle scripts are blocked** for every dep except those set to `true` in
  `pnpm-workspace.yaml::allowBuilds`, which is the only place their membership is
  enumerated. If a new dep declares a `postinstall` that genuinely needs to run
  (e.g., a new native binding), add an explicit `<pkg>: true` line with a trailing
  comment saying why, in the same PR, and call it out in the description — that's
  a security-relevant decision and reviewers should see it. A new `true` entry
  also has to be added to `ALLOWED_BUILD_SCRIPTS` (`grep -rn ALLOWED_BUILD_SCRIPTS`)
  or `pnpm test` fails; that is deliberate, so the grant is reviewed rather than
  noticed later.
- **Install cooldown**: `pnpm-workspace.yaml::minimumReleaseAge: 4320` (3 days)
  blocks versions younger than 3 days from being installed. If you need to
  bypass for a genuine security patch:

  ```bash
  pnpm install --no-minimum-release-age
  ```

  Use sparingly and document the reason in the PR description.

- **Exotic sources are blocked**: a dep that ends up pulling from a git URL or
  non-registry tarball SHALL cause install to fail. If you hit this on a
  legitimate dep, identify the offending transitive and either upgrade past it,
  pin a clean version, or as a last resort document the exception in a
  follow-up PR.

## Issues and PRs

- Search existing issues before opening a new one.
- For non-trivial changes, open an issue or draft PR early to align on
  approach.
- Keep PRs focused. One conceptual change per PR; multiple unrelated fixes
  belong in separate PRs.
