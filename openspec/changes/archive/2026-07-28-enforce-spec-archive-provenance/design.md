## Context

`openspec/specs/` holds 24 capability specs, each at exactly `openspec/specs/<cap>/spec.md` (no other files live under that tree). They are the authoritative contract. The sanctioned write path is: open a change folder, write delta specs under `openspec/changes/<name>/specs/<cap>/spec.md`, implement, then archive — and archiving is where published text changes.

`.agents/skills/openspec-archive-change/SKILL.md` defines archiving as step 4 (sync deltas into `openspec/specs/`) followed immediately by step 5 (`mv openspec/changes/<name> openspec/changes/archive/YYYY-MM-DD-<name>`), with no commit in between. That gives a **mechanical, single-purpose signal**: a legitimate published-spec edit always co-occurs with a directory rename into `openspec/changes/archive/`, and nothing else in the repo produces that rename. The proposal measures the convention's violation rate at 8 of the last 40 spec-touching commits.

Constraints the design must respect:

- No new dependency (`npm-security-best-practices` would otherwise apply). Node 22 + `git` are both already present everywhere the check runs.
- `pnpm test` must stay runnable on a shallow clone and on a source tarball with no `.git` — so the rule cannot be an unconditional git query inside the test suite.
- release-please's automated commits touch only plugin version carriers (`release-please-config.json::extra-files`), never `openspec/**`, so the gate cannot false-red a release PR.

## Goals / Non-Goals

**Goals:**

- Make an undocumented published-spec edit fail CI, at PR time and on direct pushes to `main`.
- Zero false positives against real history (measured: 32 of 40 pass).
- Keep the rule testable without a network, a Docker daemon, or full git history.

**Non-Goals:**

- Validating that a spec is _true_. See D10.
- Validating a proposal's `Impact:` list against its delta set.
- Structural validation (`openspec validate`) in CI — separate, currently red on in-flight changes.
- Blocking a legitimate hand-edit forever: D7 keeps one auditable exit.

## Decisions

### D1 — The gate is a CI job, not an invariant test

`pull_request` (blocking) **and** `push: branches: [main]` (same job, same predicate). Rationale for the second trigger is measured: **5 of the 8 violations (`1814f7b`, `48b7c58`, `b14368d`, `ef4ac49`, `33c5ece`) were pushed straight to `main` with no PR**; a `pull_request`-only gate would have caught 3 of 8, i.e. it would have missed the majority of the behaviour it exists to stop. On `push` the job cannot block a merge, but it reds `main` and leaves a durable record.

Diff resolution:

- `pull_request` → `git diff --name-status --find-renames <base.sha>...<head.sha>`, i.e. the PR's aggregate diff. This is deliberately PR-scoped rather than commit-scoped: a PR that syncs specs in one commit and `mv`s the folder in the next still passes, which absorbs the sequencing caveat in D8.
- `push` → `${{ github.event.before }}..${{ github.sha }}`. When `before` is the all-zeros SHA (branch creation) or the range does not resolve (force-push), the job logs "range unresolvable, skipping" and exits 0. A skipped run is honest; a failing run on an unresolvable range would train people to ignore it.

_Alternatives considered._ (a) An assertion in `apps/server/src/test/invariants.test.ts` — rejected: that file asserts properties of the **working tree**, whereas this rule is diff-scoped, and a `git diff` inside a unit test breaks on shallow clones and `.git`-less tarballs. (b) A `.husky/pre-push` hook — it would catch direct pushes at source, but hooks are bypassable (`--no-verify`), computing the pushed range locally is fiddly, and it adds latency to every push; the `push: main` trigger gets the same coverage after the fact without either cost.

### D2 — The archive signal must be an **added or renamed** path, not a modified one

The predicate requires at least one `A` or `R` entry under `openspec/changes/archive/`. A modification is not enough.

