## Why

`openspec/specs/` is this repo's authoritative contract (`CLAUDE.md`), and the only sanctioned route for text to enter it is a change folder's delta spec, synced at archive time. Nothing enforces that, and the convention is violated at a **measured 20%**.

Across the last 40 commits touching `openspec/specs/` (`77cbc2f..1814f7b`), **eight modified a published spec with no change folder entering `openspec/changes/archive/` in the same diff**:

| commit    | subject                                                         | published spec(s) edited             | PR   |
| --------- | --------------------------------------------------------------- | ------------------------------------ | ---- |
| `1814f7b` | fix(memory): honour the documented "any but archived" default   | `mcp-api`                            | none |
| `48b7c58` | feat(entities): add four kinds, fix two mis-extractions         | `memory-entities`                    | none |
| `b14368d` | feat(mcp): reinforce explicit sessionId                         | `mcp-api`, `plugin-session-protocol` | none |
| `ef4ac49` | fix(plugin): capture opencode assistant text                    | `opencode-plugin`                    | none |
| `33c5ece` | fix(installer): drop the removed codex plugin_hooks step        | `tui-installer`                      | none |
| `11e0b78` | fix(installer): never relax an already-correctly-owned `./data` | `tui-installer`                      | #280 |
| `45fe9f0` | Unify per-turn nudges                                           | `codex-distribution`                 | #235 |
| `f320036` | fix(mcp): require write authz for `project.use` autocreate      | `mcp-api`                            | #223 |

`45fe9f0` is the sharpest: it edited the published `codex-distribution/spec.md` directly **while carrying delta specs for that same capability** at `openspec/changes/proactive-save-nudges/specs/codex-distribution/spec.md` — the correct channel was open and bypassed anyway.

The cost is a contract that silently disagrees with itself. `46d5ded` landed self-inconsistent: its delta spec asserted that "an archived row under a given key is therefore reachable through the lexical and listing branches" while the **same commit** added the opposite docstring to `findMemoriesByEntity` ("An omitted `status` means 'any but archived'"). That delta was synced verbatim into `mcp-api/spec.md` by the archive commit `02b3a7c`, so the published contract carried the false statement until `1814f7b` corrected it — and `1814f7b` is itself one of the eight, so the fix arrived by the same undocumented route as the drift.

**The convention is breached by people who know it.** Two violations landed _while this gate was being designed and built_, in the same batch of work, by sessions holding the rule in context. `1b41583` (`fix(dev): keep the dev stack off the published production image tag`) edited `openspec/specs/development-environment/spec.md` to add an `image:` isolation bullet with no change folder at all — the very capability whose spec this change amends. `82d672e` archived one change and hand-edited a second capability's published spec in the same commit. Knowing the convention is demonstrably not sufficient to follow it, which is the whole argument for mechanising it: this is not a knowledge gap to be closed with better documentation, it is a discipline gap that only a gate closes. Both are used as regression fixtures below.

Two measurements the design turns on:

- **5 of the 8 violations were pushed directly to `main` with no PR.** A `pull_request`-only gate would have caught 3 of 8. The gate therefore also runs on `push: main`, where it cannot block but does turn `main` red and leaves a record.
- **False-positive rate is zero.** 32 of 40 pass the diff-level rule; 31 of 40 pass the per-capability rule, the difference being one further true positive (`3baff49`, above). The eighth (`11e0b78`) fails only because the rule demands an _added or renamed_ archive path: it modified an already-archived proposal in place (`archive/2026-07-17-installer-server-data-dir-permissions/{design,proposal}.md`) alongside the published spec — retroactively rewriting a closed change instead of opening a new one, which is the same drift class, not an exception to it. Under the looser "any archive path touched" reading the count is 7 of 40 (17.5%) and `11e0b78` escapes; that reading is also satisfiable by a typo fix in any archived file, so it is rejected.

Nothing in the repo can currently detect this. `apps/server/src/test/invariants.test.ts` names `openspec/` only as documentation allow-list entries for the 404-contract invariant (`:602-604`). `.github/workflows/{ci,docker-publish,release-please}.yml` contain zero occurrences of `openspec`. `.husky/{pre-commit,commit-msg,pre-push}` run lint-staged + `pnpm -r run typecheck`, commitlint, and `pnpm test` respectively — none is spec-aware. lint-staged sends `*.{json,md,yml,yaml}` to prettier only.

**Stated limitation: this guard enforces provenance, not truth.** `openspec validate --all` (CLI 1.6.0) is structural — it checks requirement/scenario shape. All 24 published specs pass it today (the only failures in the run are in-flight changes missing deltas) while containing the dozens of divergences `reconcile-specs-with-shipped-behaviour` had to hunt by hand. This guard would not have caught a single one of them. It prevents _undocumented_ drift; a green check must not be read as a truthful contract.

## What Changes

