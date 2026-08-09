# Tasks

## 1. The surface with zero coverage (leads: it drifted for a year unpinned)

- [x] 1.1 `apps/server/src/server/dashboard-router.ts` — the login footer renders six spans in order: `CLAUDE CODE`, `OPENCODE`, `CODEX CLI`, `PI`, `HERMES`, `MCP CLIENTS`. Pi added; `MCP CLIENTS` moved from between `CODEX CLI` and `HERMES` to last.

- [x] 1.2 Add the first test this footer has ever had, in `apps/server/src/test/dashboard-e2e.test.ts`, in the shape of the repo-root `install.test.ts:379-383` (that file lives at the repository root, not under `apps/server/src/test/`) — one canonical list declared once, plus a **non-vacuity control** asserting the extracted span list is non-empty **before** comparing it. Baseline: `git grep -c "clients" apps/server/src/test/dashboard-e2e.test.ts` returns `0` at HEAD, which is why this drifted.

  The control is not optional. A selector that matches nothing makes `expect(extracted).toEqual([])` pass against an empty expectation, and a before/after digest of two empty sets is vacuous.

- [x] 1.3 Prove the test is load-bearing with `scripts/mutate.mjs`: delete the `PI` span from `dashboard-router.ts` and confirm the test named in 1.2 goes **red**. Quote the mutation command and the failing assertion in this task. A test green on both sides of the mutation has proven nothing.

  ```
  node scripts/mutate.mjs --file apps/server/src/server/dashboard-router.ts --spec dashboard --mutation <delete-PI-span> --with apps/server/src/test/dashboard-e2e.test.ts
  ```

- [x] 1.4 Confirm the rendered order matches the spec's stated order exactly, `MCP CLIENTS` last. Assert on the ordered list, not on membership — membership alone would pass with `MCP CLIENTS` back in the middle.

## 2. The delta specs

Carried by the deltas so they reach `openspec/specs/` at archive time — **not** hand-edited during apply.

- [x] 2.1 `dashboard` delta — `REMOVED` + `ADDED` (see design D1). New header: `The dashboard login view MUST present a single canonical brand mark, headline, and a footer naming every bundled plugin client`. Scenario `Footer lists all three plugin clients plus generic MCP` → `Footer names every bundled plugin client, then the generic MCP entry`. Four scenarios carried through unchanged; one added for the non-vacuity control.

- [x] 2.2 `plugin-session-protocol` delta — `REMOVED` + `ADDED`. New header: ``The protocol nudge MUST live in `initialize.instructions`, and every client MUST reach it or document its own equivalent``. The re-added body drops the false claim at `:180` that Hermes reaches this surface, and names only what is verified per client (design D4). Three scenarios carried through unchanged; one added pinning the Hermes/Pi facts across surfaces.

- [x] 2.3 `open-source-distribution` delta — plain `## MODIFIED`, no rename: the stale client list is in a **scenario body**, not a title. The parenthetical `(Claude Code / Codex CLI / Hermes Agent)` is replaced by a per-client obligation that names no roster, plus a dedicated scenario for the dropdown.

  Verified before writing: this requirement was **not** touched by `add-pi-plugin` or `fix-stale-client-count-surfaces` (the only changes archived in the last two days that carried an `open-source-distribution` delta), so there is no concurrent rewrite of the same text.

## 3. The outward-facing surfaces a stranger interacts with

- [x] 3.1 `.github/ISSUE_TEMPLATE/bug.yml` — the `Client` dropdown gains `opencode` and `Pi`. Keep the four non-client options. This is the one surface in this change that a published requirement already governed, and it was wrong anyway; 2.3 is what makes the pin per-client instead of a frozen list.

- [x] 3.2 `.github/PULL_REQUEST_TEMPLATE.md:39` — the checklist item stops asking for a manual version bump. It is stale on three axes (paths lost their `apps/` prefix; "all three manifests" against five carriers) but the substantive defect is that it instructs contributors to do something **now wrong**: under the unified `plugin` release track, release-please's `extra-files` move every carrier in lock-step and a contributor hand-bumps nothing. `CLAUDE.md`'s plugin-release section is the authority for the replacement text.

  No spec scenario pins this — verified, not assumed: `Scenario: PR template surfaces in the PR creation UI` requires only pre-population, not contents (design D6).

- [x] 3.3 `SECURITY.md:76-80` — the published security policy's declared scope. Fix the stale paths (`src/` → `apps/server/src/`, `plugin/` → `apps/plugin/`) and the scope naming only the Claude Code / Codex / Hermes marketplaces. This is the surface a security researcher reads to decide whether a finding is in scope; a client absent from it reads as out of scope.

