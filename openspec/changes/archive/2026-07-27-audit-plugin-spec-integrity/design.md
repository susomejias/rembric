## Context

Specs in `openspec/specs/` are this repo's authoritative contract, so a false spec is not a documentation nit — it is what the next agent implements against. Three plugin specs currently carry statements that are false at HEAD, and the `plugin-session-protocol:259` cluster is worse than false: it **forbids** three things two other published specs **require**, so satisfying either spec violates the other. There is no way to make `claude-code-plugin`'s `Stop` requirement true while `plugin-session-protocol` prohibits `Stop`. That contradiction has to be resolved inside one change; it cannot be split.

The referring audit's evidence is reproduced in `proposal.md`. The structural cause of the surviving defects is narrower than "specs drift":

1. **Untestable prose.** The command catalog and the token budget both live **above** `## Requirements` in `claude-code-plugin`, as bullet lists. Nothing in CI can execute a bullet. Three zod-rejecting calls and nine budget violations survived there.
2. **A cap stated in the wrong shape.** `:432`'s flat per-turn `≤30 tokens` is structurally unsatisfiable under a cadence design that fires on turn 1, every 5th and every 10th. It was never satisfiable, so no test was ever written for it, so it never failed.
3. **One loose assertion standing in for nine.** `nudge-fixtures.test.ts:313` is the only budget assertion in the repo, and at 1000 characters (250 tokens) it is 2× looser than the spec's own ≤120 — which is exactly why 136 tokens is green in CI and red against the contract.
4. **Unresolved conditionals published as contract.** `:113` ("IF validated … IF validation shows …") and `:189` ("SHALL select the codex_cli variants OR (preferred) dispatch on `$1`") were shipped as open questions wearing SHALL. Shipped resolved both; the spec did not.
5. **A removed component's references left behind.** The `rembric-memory` skill was deleted; `:237`, `:414`, `:424` and `:430` still refer to it, and `:426`/`:436` are satisfied only because `:424` is vacuous.

Constraints: `apps/plugin/` ships to four clients, so one copy of every shared resource — the only legitimate divergences are the per-client manifest dirs and `hooks{,.codex}.json`. Any edit under `apps/plugin/` bumps the single unified `plugin` release component and never rebuilds the server image. Nudge text is a four-client lock-step surface, so changing any of it triggers the mandatory `dev:docker:up` e2e pass.

## Goals / Non-Goals

**Goals:**

- Remove the spec-vs-spec contradiction so no reading of the three specs instructs an agent to delete working code.
- Make every remaining budget claim **measured, unit-pinned, and asserted in CI**, so a future violation fails a test rather than surviving a year.
- Move the two prose sections that produced the most defects (command catalog, token budget) into requirements that a test can cite.
- Resolve both published conditionals to what ships, and record the load-bearing mechanism each one hid.
- Record the two silences that mislead by omission: `/rembric:*` is Claude-Code-only, and `stop-sync.sh` diverges per client in three ways, not two.

**Non-Goals:**

- Building the first-prompt relevance prefetch (D1).
- Reducing the always-on or per-turn token cost as an objective in itself. Where a cap is wrong, the cap is corrected; text is trimmed only where a measurement supports it and no instruction weakens (D6).
- Auditing the other two plugin specs (`opencode-plugin`, `hermes-agent-plugin`). Both were checked on the one point the referring audit misattributed to them — neither claims the recall matcher — and are otherwise out of scope. Stated so a later reader does not read this change as a clean bill of health for them.
- Any server-side change. In particular the `resolveActiveSessionId` fallback weakness named in D2 is not fixed here.

## Decisions

### D1 — The relevance prefetch: amend the spec, do not build the feature

`claude-code-plugin:335–347` and `:354–357` require a first-prompt prefetch that "injects a bounded relevance block", with a scenario for an unreachable server. `prompt-search.sh` makes no network call at all — it sources `_api.sh` and never calls `rembric_post`, emitting one fixed instruction (`:16`) byte-identical whether or not any memory exists. So the unreachable-server scenario specifies an unreachable code path.

**Amend the spec to describe the nudge that ships.** Alternative considered and rejected: build the prefetch. Rejected because it puts an HTTP call on the first prompt of every session — the latency-critical path — implemented in bash, on all four clients, to replace a nudge that demonstrably works. This is the same verdict already recorded in `archive/2026-07-25-reconcile-specs-with-shipped-behaviour/design.md:59–63`; recording it a second time with the reason attached is the point, since that verdict was carried as prose with no delta and therefore did not stick.

