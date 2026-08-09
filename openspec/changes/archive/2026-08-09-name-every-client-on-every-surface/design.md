# Design

## Context

Rembric ships five plugin clients. Twelve tracked surfaces at HEAD name a subset of them as if it were the whole set, or name the wrong mechanism for one of them. `fix-stale-client-count-surfaces` (archived 2026-08-08) fixed the surfaces whose text contained the literal word "four"; its acceptance grep is `four clients|FOUR clients|all four`, so it structurally could not reach the three families this change addresses.

Two constraints shape every decision below.

**The delta mechanism is not free to choose.** Two of the three defects sit in text that a `## MODIFIED` block cannot legally change — a scenario title and a requirement header. The mechanism was measured against the real gates (`openspec validate --strict`, `openspec archive`, `pnpm run check:delta-freshness`), eight arms, each with a control arm that had to pass. Findings in D1.

**Nothing pinned eleven of the twelve surfaces.** That is the finding, not an aside. A change that only edits the eleven leaves the same hole open for the sixth client. Hence D5 and the coverage tasks.

## Goals / Non-Goals

**Goals:**

- Every surface that enumerates Rembric's clients names all five, or is a deliberate, defensible subset statement.
- The two published specs that disagree about whether Hermes consumes `initialize.instructions` stop disagreeing.
- The login footer acquires the first test it has ever had, with a mutation proving that test can fail.
- This change's own acceptance criterion is enumeration-shaped, so it can see what the count-shaped one could not.

**Non-Goals:**

- Rewriting historically-scoped ordinals. `opencode-plugin/spec.md:497,516` and `hermes-agent-plugin/spec.md:304` ("a fourth supported client") describe the state at the time they were written. The ordinal is stale; the requirement's force still holds; rewriting costs a rename for nothing.
- Broadening `pi-plugin`'s acceptance scenario (`:436-438`). See D5.
- Auditing `.github/` beyond the two files named. The bug form and the PR checklist are in scope because each was independently verified defective; "audit every workflow file" is a different change.
- The two installer skills the docs sweep flagged (`rembric-tui-installer/SKILL.md:41`, `rembric-tui-installer-e2e/SKILL.md:110`). They belong to the installer skills' owner and are recorded as follow-ups, not fixed here.
- Mechanically enforcing the enumeration grep in CI. Same reasoning `fix-stale-client-count-surfaces` recorded for the count grep: a guard needing an allow-list of ~50 legitimate subset lines drifts faster than the prose it guards.

## Decisions

### D1 — `REMOVED` + `ADDED` with a new header, for both renames

Measured, eight arms against the real gates:

| Arm                                         | Result                                                                                                                                                                                                                                                          |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `## MODIFIED` renaming a **scenario title** | `check-delta-freshness.mjs` fails: _"published scenario(s) absent from the delta — archive will refuse"_. `openspec archive` aborts: _"current spec contains scenario(s) not present in the modified block"_. This is what reddened CI earlier in this session. |
| `## MODIFIED` leaving the title alone       | passes — the **control**, confirming the failure above is the rename and not a broken probe                                                                                                                                                                     |
| `## REMOVED` + `## ADDED`, **same** header  | `openspec validate` rejects: _"Requirement present in both ADDED and REMOVED"_                                                                                                                                                                                  |
| `## REMOVED` + `## ADDED`, **new** header   | passes both gates                                                                                                                                                                                                                                               |
| `## RENAMED Requirements`                   | passes `openspec validate`; **trips `check-delta-freshness.mjs`**                                                                                                                                                                                               |

`RENAMED` is unusable until that gate is taught about it: `grep -c RENAMED scripts/check-delta-freshness.mjs` returns **0**, and the gate splits the delta on the literal `'## MODIFIED Requirements'` (`scripts/check-delta-freshness.mjs:77`), so a `RENAMED` block is invisible to it. Teaching the gate is a separate change against `development-environment`; doing it here would couple a tooling change to a prose change and delay both.

So both renames use `REMOVED` + `ADDED` with new, **count-free** headers. Precedent is established, not invented: `archive/2026-07-29-align-supply-chain-allowlist/specs/development-environment/spec.md:10` states the mechanism outright in its **Reason**, and `archive/2026-06-07-rename-session-get-tool` did the same.

Chosen headers:

| Capability                | FROM                                                                                                       | TO                                                                                                                               |
| ------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `dashboard`               | `The dashboard login view MUST present a single canonical brand mark, headline, and client-support footer` | `The dashboard login view MUST present a single canonical brand mark, headline, and a footer naming every bundled plugin client` |
| `plugin-session-protocol` | ``The protocol nudge MUST be in `initialize.instructions` to cover all three clients uniformly``           | ``The protocol nudge MUST live in `initialize.instructions`, and every client MUST reach it or document its own equivalent``     |