## 4. The mechanism claims (they must agree with each other and with the spec)

- [x] 4.1 `apps/server/src/mcp/instructions.ts:4-9` — the count is right and the mechanism is wrong **twice**. It names Hermes among the clients whose host injects the block (`hermes-agent-plugin/spec.md:81` denies it verbatim), and says Pi's copy "lands in that extension's `initialize` result rather than in the harness's prompt" (`apps/plugin/.pi-plugin/index.ts:322-325` appends it to `event.systemPrompt`, so it does reach the prompt).

  Land this **paired** with 2.2 — the comment and the requirement must state the same facts at merge, since they disagreeing is the defect. Per house policy the comment stays one line of non-obvious _why_; the reasoning lives in the spec, not in a comment block.

- [x] 4.2 `docs/agents.md:38` and `docs/troubleshooting.md:105` — both say only Claude Code and Codex CLI honour `initialize.instructions`. Pi does too. Neither surface names opencode either way (open question 1: unverified, and `instructions.ts` is not evidence for it).

- [x] 4.3 `apps/plugin/.hermes-plugin/README.md:120` — correct the client list on the `system_prompt_block` sentence; keep it saying Hermes does **not** consume the MCP block, which is the one part it already had right.

## 5. Verification

- [x] 5.1 `openspec validate name-every-client-on-every-surface --strict` passes.

- [x] 5.2 `pnpm run check:delta-freshness` passes with **0** body differences to review — measured, not predicted: `delta-freshness: ok (1 active change(s))` with no `body difference(s)` clause.

  Zero is the expected number and it is **not** evidence of correctness here. The gate compares only the requirement body **before the first scenario** (`bodyLines`, `scripts/check-delta-freshness.mjs:44-50`) and, for scenarios, only their **titles**. The `open-source-distribution` edit is inside a scenario body, so the gate cannot see it; the other two capabilities use `REMOVED` + `ADDED`, which the gate never parses (it splits on `'## MODIFIED Requirements'`, `:77`). All three edits are invisible to this gate. That is design D3, and 5.4 is what actually checks them.

- [x] 5.3 `pnpm run check:spec-provenance` passes. It runs only over `origin/main...HEAD`; CI is the gate.

- [x] 5.4 **Hand `diff` of every carried-through scenario**, because 5.2 does not cover them. 8 published scenarios cross the two `REMOVED` + `ADDED` capabilities (5 from `dashboard`, 3 from `plugin-session-protocol`); one dashboard scenario is deliberately renamed, so the other **7 must be byte-identical** to the published text.

  Extract the published requirement slice and the delta's `ADDED` slice to files and `diff` them; quote the diff output in this task. The only differences permitted are:

  - `dashboard` — the requirement header; the footer paragraph; the renamed footer scenario; the added non-vacuity scenario; and one **formatting-only** split, where the published paragraph's trailing "The right pane SHALL contain only the admin-token form …" sentence becomes its own paragraph. Its text is unchanged; a line-wise diff will still report it, which is why it is enumerated here rather than discovered.
  - `plugin-session-protocol` — the requirement header; the per-client rationale paragraph replacing the false Hermes clause; the added Hermes/Pi scenario. The "This nudge is the only mechanism …" sentence keeps its published wording up to the dropped trailing clause.
  - `open-source-distribution` — two added body paragraphs; one scenario `THEN` losing its `(Claude Code / Codex CLI / Hermes Agent)` parenthetical; one added scenario. No published line is dropped.

  Anything else is a copy error, and no gate will catch it. Measured at proposal time: all 7 carried-unchanged scenarios compare byte-identical, and no published body line is absent from any of the three deltas.

- [x] 5.5 Re-run the enumeration-shaped acceptance grep against the merged tree and triage every hit. Measured at HEAD (against the `HEAD` tree, so a concurrent working-tree edit cannot contaminate it): **55** lines match the broad shape, **6** match the universalising sub-family, of which exactly **1** is a defect (`.opencode-plugin/README.md:67`).

  ```sh
  git grep -nI -iE 'claude|codex|hermes|opencode|\bpi\b' \
    -- ':!openspec/changes' ':!*CHANGELOG*' ':!pnpm-lock.yaml' | awk -F: '
  { line = tolower($0); n=0; miss=0
    if (line ~ /claude/) n++; else miss++
    if (line ~ /codex/) n++; else miss++
    if (line ~ /hermes/) n++; else miss++
    if (line ~ /opencode/) n++; else miss++
    if (line ~ /(^|[^a-z0-9_])pi([^a-z0-9_]|$)|pi-plugin|rembric\/pi/) n++; else miss++
    if (n >= 3 && miss >= 1) print }'
  ```

  After this change the universalising sub-family SHALL contain **0** defects: every remaining hit must be a legitimate subset statement or historically scoped. Record the triage table, as `fix-stale-client-count-surfaces` did.

  Two known blind spots to check by hand, because the detector is line-based: enumerations wrapped across lines (`SECURITY.md:79-80`) and structured lists with one client per line (`.github/ISSUE_TEMPLATE/bug.yml`). Neither is caught by the grep; both are in scope for this change.