Consequence to state in the delta rather than hide: the nudge depends on model cooperation where a prefetch would not. That is a real weakening relative to the written intent and it belongs in the requirement text.

### D2 — Do **not** cut the `sessionId` nudge; record that cutting it is blocked on a server fix

The `sessionId` line is the largest single contributor to a firing turn (51.0 tokens of 142.0 on turn 1, newline-exclusive). Cutting it is the obvious saving and it is wrong twice over.

**It does not achieve the cap.** Measured without it, firing turns go 142.3 / 81.3 / 140.8 → 91.0 / 30.0 / 89.5 — still ~3× the `≤30` claim on two of three. The cap is wrong regardless, so paying for it with a capability buys nothing.

**It is not redundant.** Of `resolveActiveSessionId`'s three paths (`memory-tools.ts:528–559`): the explicit argument is what the nudge exists to supply; fallback 2 reads `SessionRouter`, which only `memory.session_start` populates and the plugin never calls it (lifecycle is HTTP by design — `apps/plugin/CHANGELOG.md` records the switch); fallback 3 `findActiveForTransport` refuses **by design** to guess under concurrent ambiguity (`agent-sessions.ts:431–443`) within a 30-minute `TRANSPORT_STALENESS_MS` window. With two terminals open on one repo, the nudge is the **only** attachment mechanism — without it a memory is written with `session_id = NULL`.

Alternative considered: shorten the line (e.g. drop `memory.save_prompt` from the enumeration). Deferred to D6's rule — it is an instruction, and the enumeration is what makes it actionable.

The delta records that cutting this nudge is blocked on a server-side fix to session attachment under concurrency, so a future reader does not re-derive the analysis. That fix is not in scope here.

### D3 — Restate the `UserPromptSubmit` cap as what it actually governs, and pin the unit

`:432`'s flat `≤30 tokens` per turn cannot hold under cadences of turn 1 / every 5th / every 10th. Replace it with the pair the design actually has:

- a **per-firing-turn ceiling**: `≤180 tokens` (measured worst case 165.0 — turn 1 with a recall keyword in the prompt, which fires `firstPromptRelevance` + `recall` + `sessionId` + `summary`);
- an **amortised budget over the cadence window**: `≤45 tokens/turn averaged over 10 consecutive turns` (measured 36.4), with the cadences named in the requirement (turn 1, `count % 5 == 0`, `count % 10 == 0`);
- and the explicit statement that turns matching neither cadence nor the recall keyword emit **zero** tokens, which is what makes the amortised figure the honest one.

**Pin the unit.** No spec today says what a "token" means here, and that ambiguity is itself load-bearing: the same post-compact block measures **136.0** counted as JS characters and **138.3** counted as UTF-8 bytes, because `≤`, `·` and `—` are multi-byte. The requirement fixes the proxy as **UTF-8 bytes ÷ 4**, measures emitted output with one trailing newline per line, and renders `sessionIdTemplate` with a 36-char UUID. Alternative considered: a real tokenizer. Rejected — it adds a dependency to the plugin test path for a budget whose purpose is order-of-magnitude discipline, and the bytes÷4 proxy is what every figure in this repo was already stated in.

Resulting per-line caps, each ~10% above measured:

| Fixture / emitted line           | Measured (bytes) | Cap (bytes) | Cap (tok) |
| -------------------------------- | ---------------- | ----------- | --------- |
| `SessionStart` nudge             | 89               | 100         | 25        |
| `recall` nudge                   | 90               | 100         | 25        |
| `firstPromptRelevance`           | 125              | 140         | 35        |
| `save`                           | 119              | 132         | 33        |
| `sessionIdTemplate` (36-char id) | 204              | 224         | 56        |
| `summary`                        | 237              | 260         | 65        |
| `postCompact`                    | 552              | 600         | 150       |

The `SessionStart` cap stays `≤30 tokens` — measured 22.5, the one budget in these specs that was already true.

### D4 — Post-compact: raise the cap to ≤150; align the manifest field instead of loosening the requirement

**Post-compact.** 138.3 tokens against a `≤120` cap asserted identically at `claude-code-plugin:85` and `plugin-session-protocol:284`. Raise both to `≤150` (600 bytes). Alternative considered: trim ~65 characters. Rejected — that block is the highest-consequence instruction in the product (it fires when the model has just lost its context and is the only thing telling it what to persist), and risking instruction-following to save 16 tokens once per compaction is a bad trade. The two sites must move together or the contradiction simply relocates.