Both new headers are count-free by construction, so the sixth client does not reopen this file.

### D2 — Relocation to the end of the file is an accepted cost

`openspec archive` appends `ADDED` requirements; it does not splice them back where the `REMOVED` one sat. Both renamed requirements will therefore move to the end of their published spec file. Accepted: `openspec/specs/` files are navigated by header search, not by reading top to bottom, and no tooling depends on requirement order. The alternative — hand-splicing after archive — is an untracked manual edit to the authoritative contract, which is strictly worse.

### D3 — `check-delta-freshness` protection is lost on these two requirements, and must be replaced by hand

The gate only inspects the `MODIFIED` block (`scripts/check-delta-freshness.mjs:77`). Under `REMOVED` + `ADDED` it validates nothing, so its usual guarantee — that the delta's carried text matches the published text except where intended — does not apply here. Two requirements go through this change carrying **8 published scenarios** between them (5 dashboard, 3 protocol). One of the five is deliberately renamed and rewritten; the other **7 must survive byte-identical** with nothing checking that they do.

The third delta is not covered either, for a second reason worth stating because it is easy to mistake for a pass. `bodyLines` (`:44-50`) compares only the requirement body **before the first scenario**, and scenarios are compared by **title** alone. The `open-source-distribution` edit is inside a scenario body, so the gate is structurally blind to it. Measured: `pnpm run check:delta-freshness` reports `ok (1 active change(s))` with **0** body differences across all three deltas — a green that means "nothing inspected", not "nothing changed".

The replacement is task 5.4: a hand `diff` of each carried scenario against the published text, asserting **only** the intended differences. Not "read it over" — an actual `diff` whose output is quoted in the task.

### D4 — The `plugin-session-protocol` body states what is verified per client, and no more

The current body (`:180`) says `initialize.instructions` "is likewise the only nudging surface available to in-process clients (e.g. Hermes Agent) that expose no per-turn hook". `hermes-agent-plugin/spec.md:81` says the opposite, verbatim: _"Hermes does NOT consume the MCP server's `initialize.instructions` block"_ — which is exactly why `system_prompt_block` exists there.

The re-added body names only what is verified:

- **Consumes it** — Claude Code, Codex CLI (both host-injected), Pi (`apps/plugin/.pi-plugin/index.ts:322-325` appends `mcp.instructions()` to `event.systemPrompt`).
- **Does not** — Hermes Agent, which reaches parity by returning the same BASE text from `system_prompt_block`.
- **Unverified** — opencode. No spec in `openspec/specs/` asserts that opencode injects `initialize.instructions`; `apps/server/src/mcp/instructions.ts` claims it does, but that comment is one of the surfaces this change is correcting precisely because two of its three mechanism claims are false. The body therefore does not name opencode either way. See Open questions.

This is the "do not claim behaviour nobody will implement" rule applied to a rationale paragraph: an unverified fourth name would be a new false claim replacing an old one.

### D5 — This change's acceptance criterion is enumeration-shaped, and its limits are stated

Shape: flag any tracked line naming **three or more** of the five clients while omitting **at least one**, excluding `openspec/changes/**`, `*CHANGELOG*` and `pnpm-lock.yaml`.