Measured consequence: `11e0b78` (PR #280) edited `openspec/specs/tui-installer/spec.md` while **modifying** `archive/2026-07-17-installer-server-data-dir-permissions/{design,proposal}.md` — retroactively amending a closed change instead of opening a new one. Accepting modifications lets that pass, and worse, lets a typo fix in any archived file launder an arbitrary contract edit. Requiring A/R raises the violation count from 7/40 (17.5%) to 8/40 (20%) and the added case is a true positive.

Robustness note: if git's rename detection degrades a directory `mv` into delete+add (`diff.renameLimit` on a very large diff), the result is still an `A` under `archive/` — the predicate passes either way.

### D3 — Pair per capability, not merely per diff

For every `<cap>` whose `openspec/specs/<cap>/spec.md` is touched, the diff must contain an added or renamed `openspec/changes/archive/*/specs/<cap>/spec.md`.

**Re-measured at implementation time, correcting this design's earlier claim.** The per-capability rule flags **9 of the 40**, not "exactly the same 8". The ninth is `3baff49` (`feat(memory-entities): add deterministic entity index`), which archived `add-entity-index` with deltas for `dashboard`, `mcp-api`, `memory-entities` and `persistence` — and also rewrote a requirement in `openspec/specs/memory/spec.md`, for which the change folder carried no delta at all. That is a **true positive**, and precisely the mode this rule exists for: a legitimate archive laundering an unauthorised edit to a fourth capability. So the per-capability rule is not forward-looking-only as claimed below — it catches a real historical case the diff-level rule waves through, and the honest false-positive count is still zero (31 of 40 pass). `02b3a7c`, which modified 8 published specs, does pair all 8.

A second live instance landed while this change was being implemented: `82d672e` archived `guard-tool-description-truncation` (delta for `mcp-api`) while also editing `openspec/specs/plugin-session-protocol/spec.md` with no delta. Diff-level: pass. Per-capability: fail. Two measured cases in ~45 commits, so this is not a hypothetical.

Correction to the framing this change was proposed under: the per-capability rule would **not** have caught `reconcile-specs-with-shipped-behaviour` "amending 8 specs with a delta for only some". Verified — that commit is paired 8-for-8. Its `Impact:` prose named 11 capabilities including `claude-code-plugin` and `codex-distribution`, but it never touched those published specs, so no provenance rule can see the discrepancy; catching it requires comparing proposal prose to the delta set, which is out of scope (D10).

### D4 — Trigger on `A`, `M`, `D` and `R` of a published spec

Any appearance of `openspec/specs/*/spec.md` in the diff needs provenance, not just modification. A brand-new capability spec and a deleted one are exactly as contract-bearing as an edited one. Measured: the 3 commits in the window that **added** a published spec (`3baff49`, `65ed3d6`, `65def6f`) all already pair with an archive addition, so widening the trigger costs zero false positives. For the per-capability check (D3), a deleted published spec is satisfied by a delta under the same `<cap>` (the `## REMOVED Requirements` case) or by that same `<cap>` path being renamed.

### D5 — The rule is a pure predicate over parsed `--name-status` entries

`scripts/check-spec-provenance.mjs` exports a function taking `Array<{ status: 'A'|'M'|'D'|'R', path: string, newPath?: string }>` and returning a structured verdict (`{ ok, violations: [{ capability, reason }], exempt }`); the CLI wrapper shells out to `git diff --name-status --find-renames` and prints. The workflow step is a thin shim: `node scripts/check-spec-provenance.mjs --base "$BASE" --head "$HEAD"`.

This is what makes the evidence gate in `tasks.md` possible: the predicate is testable on synthetic fixtures with no git at all, and the eight-commit history replay is a separate test that self-skips when the SHAs are unreachable (shallow clone, tarball). No new dependency; `node:child_process` + `node:path` only.

_Alternative considered._ Inline shell in `ci.yml` — rejected: a 30-line awk pipeline in YAML cannot carry the regression test that proves the rule flags the eight measured commits, and this repo has been bitten by untested CI logic before.

### D6 — Location and language: `scripts/*.mjs` at the repo root, tested via vitest

The repo has no root `scripts/` directory yet; this creates it. Precedent for root-level tooling with a co-located test is `install.test.ts`, run through the server workspace's vitest (`pnpm run e2e:installer`). The guard follows it: `scripts/check-spec-provenance.test.ts`, wired so `pnpm test` runs it, plus a root script (`pnpm run check:spec-provenance`) so a contributor can run the gate locally against `main...HEAD` before pushing. `.mjs` rather than TS because it must run with bare `node` in CI before/without a build; `eslint .` already covers root `.mjs`.

### D7 — One auditable escape hatch: a commit trailer

A commit in the diff carrying `Spec-Provenance-Exempt: <reason>` (non-empty reason) suppresses the failure; the job echoes the trailer and the files it waved through. Needed because a genuine no-behaviour edit (a typo, a broken link, reverting a bad sync) should not require manufacturing a ceremonial change folder — and a gate with no exit is a gate that gets deleted at the first friction.

_Alternative considered._ A PR label (`spec-provenance-exempt`) — rejected: labels are mutable and vanish from history, so the exemption leaves no trace in `git log`. A trailer is permanent and greppable, which is the whole point of recording an exception.

### D8 — Make the single-commit convention a contract, not a habit

The guard depends on steps 4 and 5 of the archive skill landing in one commit. The skill currently _happens_ to do that; it does not promise it. An agent that committed the sync separately from the `mv` would trip the gate legitimately. Mitigation, cheap and included as a task: state the single-commit requirement explicitly in `.agents/skills/openspec-archive-change/SKILL.md`. Note that D1's PR-scoped diffing already absorbs the split whenever both commits ride the same PR — the skill text closes the direct-push case, which is where 5 of the 8 violations came from anyway.

### D9 — `fetch-depth: 0` on the gate job's checkout

`.github/workflows/ci.yml` uses `actions/checkout@v7` at the default `fetch-depth: 1` in all three jobs. A diff-based gate cannot resolve a base ref from a single commit. The new job sets `fetch-depth: 0`; the existing jobs are left alone (they do not need history, and deepening them would slow every run).

### D10 — Provenance only; truth is explicitly out of scope

`openspec validate --all` (CLI 1.6.0) is structural: it checks requirement/scenario shape. All 24 published specs pass it today — the only failures in a current run are in-flight change folders missing deltas — while `reconcile-specs-with-shipped-behaviour` had to hand-hunt dozens of false statements out of those same green files. **This guard would not have caught one of them.** The requirement text and the CI job name must therefore say "provenance", never "valid" or "correct", so a green check is not misread as a truthful contract. Content validation (spec-quoted tool arguments versus zod schemas, `Impact:` versus delta set, sync fidelity) is a much larger design surface and is deferred as a family, not silently dropped.

## Risks / Trade-offs

- **[Risk] The gate is satisfiable without honesty.** Someone can touch a published spec and drop an unrelated file into `archive/` to go green. → Mitigation: the per-capability pairing (D3) narrows the loophole to "add a file at exactly `archive/*/specs/<cap>/spec.md`", which is indistinguishable from doing the right thing. Accepted: this is a convention guard, not a security boundary.
- **[Risk] A legitimate archive split across two commits on a direct push fails the gate.** → Mitigation: D8 (skill states single-commit) plus D7 (trailer) as the manual exit. The PR path is unaffected (D1).
- **[Risk] Rename detection is heuristic.** A `mv` recorded as delete+add still leaves an `A` under `archive/`, so the predicate holds (D2). → Mitigation: an explicit fixture for the delete+add shape in the unit tests.
- **[Trade-off] `push: main` cannot block, only report.** → Accepted because it is the only trigger that sees the direct-push mode responsible for 5 of the 8 measured violations, and a red `main` is a signal the repo already reacts to.
- **[Trade-off] `fetch-depth: 0` costs a full-history fetch on one job.** → Accepted: the repo is small, the job runs no install and no build, and the alternative (fetching a single base ref by hand) is more moving parts for the same seconds.
- **[Risk] A green check gets read as "the spec is right".** → Mitigation: D10 — the job name, its failure message, and the requirement text all say _provenance_; the proposal states the limitation out loud.

## Migration Plan

Nothing to migrate: no runtime code, no schema, no DB access, no plugin file, no dashboard token. Existing installations carry no state this change touches, and no derived table (`memory_fts`, `memory_vec`, the three entity tables) is affected.

Deploy = merge. The gate becomes active on the next PR. Rollback = delete the `spec-provenance` job (and, optionally, `scripts/check-spec-provenance.*`); nothing else depends on it, and no history is rewritten. The eight historical violations are **not** retroactively repaired — the gate is diff-scoped and never re-evaluates old commits.

## Open Questions

1. **Should the gate also verify sync fidelity — that the text added to `openspec/specs/<cap>/spec.md` actually appears in the paired archived delta?** That would catch hand-editing _during_ a legitimate archive, which is the one drift mode surviving this design. Default taken: **no**, deferred with the content-validation family (D10), because a faithful sync is a merge, not a copy (a `## MODIFIED Requirements` delta legitimately reshapes surrounding text), so a substring check would false-red constantly. Revisit only with a real measurement of how often archive syncs diverge from their deltas.
2. **Should the archived change's `tasks.md` be required fully ticked at archive time?** Adjacent, cheap, and a different rule (working-tree, not diff — so it belongs in `invariants.test.ts`, not here). Default taken: **out of scope for this change**; recorded so it is not lost.

## Measured at review time, and it narrows what this gate claims

**Open Question 1 is answered: sync fidelity diverges routinely, not rarely.** Replaying all 31 passing commits and comparing lines added to `openspec/specs/<cap>/spec.md` against the paired archived delta found whole `#### Scenario:` blocks with no origin in the delta (`02b3a7c` for memory, memory-entities and retrieval-evaluation; `093e47c` for persistence) plus substantive prose with no delta origin in 18 capability/commit pairs — `02b3a7c` memory at 10 of 87 added lines, `96c0d0a` data-access 5 of 23, `6b12ee6` memory 6 of 43.

So the honest statement of what this gate blocks is narrower than proposed: **archiving change A while hand-editing capability A's own published spec is invisible to it**, and that is ordinary practice rather than an exotic route. `3baff49` was caught only because the capability it hand-edited happened to have no delta of its own. Closing that needs the sync-fidelity comparison Open Question 1 defers, and this change should not be read as having closed it.

**The two rules are one rule.** `pairedCapabilities ⊆ archiveArrivals`, so a non-empty pairing implies an arrival; the diff-level disjunct can never decide a case the per-capability check has not already decided. The requirement's "both of the following hold" describes the intent, not two independently reachable branches, and no test covers the diff-level bullet on its own.

**A capability rename always needs the trailer.** `R openspec/specs/old/spec.md → openspec/specs/new/spec.md` flags both names, and no delta can ever exist at `archive/*/specs/old/spec.md`, so a legitimate rename is a permanent false positive resolved only by the exemption. That is acceptable — a capability rename genuinely deserves a recorded reason — but it was undocumented.

**A `pull_request` run checks out the PR's own workflow and script.** A PR can neuter the gate in the same commit that violates it. Inherent to any non-`pull_request_target` check and not worth the escalated permissions to fix, but it means the `push: main` trigger is the load-bearing half, not the redundant one.

**Operational, before this can block anything:** `spec-provenance` is a new check name, so branch protection's required-checks list has to include it or a red gate will not prevent a merge.