**`codex-distribution:16`.** "an `author` block matching the Claude Code manifest" is untestable as written and false as read: `author.url` differs (`.../susomejias` vs `.../susomejias/rembric`), and the Claude manifest has no `homepage` at all, so "matching" cannot hold across the listed field set. Replace "matching" with the enumerated set that must agree (`name`, `license`, `repository`, `author.name`, `author.url`) and the fields that are legitimately per-client (`description`, `homepage`, `mcpServers`, `hooks`, `userConfig`) — then align `author.url` in `.codex-plugin/plugin.json` so the tightened requirement is true. Alternative considered: keep the divergence and exempt `author.url`. Rejected because the divergence has no reason — it reads as an oversight, not a decision, and exempting it would enshrine a typo. The one-field edit bumps the unified `plugin` version, which is correct and costs nothing.

### D5 — Prose above `## Requirements`: promote what is load-bearing, patch the rest in place

The delta format only carries `### Requirement:` blocks, so three `claude-code-plugin` prose sections are outside its reach.

- **Promote** `## Command catalog` (`:47–55`) and `## Token budget` (`:420–436`) into requirements. This is not a formatting concession — it is the fix. Both sections are where the defects clustered precisely because a bullet list cannot be asserted, and both now have a test that cites them.
- **Patch in place at apply time** `## Project slug selection`'s `:404` (stale two-step lookup chain contradicting `:33`'s correct three-step `CLAUDE_PROJECT_DIR` → `PWD` → `process.cwd()`) and `:414` (bootstrap "guided by the `rembric-memory` skill", removed). These are genuinely non-normative prose; promoting them would duplicate `:33`, which is already correct and already covered. The tasks name file and line explicitly.

Stated as a limitation rather than papered over: the in-place edits are the one part of this change the archive sync does not verify, so task 5 requires re-reading the merged spec end to end for the `:33`/`:404` agreement.

### D6 — Trim nudge text only on evidence, largest-first, and never at the cost of an instruction

Where trimming is considered at all, the order is by measured size (`summary` 59.3, then `sessionId` 51.0) and the test is whether the instruction survives intact. `summary` carries the length cap, the "not the cwd" correction, the five-section structure and the skip clause — every clause earns its bytes. `sessionId` is covered by D2. So this change is expected to trim **nothing**, and the caps in D3 are set against the current text.

Consequence: if nothing is trimmed, no nudge text changes, and the `dev:docker:up` e2e pass is **not** triggered by that route. It is still required for the `.codex-plugin/plugin.json` edit and the new manifest test, because both touch what four clients load. The tasks state the gate unconditionally so it cannot be reasoned away.

### D7 — Where the tests live, and what they assert

`apps/server/vitest.config.ts` already includes `../plugin/test/*.test.ts`, so plugin tests run under the server's vitest and can import the server's zod schemas by relative path. That settles the command-argument test's placement: it lives in `apps/plugin/test/`, reads `apps/plugin/commands/*.md` from disk, and imports `memorySearchSchema` / `contextSchema` / `sessionSummarySchema` directly. Alternative considered: put it in `apps/server/src/test/` as an invariant. Rejected — its subject is the plugin tree, and co-locating it with the other plugin tests is where a plugin author will look.

Three test additions, each pinned to a requirement:

1. **Per-fixture budgets** in `nudge-fixtures.test.ts`, one assertion per row of D3's table, in UTF-8 bytes, with `postCompact` realigned from `.length <= 1000` to the amended byte cap. Plus the amortised assertion: `prompt-nudge.test.ts` already drives real turns through real counter files, so a 10-turn walk summing emitted bytes is a direct measurement, not a model.
2. **Spec-vs-manifest**: the exact event-type set and handler count of both manifests (`hooks.json` = 6 types / 8 handlers; `hooks.codex.json` = 5 types / 7 handlers), that neither `UserPromptSubmit` entry declares a `matcher`, and that `SessionStart` declares exactly `startup|resume|clear` and `compact`. Exact-set assertions, not `toContain` — a `toContain` test would have passed throughout the entire period `plugin-session-protocol:265` claimed `Stop` was absent.
3. **Command arguments**: every `{key: …}` a `commands/*.md` body passes to a `memory.*` call must be a key of that tool's schema. Catches the `q` / `limit` / `auto` class at build time.

### D8 — Scope discipline: this change writes tests and specs, not behaviour

No server source, no migrations, no dashboard, no MCP tool, no design token. No load-bearing invariant is touched: nothing here reads `ctx.project`, writes memory, or adds SQL. The only non-test source edit is one JSON field (D4). This is deliberate — an audit change whose diff also changes behaviour cannot be reviewed as an audit.

