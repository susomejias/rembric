# Contributing to Rembric

Thanks for your interest. This document covers the local workflow and the
quality gates the repository enforces automatically.

## Local setup

This repo uses **pnpm** as its package manager (pinned via the
`packageManager` field in `package.json`). The fastest way to get a
compatible pnpm is via Corepack, which ships with Node 16.9+:

```bash
corepack enable
pnpm install
```

The `prepare` script wires up Husky on install, so the git hooks below are
active immediately. No further setup is required.

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

Every PR must keep coverage above the thresholds enforced by Vitest:

- statements ≥ 90%
- branches ≥ 85%
- functions ≥ 85%
- lines ≥ 85%

Critical invariants of the product (append-only, status state machine, scope
isolation, replaces-graph acyclicity, confirm-chain semantics) have
dedicated tests under `src/**/__tests__/invariants/`. **Do not** weaken or
delete these. If a feature genuinely requires changing an invariant, change
the spec first via an OpenSpec change.

For new code, add unit tests in `src/**/*.test.ts` next to the module, and
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

## Running locally

```bash
export REMBRIC_ADMIN_TOKEN=$(openssl rand -hex 32)
pnpm run dev    # tsc --watch in one terminal
pnpm start      # run the built server (after pnpm run build)
```

## Issues and PRs

- Search existing issues before opening a new one.
- For non-trivial changes, open an issue or draft PR early to align on
  approach.
- Keep PRs focused. One conceptual change per PR; multiple unrelated fixes
  belong in separate PRs.