Measured at HEAD (`git grep` against the `HEAD` tree, so the docs agent's in-flight edits do not contaminate it):

- **55 lines** match the broad shape. Most are legitimate subset statements ("opencode + Hermes", "the Claude/Codex marketplace"), so 55 is a triage list, not a defect count — the same character as `pi-plugin`'s existing scenario, whose grep returns 28 with most legitimate.
- **6 lines** match the sharper sub-family that additionally carries a universalising phrase (`all clients`, `every client`, `the clients`, `supported client`, `five client`, `all five`, `clients:`). Exactly **one** is a genuine defect (`apps/plugin/.opencode-plugin/README.md:67` — "one file, all clients" while omitting Pi). The other five are the historically-scoped ordinals D-Non-Goals keeps plus two correct subset statements (`docs/agents.md:309` "four of the five clients", `tui-installer/spec.md:327` naming per-client mechanisms).

Why the old shape could not see any of this: every line above either states no number, or states one other than "four". `four clients|FOUR clients|all four` matches none of them.

**Two limits, stated rather than discovered later.** The detector is line-based, so it misses (a) enumerations wrapped across lines — `SECURITY.md:79-80` splits `Claude Code / Codex /` from `Hermes marketplaces.`, and each line alone names fewer than three; and (b) structured lists where each client is its own line, which is exactly `.github/ISSUE_TEMPLATE/bug.yml:56-70`. Neither is a reason to drop the grep; both are the reason the issue template gets a **dedicated scenario** in `open-source-distribution` rather than relying on the grep to catch it.

**Why not broaden `pi-plugin`'s scenario instead.** Broadening it means renaming a published scenario title (`No surface still claims four clients`), which under D1 means `REMOVED` + `ADDED` on `pi-plugin` — a capability that already absorbed two deltas on 2026-08-08 (`add-pi-plugin`, `fix-stale-client-count-surfaces`). A third rewrite of the same requirement in two days, to relocate it to the end of its file, buys nothing the new criterion does not already provide. The old scenario stays and stays true.

### D6 — The PR checklist changes but gets no spec scenario

Verified, not assumed: `Scenario: PR template surfaces in the PR creation UI` (`open-source-distribution/spec.md:91`) requires only that the description field be **pre-populated** with the checklist; it does not constrain the checklist's contents. So correcting item `:39` needs no spec change.

It also should not get one. The item's correct content is derived from the release model, whose authority is `CLAUDE.md`'s plugin-release section and the already-published `Requirement: The repository's release identity MUST be consistent across surfaces` (which names all five carriers and their `extra-files` sync). Pinning the checklist's wording in a scenario would create a third copy of a fact that already has two homes — the drift pattern this change exists to stop.

### D7 — `mcp-api/spec.md:539`'s "two of the clients" is correct and gets no delta

`fix-stale-client-count-surfaces` left this flagged as unverified ("If Pi does belong in that set, 'two' is the next thing to correct — flagged, not guessed"). It is now settled **by citation**, not by re-measurement: `plugin-session-protocol/spec.md:296`, archived 2026-08-09, reads _"Of the five clients, three POST `/end`: Claude Code, Hermes and Pi"_. Five minus three is two. The open question is closed; no delta needed.

## Risks / Trade-offs

- **A carried scenario is silently altered during the `REMOVED` + `ADDED` copy, and no gate notices** (D3) → task 5.4's hand `diff`, whose output is quoted in the task rather than summarised.
- **The renamed requirements land at the end of their spec files** (D2) → accepted; recorded here so the next reader of `dashboard/spec.md` does not file it as a bug.
- **A concurrent agent is editing nine of the non-spec surfaces while this proposal is written** → every measurement in this document was taken against the `HEAD` tree (`git grep … HEAD -- …`, `git show HEAD:<path>`), never the working tree, so no number here is contaminated by an in-flight edit. Task 5.5 re-runs the acceptance grep against the merged result.
- **The new login-footer test asserts a list that a future client must be added to** → intended. That is the pin whose absence let the footer drift for a year. The mutation task (1.3) is what proves the pin is load-bearing.
- **`instructions.ts`'s comment is being corrected while `plugin-session-protocol`'s body is being corrected to the same facts** → they must agree at merge. Task 4.1 pairs them explicitly.

## Migration Plan

None. No schema change, no migration file, no derived-table invalidation, no data touched. Deployment is the ordinary image publish; rollback is an image revert with no residue, because the only runtime difference is rendered HTML on `/dashboard/login`.

## Open Questions

1. **Does opencode inject `initialize.instructions` into its model's prompt?** No spec asserts it; `instructions.ts` claims it, and that comment is measurably wrong about two of its three mechanism claims, so it is not evidence. Default taken (D4): the re-added body names opencode neither way, and `instructions.ts`'s corrected comment must not name it either. Answering it needs a real opencode session with an instrumented bridge — out of scope here, and cheap to fold into the next `opencode-plugin` change.
2. **Should `check-delta-freshness.mjs` learn about `## RENAMED Requirements`?** Every rename in this repo pays D2's relocation cost solely because `RENAMED` is unsupported by one gate. Not answered here: it is a `development-environment` change with its own test surface, and coupling it to a prose fix would delay both. Recorded so the cost is attributed to the tooling gap rather than to the rename.
3. **`open-source-distribution/spec.md:80` says `.github/PULL_REQUEST_TEMPLATE.md` carries "a checklist mirroring `CONTRIBUTING.md::Pull request checklist`", but `CONTRIBUTING.md` has no section by that name** (its headings are `Local setup`, `Commit messages`, `Hooks`, `Code style`, `Tests`, `OpenSpec`, `Running locally`, `Adding a dependency`, `Issues and PRs`). Default taken: **leave it**. It is a dangling cross-reference in the same requirement this change modifies, so fixing it is nearly free — but it is a different defect with a different fix (rename the section, or repoint the reference), and folding it in widens the change against an explicit scope boundary. Follow-up.
