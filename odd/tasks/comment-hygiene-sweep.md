# Comment-hygiene sweep

## Objective

Remove narrative comments and JSDoc of the kind the owner flagged: multi-line rationale blocks, docstrings that restate signatures, design-history explanations, and section dividers. The owner explicitly accepts losing the documented reasoning (the OpenSpec specs remain the contract).

## Scope

All shipped source: `apps/web/src/**`, `packages/db/src/**`, `packages/core/src/**`, `packages/mcp/src/**`, `packages/ui/src/**`, `packages/config/**` (config files), `apps/plugin/**/*.{mjs,ts,js}`. Shell scripts (`install.sh`, hooks) are OUT of scope this pass — the TUI installer contract requires an e2e pass for any edit there; removing shell comments buys nothing.

## Removal rules (given to every writer)

- REMOVE: multi-line `/** ... */` JSDoc and `/* ... */` narrative blocks; long `//` explanations (more than one line); `// ───` section dividers; comments referencing the migration, tasks, PRs, or commits.
- KEEP: ESLint/TS directives (`eslint-disable…`, `@ts-expect-error`, `@ts-ignore`); one-line justifying comments attached to `as unknown as` / `any` casts or genuine magic numbers (repo code-style requires them and lint-review will ask); `// @ts-nocheck`.
- When a removed block contains a real invariant (e.g. "must run on Node runtime"), drop the prose — the code/test pins the behavior; do not rewrite a shorter comment unless the writer judges absence would cost real time, and then at most one line.
- Comments in tests follow the same rules.

## Execution

Three parallel writers on disjoint surfaces (owner approved parallelization), launched only after the in-flight aggregate verification (V1, task `mud6xjkt-10-8k3g`) completes, because it runs the full suite against this worktree. One commit per writer surface is NOT required — a single `chore: strip narrative comments and JSDoc` commit after aggregate verification is acceptable if the owner prefers; default plan: one commit for the whole sweep + AGENTS.md convention update, pushed together.

## Tasks

- [ ] C1 `apps/web/src/**` writer (largest surface; includes middleware.ts whose header was the flagged example).
- [ ] C2 `packages/{db,core,mcp,ui}/src/**` writer.
- [ ] C3 `apps/plugin/**/*.{mjs,ts,js}` + `packages/config/**` writer (respect shared-module single-implementation invariants; no behavior edits).
- [ ] C4 AGENTS.md code-style section updated to the owner's new convention (no narrative/JSDoc comments; directives and cast justifications only).
- [ ] C5 Aggregate verification after the sweep: typecheck, lint, format:check, full `pnpm test`, `git diff --check`; then commit + push.

## Verification commands (each writer)

- `pnpm --filter <workspace> run typecheck` (or repo-level where appropriate)
- focused `vitest run` for the touched workspace's tests
- `pnpm exec prettier --check` on edited files
- `git diff --check`

Writers must not run git add/commit/checkout/restore/stash; parent owns commits. Parallel-writer rules: disjoint paths, file-copy backups for any probe, never touch siblings' files.