- [x] 5.6 `pnpm run typecheck`, `pnpm run lint`, `pnpm test` green.

  `pnpm run eval` is **not** required: no retrieval path is touched.

- [x] 5.7 **Real Docker smoke against pre-existing seeded data.** Bring the stack up per the `rembric-smoke-tests` skill, load `/dashboard/login` in a headless browser, and confirm the six spans render in order with `MCP CLIENTS` last. A unit assertion over the template string does not prove the page renders — the login route is unauthenticated SSR and the CSS is external.

  Note the standing hazard before starting: `dev:docker:up` runs `seed-dev --reset` on every boot and wipes the corpus.

## 7. What the verification actually measured

- **5.2 is a green that inspects nothing, and that is now proven rather than suspected.** `scripts/check-delta-freshness.mjs:44-50` defines `bodyLines` as "everything before the first scenario" and compares scenarios by **title only**. So a delta may rewrite any scenario _body_ invisibly, on top of the already-known blindness to `REMOVED`/`ADDED`. All three of this change's deltas are unchecked by it. Task 5.4 is the real check, not a formality.
- **5.4, run by hand**: 9 carried scenarios, **8 byte-identical**, 1 differing — `Issue template surfaces in the new-issue UI`, which is this change's intended edit. 4 scenarios are new. No unintended drift.
- **5.5 sweep**: 26 lines name three or more clients while omitting Pi. Two are corrected by this change's deltas at archive time (`dashboard:878`, `:898`, plus `open-source-distribution:89`); the rest are the historically-scoped ordinals task 6.2 keeps, genuine subset statements (the MCP bridge really does exclude Pi), the installer skill task 6.4 excludes, and **two false positives that confirm the detector's own documented blind spot**: `openspec/config.yaml:11` (the enumeration wraps onto line 12, which does name Pi) and `apps/plugin/.pi-plugin/README.md:5` (Pi's own README naming the _other_ four). A line-based detector cannot see either, which is exactly why the bug form got a scenario instead of relying on the grep.
- **5.7 Docker smoke**: the login page served by the built image returns, in order, `CLAUDE CODE`, `OPENCODE`, `CODEX CLI`, `PI`, `HERMES`, `MCP CLIENTS`. This is the arm the in-process test cannot give — it proves the shipped image serves it, not just that the handler returns it.

## 6. Deliberately not done (recorded so they are not silently lost)

- [x] 6.1 `pi-plugin/spec.md:436-438`'s acceptance scenario is **not** broadened. Broadening renames a published scenario title, which under D1 means a third `REMOVED` + `ADDED` on a capability that took two deltas on 2026-08-08. This change carries its own criterion instead; the old one stays and stays true.

- [x] 6.2 The historically-scoped ordinals stay: `opencode-plugin/spec.md:497,516` and `hermes-agent-plugin/spec.md:304` ("a fourth supported client"). The ordinal is stale; the requirement's force holds; rewriting costs a rename for nothing.

- [x] 6.3 `mcp-api/spec.md:539`'s "two of the clients" needs no delta. `fix-stale-client-count-surfaces` left it flagged as unverified; it is settled by citation — `plugin-session-protocol/spec.md:296` reads "Of the five clients, three POST `/end`: Claude Code, Hermes and Pi", so exactly two do not. Close that open question by reference in the archive note.

- [x] 6.4 `rembric-tui-installer/SKILL.md:41` and `rembric-tui-installer-e2e/SKILL.md:110` are **not** touched — they belong to the installer skills' owner. Follow-up.

- [x] 6.5 Teaching `check-delta-freshness.mjs` about `## RENAMED Requirements` is a separate `development-environment` change (open question 2). Every rename in this repo pays the end-of-file relocation cost solely because of this gap.

- [x] 6.6 `open-source-distribution/spec.md:80`'s reference to `CONTRIBUTING.md::Pull request checklist`, a section that does not exist under that name, is left dangling (open question 3). Fixing it inside a requirement this change already modifies would be nearly free but widens the change against an explicit boundary. Follow-up.

- [x] 6.7 Whether opencode injects `initialize.instructions` is **unverified** (open question 1). No surface touched by this change names it either way. Answering it needs an instrumented opencode session.
