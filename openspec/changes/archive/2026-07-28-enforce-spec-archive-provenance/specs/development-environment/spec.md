## ADDED Requirements

### Requirement: CI MUST reject a published-spec edit that arrives without an archive in the same diff

Text enters `openspec/specs/` only by archiving a change: the archive step syncs the change's delta specs into `openspec/specs/<capability>/spec.md` and moves the change folder to `openspec/changes/archive/YYYY-MM-DD-<name>/` in the SAME commit. CI SHALL enforce that provenance mechanically.

The repo SHALL ship a `spec-provenance` CI job that triggers on `pull_request` and on `push` to `main`, computes the diff for the event (the PR's aggregate base…head diff, or the pushed range), and FAILS when a path matching `openspec/specs/*/spec.md` is added, modified, deleted or renamed UNLESS, for EVERY affected capability `<cap>`, the same diff carries an **archive arrival** at `openspec/changes/archive/*/specs/<cap>/spec.md`. Failure SHALL name each unpaired capability and the path that would have satisfied the check.

An **archive arrival** is an *added* path under `openspec/changes/archive/`, or a *rename into* that tree whose source lies outside it and is not itself a published spec. Three shapes SHALL NOT count, each because it is a laundering route reachable in a single command:

- a **modified** archived file — editing an already-archived change in place is the same undocumented drift the gate exists to stop, and it would let a typo fix in any archived file carry an arbitrary contract edit;
- a rename whose **source is a published spec** — otherwise moving `openspec/specs/<cap>/spec.md` into the archive would prove its own provenance while deleting the contract;
- a rename **within** the archive — otherwise correcting a date prefix on an existing archive folder would pair every capability that folder happens to carry.

The per-capability pairing is the entire rule. Because a paired capability implies an arrival, a diff-level "at least one archive arrived" test can never decide a case the per-capability check has not already decided; it MAY be stated as intent but SHALL NOT be relied on as an independently reachable branch.

The job SHALL be exempted only by a `Spec-Provenance-Exempt: <reason>` **trailer** on a commit in the diff, and SHALL echo that reason and the published-spec paths it waived. Trailer matching SHALL be strict, because the literal key appears in prose this repo itself ships — this requirement, `.agents/skills/openspec-archive-change/SKILL.md`, and the job's own failure output all print it. The key SHALL therefore be matched only within a commit message's **last paragraph**, SHALL be anchored at the start of a line with **no leading whitespace**, and a reason that is empty or a placeholder (`-`, `.`, `n/a`, `none`, `tbd`, `todo`, `?`) SHALL NOT exempt the diff.

A **capability rename** (`openspec/specs/old/spec.md` → `openspec/specs/new/spec.md`) flags both names and can never be paired, because no delta can exist at the old path. Such a rename SHALL therefore always require the exemption trailer. This is a permanent property of the design rather than a defect: a capability rename genuinely deserves a recorded reason.

When the diff range cannot be resolved — a branch-creation push whose `before` SHA is all zeros, a force-push that leaves `before` unreachable, or unrelated histories with no merge base — the job SHALL exit successfully rather than fail on an unresolvable range, and SHALL report the skip as a GitHub **`::warning::` annotation** so that a permanently-skipping gate is visible in the run summary instead of reading as a pass. Ancestry between base and head SHALL NOT be required: `base...head` diffs from the merge base, so a PR whose base branch has advanced must still be checked.

The check SHALL be hardened against two fail-open modes, both of which produced a silent exit 0:

- `git diff` SHALL run with `-c core.quotepath=false`, because git octal-escapes non-ASCII paths and wraps them in quotes, which defeats the leading anchor in both path patterns.
- CLI entrypoint detection SHALL compare `import.meta.url` against `pathToFileURL(process.argv[1])`, never against an interpolated `file://` string — under a clone path containing a space the latter never matches, so the process exits 0 having run no check at all.

The job SHALL carry its OWN `concurrency` group with `cancel-in-progress: false`. The workflow-level group is keyed on `github.ref`, so every push to `main` shares one group and a second push would cancel the first — a violating direct push would then be cancelled rather than red, and 5 of the 8 measured violations were direct pushes.

The rule SHALL be implemented as a pure predicate over parsed `git diff --name-status` entries, so it is testable without git history, with the workflow step as a thin invocation. The job SHALL run bare `node` with no toolchain setup, no install and no build (the script depends only on `node:*` builtins), so it stays seconds long. Its checkout SHALL fetch enough history to resolve the base ref (`fetch-depth: 0`); the other CI jobs SHALL NOT be deepened for it.

This gate enforces **provenance, not truth**. It proves a published-spec edit came through a change folder and proves nothing about whether the text is accurate: `openspec validate` passed on all 24 published specs while they carried 35 false statements, and this gate would not have caught one of them. Its reach is narrower still in one ordinary case — **archiving change A while hand-editing capability A's own published spec is invisible to it**, because that capability is paired by its own delta regardless of what else the sync added. Measured over the same window, 18 capability/commit pairs added published prose with no origin in the paired delta, including whole `#### Scenario:` blocks. Closing that requires the sync-fidelity comparison this gate deliberately does not attempt. The job's name, its failure message, and its documentation SHALL say *provenance* and SHALL NOT claim that a passing run means the specs are correct or complete.

Correspondingly, `.agents/skills/openspec-archive-change/SKILL.md` SHALL state explicitly that the delta sync and the move into `openspec/changes/archive/` land in a single commit, so the signal the gate reads is a documented requirement of the archive procedure rather than an incidental habit.

Two limits are acknowledged rather than fixed. A `pull_request` run checks out the PR's own workflow and script, so a PR can neuter the gate in the same commit that violates it — inherent to any non-`pull_request_target` check, which makes the `push: main` trigger the load-bearing half rather than the redundant one. And `spec-provenance` is a new check name, so branch protection's required-checks list must include it before a red gate can prevent a merge.

#### Scenario: A PR that edits a published spec with no archive fails

- **GIVEN** a PR whose diff modifies `openspec/specs/mcp-api/spec.md` and touches nothing under `openspec/changes/archive/`
- **WHEN** the `spec-provenance` job runs
- **THEN** the job SHALL fail, naming `mcp-api` as unpaired and printing the archive path that would have satisfied the check
- **AND** the PR's overall status check SHALL be red

#### Scenario: A legitimate archive PR passes

- **GIVEN** a PR that syncs `openspec/changes/<name>/specs/<cap>/spec.md` into `openspec/specs/<cap>/spec.md` and renames `openspec/changes/<name>/` to `openspec/changes/archive/YYYY-MM-DD-<name>/`
- **WHEN** the `spec-provenance` job runs
- **THEN** the job SHALL pass for every capability the sync touched

#### Scenario: Editing an already-archived change in place does not launder a spec edit

- **GIVEN** a diff that modifies `openspec/specs/tui-installer/spec.md` and modifies (but neither adds nor renames) files under `openspec/changes/archive/<earlier-change>/`
- **WHEN** the `spec-provenance` job runs
- **THEN** the job SHALL fail, because no archive arrival is present

#### Scenario: Moving a published spec into the archive does not prove its own provenance

- **GIVEN** a diff whose only archive-bound entry renames `openspec/specs/<cap>/spec.md` to `openspec/changes/archive/<name>/specs/<cap>/spec.md`
- **WHEN** the predicate evaluates the diff
- **THEN** that rename SHALL NOT count as an archive arrival, and `<cap>` SHALL be reported unpaired — otherwise deleting a published contract would satisfy the gate

#### Scenario: Renaming an existing archive folder is not a fresh arrival

- **GIVEN** a diff that modifies published specs and renames `openspec/changes/archive/2026-01-01-<name>/` to `openspec/changes/archive/2026-01-02-<name>/` (correcting a date prefix)
- **WHEN** the predicate evaluates the diff
- **THEN** no rename within the archive SHALL count as an arrival, so the capabilities the renamed folder carries SHALL NOT become paired

#### Scenario: Archiving one capability does not license editing another

- **GIVEN** a diff that adds `openspec/changes/archive/YYYY-MM-DD-<name>/specs/sessions/spec.md` and modifies both `openspec/specs/sessions/spec.md` and `openspec/specs/codex-distribution/spec.md`
- **WHEN** the `spec-provenance` job runs
- **THEN** the job SHALL fail, naming `codex-distribution` as unpaired, and SHALL NOT report `sessions`

#### Scenario: A new or deleted published spec needs the same provenance

- **GIVEN** a diff that adds `openspec/specs/<new-cap>/spec.md`, or deletes an existing `openspec/specs/<cap>/spec.md`, with no archive arrival for that capability
- **WHEN** the `spec-provenance` job runs
- **THEN** the job SHALL fail for that capability
- **AND** a delta under the same `<cap>` (the `## REMOVED Requirements` case) SHALL satisfy a deletion

#### Scenario: A directory move recorded as delete-plus-add still counts as an archive

- **GIVEN** a diff in which the archive move was recorded as separate delete and add entries rather than renames (rename detection degraded)
- **WHEN** the predicate evaluates the diff
- **THEN** the added `openspec/changes/archive/…` paths SHALL satisfy the check exactly as renames would

#### Scenario: A direct push to main is evaluated and survives a following push

- **GIVEN** a commit pushed directly to `main` that modifies a published spec with no archive arrival, followed immediately by a second push to `main`
- **WHEN** the `spec-provenance` job runs for the first push
- **THEN** the job SHALL fail, so `main` carries a visible record of the undocumented edit
- **AND** the second push SHALL NOT cancel that run, because the job's own `concurrency` group is keyed off the workflow-level `github.ref` group and sets `cancel-in-progress: false`

#### Scenario: An exemption is recorded in history

- **GIVEN** a diff that modifies a published spec with no paired archive, and a commit in that diff whose last paragraph is `Spec-Provenance-Exempt: fixes a broken link, no requirement change`
- **WHEN** the `spec-provenance` job runs
- **THEN** the job SHALL pass and SHALL print both the reason and the published-spec paths it waived
- **AND** the trailer SHALL be honoured from any commit in the range, not only the tip, and SHALL NOT be honoured from a commit outside the range

#### Scenario: Neither prose nor a placeholder reason exempts a diff

- **GIVEN** a diff that modifies a published spec with no paired archive
- **WHEN** the only occurrence of the key is in an earlier paragraph of a commit message, or is indented, or carries an empty or placeholder reason (`-`, `.`, `n/a`, `none`, `tbd`, `todo`, `?`)
- **THEN** the job SHALL still fail — a commit message merely *describing* this feature SHALL NOT waive the range

#### Scenario: A capability rename always requires the trailer

- **GIVEN** a diff that renames `openspec/specs/<old-cap>/spec.md` to `openspec/specs/<new-cap>/spec.md`
- **WHEN** the `spec-provenance` job runs
- **THEN** both capability names SHALL be reported unpaired, since no delta can exist at the old path
- **AND** the only way to land the rename SHALL be the exemption trailer, permanently

#### Scenario: An unresolvable range is annotated, not silently passed

- **GIVEN** a push whose `before` SHA is all zeros, or a force-push whose `before` no longer resolves
- **WHEN** the `spec-provenance` job runs
- **THEN** the job SHALL exit 0
- **AND** it SHALL emit a `::warning::` annotation naming why the range was unresolvable, so a gate that keeps skipping is visible rather than reading as a pass

#### Scenario: The predicate is testable without git history

- **GIVEN** a checkout with no `.git` directory or a shallow clone
- **WHEN** `pnpm test` runs
- **THEN** the predicate's unit tests SHALL execute against synthetic diff entries and pass
- **AND** any test that replays real commits SHALL skip itself rather than fail when those commits are unreachable

#### Scenario: A PR that changes no published spec is unaffected

- **GIVEN** a PR that touches only source, docs, or an active (non-archived) change folder
- **WHEN** the `spec-provenance` job runs
- **THEN** the job SHALL pass without requiring anything under `openspec/changes/archive/`
