## 1. Documentation fixes (already applied locally, verify in-tree)

- [x] 1.1 Confirm `apps/plugin/README.md` lines 9–10 ship `…/main/apps/plugin/.hermes-plugin/install.sh` and `…/main/apps/plugin/.opencode-plugin/install.sh` (no occurrences of `…/main/plugin/…` left in the file). Verify via `grep -n 'main/plugin/' apps/plugin/README.md` returning empty.
- [x] 1.2 Confirm `apps/plugin/.hermes-plugin/README.md` ships the corrected URL in all three previously broken occurrences (primary install, inspect-first, update). Verify via `grep -c 'main/apps/plugin/' apps/plugin/.hermes-plugin/README.md` returning `3` and `grep -c 'main/plugin/' apps/plugin/.hermes-plugin/README.md` returning `0`.
- [x] 1.3 Confirm `apps/plugin/.opencode-plugin/README.md` ships the corrected URL on the primary install command. Verify via `grep -c 'main/apps/plugin/.opencode-plugin/install.sh' apps/plugin/.opencode-plugin/README.md` returning `1`.
- [x] 1.4 Confirm `apps/plugin/.hermes-plugin/__init__.py` ships the corrected URL in the module docstring. Verify via `grep -c 'main/apps/plugin/.hermes-plugin/install.sh' apps/plugin/.hermes-plugin/__init__.py` returning `1`.

## 2. CI invariant test

- [x] 2.1 Add a new test case to `apps/server/src/test/invariants.test.ts`. It SHALL: (a) list tracked files via `child_process.execSync('git ls-files', {cwd: repoRoot})`, (b) skip the three allow-listed spec files (`openspec/specs/open-source-distribution/spec.md`, `openspec/specs/hermes-agent-plugin/spec.md`, `openspec/specs/opencode-plugin/spec.md`), the test file itself, and any tracked file under `openspec/changes/` (active or archived — change dirs are work-in-progress docs), (c) read each remaining file with `fs.readFileSync` as UTF-8, (d) assert that the legacy install URL substring (the `…/main/plugin/` prefix under `raw.githubusercontent.com/susomejias/rembric/` and `github.com/susomejias/rembric/blob/`) does not appear. On failure, the error message MUST list the offending `<file>:<line>` matches.
- [x] 2.2 Run `pnpm vitest run apps/server/src/test/invariants.test.ts` and confirm the new case passes against the current tree (post-fix state from group 1).
- [x] 2.3 Negative check: temporarily revert one of the four fixes (e.g., `git checkout HEAD -- apps/plugin/.hermes-plugin/README.md`), re-run the same Vitest command, and confirm the invariant test fails with a message naming the offending file. Restore the fix afterward.

## 3. Spec sync

- [x] 3.1 Verify the proposal's "Modified Capabilities" list matches the spec delta in `openspec/changes/fix-plugin-install-urls-post-restructure/specs/open-source-distribution/spec.md`. There SHALL be exactly one delta file in this change.
- [x] 3.2 Run `openspec validate fix-plugin-install-urls-post-restructure --strict` and confirm it passes.

## 4. Validation gates

- [x] 4.1 Run `pnpm run typecheck` from the repo root. SHALL produce zero errors.
- [x] 4.2 Run `pnpm run lint` from the repo root. SHALL produce zero errors for in-scope files. Pre-existing warnings outside `apps/server/src/test/` and `apps/plugin/**` are out of scope for this change.
- [x] 4.3 Run `pnpm test` from the repo root. SHALL produce zero failures. The new invariant case appears in the suite count.
- [x] 4.4 Manual sanity: `curl -sI -o /dev/null -w "%{http_code}\n" https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh` SHALL return `200`. Same for the opencode equivalent.

## 5. Land

- [ ] 5.1 Commit on a feature branch with a Conventional Commit message: `fix(plugin): point per-client install URLs at apps/plugin after monorepo restructure`. Include the invariant test in the same commit.
- [ ] 5.2 Open a PR against `main` with a body that links to this change folder and to the spec the fix realigns reality with.
- [ ] 5.3 After merge, run `/opsx:archive fix-plugin-install-urls-post-restructure` to apply the spec delta to `openspec/specs/open-source-distribution/spec.md` and move the change to `openspec/changes/archive/`.