## Risks / Trade-offs

- [Risk] **Caps set ~10% above measured leave little room, so an unrelated future instruction improvement trips a budget test.** → Mitigation: intended friction. The requirement states that raising a cap is a deliberate spec edit with a re-measurement, which is the discipline whose absence produced a 250-token assertion guarding a 120-token contract. Headroom large enough to absorb a rewrite is headroom large enough to hide the next violation.
- [Risk] **Exact-set manifest assertions become churn on every legitimate hook addition.** → Mitigation: accepted, and load-bearing. Adding a hook already requires editing `plugin-session-protocol`'s lifecycle mapping table; the test failing in the same commit is the reminder to do it. Exactness is the whole value — the defect being fixed is a spec that asserted absence.
- [Trade-off] **Amending the prefetch requirement leaves relevance injection dependent on model cooperation.** → Accepted because the alternative is an HTTP call in bash on the first prompt of every session on the latency-critical path, across four clients, to replace a nudge that works. The delta states the dependency in the requirement text so it is a recorded limitation rather than an accidental one.
- [Trade-off] **`bytes ÷ 4` is a proxy, not a tokenizer**, and will misestimate the multi-byte characters (`≤ · —`) these strings deliberately use. → Accepted because the budget's purpose is order-of-magnitude discipline and a pinned crude unit is strictly better than the current unpinned one, which produced two different published figures (136.0 / 138.3) for the same string.
- [Risk] **A budget test that measures fixtures can drift from what the scripts emit**, since the fixtures are a JSON copy of bash string literals. → Mitigation: the existing lock-step tests (`nudge-fixtures.test.ts:126–272`) already assert fixture-vs-bash-vs-TS-vs-Python equality, so a fixture that drifts from a script fails there first. The new budgets sit on top of an already-verified identity.
- [Risk] **In-place prose edits (D5) bypass archive-sync verification**, so a wrong edit to `:404` lands silently. → Mitigation: task 5 requires re-reading the merged spec whole for `:33`/`:404` agreement, and the referring audit's own lesson is that contradictions in this repo appear _between_ requirements, not within one.
- [Risk] **No gate detects a NEW false statement.** This is the honest limit and it must be stated: `openspec validate --specs --strict` passes today, 24/24, on specs containing every divergence in this change. Structural validation cannot see semantic falsehood. The three new tests pin exactly the surfaces they name — hook manifests, command arguments, nudge budgets — and nothing else. Every other sentence in these three specs remains verified only by the read performed for this change. → Mitigation: none available. The tests convert the three highest-recurrence classes from prose into CI; the rest stays a human obligation.

## Migration Plan

Nothing to migrate. No persisted state, no schema change, no derived data to invalidate (`memory_fts`, `memory_vec` and the three entity tables are untouched), no first-boot behaviour on upgrade. Existing installations carrying hundreds of memories are unaffected by construction.

Rollback is a revert of the test files plus one JSON field. The only user-visible artifact is the unified `plugin` version bump from the `.codex-plugin/plugin.json` edit; hooks are read from the installed plugin tree at each invocation, so there is no server/plugin version coupling to break in either direction.

## Open Questions

- **Q1 — Does Codex's hook trust banner count event types or handler entries?** `codex-distribution:209`/`:220` and `docs/agents.md:155` both say the operator trusts **five** hook types; `hooks.codex.json` ships **seven handler entries** across those five types. Which number the banner shows ("N hooks need review") can only be settled against a live `codex-cli`, which was not available for this change. **Default taken, so the change is not blocked:** leave the doc requirement at five event types (the shipped doc and spec agree, and the trust state persists per handler per `:222`, which suggests handlers), and have the new manifest test assert **both** numbers explicitly so whichever the banner counts, the spec/test pair records it. Re-open with a live Codex and correct `:209`/`:220` if it shows seven.
- **Q2 — Should `firstPromptRelevance` and the `recall` nudge both fire when the first prompt of a session contains a recall keyword?** They are near-duplicative (`call memory.context with focus` / `call memory.search with the user keywords`) and together they are what makes the worst-case turn 165.0 rather than 142.3 tokens — the single largest cheap saving available. Suppressing one is a behaviour change on a four-client lock-step surface and it is not obviously right: the two instructions name different tools and a user who explicitly asks to recall probably wants the keyword search. **Default taken:** change nothing, and set D3's ceiling at 180 against the current both-fire worst case. Worth a dedicated change with a measurement of which instruction the model actually follows on turn 1.