- **Add a CI gate**: if a diff modifies, deletes, or renames `openspec/specs/<cap>/spec.md`, the same diff MUST contain an **added or renamed** path under `openspec/changes/archive/`. Chosen because the signal is mechanical and already exists: per `.agents/skills/openspec-archive-change/SKILL.md`, archiving is step 4 (sync deltas into `openspec/specs/`) then step 5 (`mv openspec/changes/<name> openspec/changes/archive/YYYY-MM-DD-<name>`) with no commit in between, and nothing else in the repo produces that rename.
- **Pair per capability, not just per diff**: each modified `<cap>` requires an added/renamed `openspec/changes/archive/*/specs/<cap>/spec.md`. Measured against the same 40 commits this flags **9**, one more than the diff-level rule, and the extra one is a true positive: `3baff49` archived `add-entity-index` (deltas for `dashboard`, `mcp-api`, `memory-entities`, `persistence`) while also rewriting a requirement in `openspec/specs/memory/spec.md` that no delta covered. `02b3a7c`, which touches 8 published specs, pairs all 8. So this rule blocks "archive change A while hand-editing capability B's published spec" — and that has already happened twice: `3baff49` in the measured window, and `82d672e` while this very change was being implemented (delta for `mcp-api`, undocumented edit to `plugin-session-protocol`).
- **Run on `pull_request` (blocking) and `push: main` (reporting)**, for the 5-of-8 direct-push finding above.
- **`.github/workflows/ci.yml` gets `fetch-depth: 0`** on the gate job's `actions/checkout` — it is currently at the default `fetch-depth: 1`, and a diff-based gate cannot resolve a base ref from a single commit.
- **The rule is a pure predicate over `git diff --name-status` entries**, in `scripts/check-spec-provenance.mjs`, with the workflow as a thin shim. Rejected: inline shell in the workflow (untestable, and the evidence gate below requires a replay); rejected: an assertion in `invariants.test.ts` (that file asserts properties of the working tree, and `git diff` inside a unit test breaks on shallow clones and source tarballs).
- **One auditable escape hatch**: a `Spec-Provenance-Exempt: <reason>` trailer on a commit in the diff, echoed in the CI log. Rejected: a PR label (disappears from history, so the exemption leaves no trace in `git log`).
- **Make the convention a contract**: state in `.agents/skills/openspec-archive-change/SKILL.md` that steps 4 and 5 land in a single commit. Today the guard depends on a sequence the skill happens to follow rather than one it promises; an agent that committed between them would trip the gate legitimately. (PR-scoped diffing already absorbs the split when both commits are in one PR; the skill text closes the direct-push case.)
- **Not in scope: content validation.** Checking spec-quoted tool arguments against zod schemas, or an `Impact:` list against the delta set, is a prose/AST-parsing surface that would change the shape of this change. Noted below as deliberately deferred.

## Capabilities

### New Capabilities

_None._ A `spec-governance` capability was considered and rejected: one CI gate does not justify a 25th spec, and `development-environment` already owns the repo's CI-gate requirements.

### Modified Capabilities

- `development-environment`: **ADDED** one requirement — CI MUST reject a published-spec edit that arrives without an archive in the same diff. This spec already carries the repo's CI-gate contract (`CI MUST verify both Dockerfile stages build cleanly on every change`, `CI MUST enforce the coverage gate…`), so a new CI gate belongs beside them. `supply-chain-hygiene` was checked and rejected as the home: its CI requirements are scoped to the dependency threat model (frozen lockfile, install cooldown, `blockExoticSubdeps`), not to repo process.

## Impact

- **New**: `scripts/check-spec-provenance.mjs` (predicate + CLI), `scripts/check-spec-provenance.test.ts` (synthetic fixtures + history replay).
- **Modified**: `.github/workflows/ci.yml` (new `spec-provenance` job; `fetch-depth: 0` on its checkout), `package.json` (root `check:spec-provenance` script), `eslint.config.js` (root `scripts/*.mjs` join the non-type-checked `.mjs` block; the new test file joins `install.test.ts`'s default-project allow-list), `apps/server/vitest.config.ts` (`../../scripts/*.test.ts` added to `include`), `.agents/skills/openspec-archive-change/SKILL.md` **and** its non-symlinked tracked copy at `.claude/skills/openspec-archive-change/SKILL.md` (single-commit requirement — the openspec CLI skills are duplicated rather than symlinked, contrary to `CLAUDE.md § Skills`, and the `.claude/` copy is the one the Skill tool loads), `openspec/specs/development-environment/spec.md` (at archive time only).
- **No load-bearing invariant crossed**: no migration, no schema change, no MCP tool, no SQL, no plugin-tree file, no dashboard token. Existing installations are unaffected — this change ships no runtime code and no DB access, so there is nothing to migrate, no derived table to invalidate, and rollback is deleting a workflow job.
- **Deliberately deferred** (do not silently lose): spec _content_ validation against code; `Impact:`-list-versus-delta-set consistency (the reconcile change named 11 capabilities in Impact while touching 8 published specs — legitimate, and no provenance rule can see it); adding `openspec validate --all --strict` to CI, which fails today because in-flight change folders lack deltas and would need a specs-only scope first.
