## MODIFIED Requirements

### Requirement: The first prompt of a session MUST receive a relevance instruction

The recall hook fires a keyword-gated instruction only when the user's prompt matches a recall-intent keyword list. Without a second trigger, every other session would begin with no relevance signal at all, so whether the agent goes looking for prior knowledge would depend on the user's phrasing rather than on whether prior knowledge exists.

On the first user prompt of a session the plugin SHALL therefore emit a bounded, fixed instruction directing the model to call `memory.context` with `focus` set to that prompt before responding. The trigger SHALL fire at most once per session, tracked by its own per-session counter distinct from the per-turn nudge counter. The existing keyword trigger SHALL be retained for explicit recall requests at any point in the session, and both MAY fire on the same turn.

This is an **instruction to the model, not a server-side prefetch**. The hook SHALL make no HTTP request: the emitted text is fixed and byte-identical whether or not the scope contains any relevant memory, and THIS hook performs no relevance query of its own. The consequence SHALL be recorded rather than implied — relevance injection by this line depends on the model acting on the instruction, which a prefetch would not. A prefetch was considered and rejected FOR THIS HOOK: it would put an HTTP call on the first prompt of every session, on the latency-critical path, implemented in bash, to replace an instruction that works. Because this hook makes no request, there is no unreachable-server failure mode on this path.

This change RETRACTS that rejection, but only for a SEPARATE hook, and deliberately keeps this one byte-identical. The rejected option was rejected because it replaced a working instruction; `proactive-entity-recall` adds a different signal instead of replacing one: a keyword regex cannot notice that a prompt names a file, a ticket or an error code that the corpus already holds learnings about, and no instruction makes the model look when it does not know to look. The query therefore lives in its own matcher-less `UserPromptSubmit` entry (`apps/plugin/scripts/prompt-hints.sh`), leaving the fixed-line hook's two properties — no request, corpus-independent text — intact and asserted. The cost the rejection named is real and is bounded rather than denied: one request per prompt, a 200 ms client-side budget, and total silence on any failure, so the unreachable-server failure mode now exists on this path and degrades to emitting no lines.

Both statements are scoped to this capability's bash hooks and SHALL NOT be read as a four-client claim. The Hermes provider does implement a real prefetch — `queue_prefetch` in `apps/plugin/.hermes-plugin/__init__.py` POSTs `/memory/recall` and prepends the recalled text to the hint — so on that client the emitted block is corpus-dependent and does have a silent unreachable-server path. That divergence is deliberate: Hermes is an in-process Python provider with no bash latency budget and no per-client duplication cost. It is specified by `hermes-agent-plugin`, which this change does not audit; the two capabilities SHALL NOT be conflated, and a future four-client parity claim about relevance injection has to reconcile them first.

The emitted line SHALL be represented in the shared nudge fixtures with a byte budget asserted in lock-step against the equivalent line in every other client, so the four implementations cannot drift.

#### Scenario: A session with no recall keyword still receives a relevance instruction

- **GIVEN** a project with memories relevant to the user's first prompt
- **WHEN** the first prompt of a session contains no recall-intent keyword
- **THEN** the plugin SHALL emit the fixed first-prompt relevance line directing the model to call `memory.context` with `focus` set to the prompt

#### Scenario: The trigger does not repeat

- **WHEN** the second and subsequent prompts of the same session are submitted
- **THEN** the first-prompt line SHALL NOT be emitted again

#### Scenario: The emitted text does not depend on the corpus

- **GIVEN** two projects, one with many relevant memories and one with none
- **WHEN** the first prompt of a session is submitted in each, through this capability's `prompt-search.sh` hook
- **THEN** the emitted line SHALL be byte-identical in both cases
- **AND** this SHALL NOT be asserted of the Hermes provider, whose prefetch makes the block corpus-dependent by design

#### Scenario: The hook makes no network request

- **WHEN** `apps/plugin/scripts/prompt-search.sh` is inspected
- **THEN** it SHALL contain no call to `rembric_post` and no `curl` invocation
- **AND** it SHALL require neither `REMBRIC_SERVER_URL` nor `REMBRIC_API_TOKEN` to emit either line

#### Scenario: A broken counter does not fabricate a first turn

- **GIVEN** the first-prompt counter directory cannot be created or read back
- **WHEN** `UserPromptSubmit` fires
- **THEN** the first-prompt line SHALL NOT be emitted (fail closed), while the keyword trigger SHALL still be evaluated

#### Scenario: The injected line is fixture-covered

- **WHEN** the first-prompt line diverges from the equivalent line in another client, or exceeds its byte budget
- **THEN** the lock-step fixture test SHALL fail and the build SHALL be rejected

#### Scenario: The relevance query is a separate hook, and the fixed-line hook stays request-free

- **WHEN** `apps/plugin/scripts/prompt-search.sh` is inspected after this change
- **THEN** it SHALL still contain no `curl`, no `rembric_post`, and no dependency on `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN`
- **AND** the entity-recall request SHALL live in `apps/plugin/scripts/prompt-hints.sh`, registered as its own matcher-less `UserPromptSubmit` entry

#### Scenario: The hints hook never blocks the model

- **GIVEN** the server is unreachable, slow, or returns an error for `POST /sessions/:id/recall-hints`
- **WHEN** `prompt-hints.sh` runs on a user prompt
- **THEN** it SHALL emit nothing on stdout and SHALL exit 0
- **AND** the fixed-line hooks' output SHALL be unaffected by its presence or absence

### Requirement: The token budget MUST be stated per firing turn and amortised over the cadence window, in a pinned unit, and asserted in the shared fixtures

Every token figure in this capability SHALL be measured with one pinned proxy: **UTF-8 bytes ÷ 4**, over the stored fixture string and therefore EXCLUDING any trailing newline the emitting script adds. Totals for a whole turn, where a script emits several lines, SHALL include one newline per emitted line — that is the only place the newline counts. `sessionIdTemplate` is measured rendered with a 36-character UUID session id.

Two conventions have to be pinned, not one, and conflating them is what made the ambiguity load-bearing: the canonical post-compact block is 168.0 tokens counted as JS characters and **170.8** counted as UTF-8 bytes, a difference caused by multibyte punctuation. Counting its emitted trailing newline produces 171.0, so quoting that value against the character count would change two variables at once. Per-line caps below are newline-exclusive; turn totals are newline-inclusive. Raising any cap is a deliberate spec edit accompanied by a re-measurement; it is not a test adjustment.

**Always-on cost** (added to every turn while the plugin is enabled, in addition to the MCP tool listings the user already pays for):

- Four command listings (`/rembric:<name> <description>`): ≤80 tokens total.
- **Total: ≤80 tokens**, auditable via `claude plugin details rembric` against a ~100-token ceiling (80 design target plus a 20-token margin).

The plugin ships no skills, so there is no skill description and no skill body in the always-on or on-invoke budget.

**On-invoke cost**, per hook:

| Surface                                         | Cap             |
| ----------------------------------------------- | --------------- |
| `SessionStart` (`startup\|resume\|clear\|fork`) | ≤30 tokens      |
| `SessionStart` (`compact`)                      | ≤175 tokens     |
| `UserPromptSubmit`, fixed-line entries, per FIRING turn | ≤272 tokens     |
| `UserPromptSubmit`, amortised over 10 turns     | ≤60 tokens/turn |
| `UserPromptSubmit`, entity-recall hints entry   | ≤161 tokens     |
| `SessionEnd`                                    | 0 tokens        |
| `PreCompact`                                    | 0 tokens        |
| `PostCompact`                                   | 0 tokens        |
| `Stop`                                          | 0 tokens        |

**`Stop` is now a single row at 0 tokens, and that is a strict tightening of what this table previously published.** It carried two rows — an asynchronous raw sync at 0 tokens and a synchronous reminder explicitly exempted from any fixed cap, because `plugin-session-protocol` required it to carry "the long form precisely because it has no length budget". The raw-sync entry is deleted, the reminder is composed on the server and bounded there, and the remaining `Stop` handler writes nothing a model can read. No surface in this plugin is uncapped any more.

**Two caps on this table MOVE, and the movement is the direct consequence of relocating the reminder from an uncapped channel onto a capped one.** Both new values are derived rather than chosen:

- **Per FIRING turn: 960 → 1088 bytes (240 → 272 tokens).** The worst reachable turn is the counter-divergence case this ceiling has always been set against, now with the notice in place of the retired `save`+`summary` pair: `firstPromptRelevance` (125) + recall (90) + `sessionIdTemplate` rendered (204) + the server-composed notice at its own 640-byte bound + 4 newlines = **1063 bytes**. The ceiling is 1088 for margin. For comparison, the same divergence case measures 917 bytes today.
- **Amortised over 10 turns: 180 → 240 bytes/turn (45 → 60 tokens/turn).** This cap governed `UserPromptSubmit` alone while the periodic reminder lived on the uncapped `Stop` channel, so it never counted the reminder at all. Measured before this change across ten turns of a working session, driving the real scripts: `UserPromptSubmit` emitted 1230 bytes (123/turn) and `Stop` a further 1044, for **227 bytes/turn across both channels**. Under this change, measured on the shipped fixtures by driving `prompt-search.sh` and `prompt-nudge.sh`, the same ten turns emit **556 bytes** of turn-1 lines (`firstPromptRelevance` 125 + `sessionIdTemplate` rendered 204 + `sessionOpening` 224 + 3 newlines) plus **846 per elapsed floor** (204 + the notice at its 640-byte bound + 2 newlines): **140 bytes/turn** at one floor and **225 bytes/turn** at two, both now entirely on this one channel. The cap rises to 240 to admit the two-floor case honestly rather than to hide it on a second channel.

**On a conversation where no work happens the cost falls rather than rises, and that is the change's point.** Measured today, twenty turns with no tool use at all still emit 1880 bytes across five firing turns, because `prompt-nudge.sh` never opens the transcript. Under this change the same twenty turns emit the turn-1 opening and nothing else — the notice's gate never fires without work (`session-nudges`).

**Per-line caps**, each asserted individually so a single loose aggregate cannot mask an individual violation:

| Fixture / emitted line           | Cap (bytes) | Cap (tok) | Asserted against                  |
| -------------------------------- | ----------- | --------- | --------------------------------- |
| `SessionStart` nudge             | 100         | 25        | `nudge-fixtures.json`             |
| recall nudge                     | 100         | 25        | `nudge-fixtures.json`             |
| `firstPromptRelevance`           | 140         | 35        | `nudge-fixtures.json`             |
| `sessionIdTemplate` (36-char id) | 224         | 56        | `nudge-fixtures.json`             |
| `sessionOpening`                 | 360         | 90        | `nudge-fixtures.json`             |
| `postCompact`                    | 700         | 175       | `nudge-fixtures.json`             |
| server-composed notice           | 640         | 160       | the emitted string, on the server |

The `save` (132) and `summary` (400) rows are removed with their fixtures: no client composes those strings any more (`plugin-session-protocol`). `endOfTurnRubric`, which deliberately had no row because its surface was uncapped, is removed with that surface.

**The server-composed notice is the first model-facing string in this plugin with no fixture, and its cap is therefore asserted elsewhere.** There is nothing to pin across languages — one implementation composes it and five clients print it — so its 640-byte bound is asserted on the server against the emitted string, including a case whose stored summary forces elision (`session-nudges`). The 640 figure is derived from the per-firing ceiling above and not chosen: 1063 − 125 − 90 − 204 − 4 leaves the notice 640.

The `sessionIdTemplate` line remains the largest single per-turn client-composed contributor (51.0 tokens) and SHALL NOT be removed to reduce the budget. It is not redundant: of `resolveActiveSessionId`'s three paths, the `SessionRouter` fallback is populated only by `memory.session_start`, which the plugin never calls because the session lifecycle is HTTP, and `findActiveForTransport` refuses by design to guess under concurrent ambiguity within its staleness window. With two host sessions open on one repository the line is the only mechanism that attaches a memory to the right session.

The `UserPromptSubmit` channel now carries a third matcher-less entry, and it is additive by construction rather than a revision of the two fixed-line budgets: the fixed-line ceiling stays measured as it has been — `prompt-search.sh` plus `prompt-nudge.sh`, the pair the existing test sums — because the hook that queries the server is a separate script. The hints entry carries its own bound, inherited rather than invented: the server trims its whole lines to `NOTICE_MAX_BYTES` (640 bytes), the ceiling the stretch-close notice already publishes, so the entry emits at most 640 bytes plus one newline ≈ 161 tokens, and the worst reachable turn across all three entries is 1088 + 641 = **1729 bytes** (~433 tokens). Because entity recall deduplicates per session, that entry emits nothing on a turn that names no new indexed entity, so the amortised 60 tokens/turn figure is not charged on every turn; the 161-token row is its per-firing ceiling, not its expected cost.

#### Scenario: Every fixture line has its own asserted budget

- **WHEN** the shared nudge fixtures are measured in UTF-8 bytes
- **THEN** each of `sessionOpening`, `sessionIdTemplate` (rendered with a 36-character id), `firstPromptRelevance`, the recall nudge, the `SessionStart` nudge and `postCompact` SHALL be within its cap in the table above
- **AND** each SHALL be a separate assertion, so one violation is attributable to one line
- **AND** the fixtures SHALL carry no `save`, `saveCore`, `summary`, `summaryCore` or `endOfTurnRubric` key to measure

#### Scenario: The turn-1 firing turn stays under its unchanged sub-budget

- **GIVEN** a session driven through the real per-session counter file
- **WHEN** turn 1 fires with a recall keyword in the prompt (first-prompt line, recall line, sessionId line, session opening)
- **THEN** the total emitted output SHALL be ≤800 bytes (≤200 tokens) — this sub-budget does NOT move; measured 647 bytes on the shipped fixtures, against 797 before this change

#### Scenario: The counter diverges, a notice is pending, and every line fires at once

- **GIVEN** a session where `prompt-search.sh`'s counter is at one while a server notice is cached from the previous turn
- **WHEN** that turn's prompt also carries a recall keyword
- **THEN** the total emitted output SHALL be ≤1088 bytes (≤272 tokens), and this — not turn 1 — is the case the per-firing-turn ceiling is set against

#### Scenario: The amortised budget holds over a window with two elapsed floors

- **WHEN** ten consecutive `UserPromptSubmit` turns are driven through both matcher-less entries, spanning two elapsed nudge floors with work reported in each
- **THEN** the sum of all emitted bytes divided by ten SHALL be ≤240 bytes/turn (≤60 tokens/turn)
- **AND** the `Stop` handler SHALL have contributed zero bytes to that sum

#### Scenario: A conversation with no work costs less than it does today

- **WHEN** twenty consecutive turns are driven with no tool use reported on any of them
- **THEN** the only emitted bytes SHALL be the turn-1 lines
- **AND** the total SHALL be strictly less than the 1880 bytes the same twenty turns emit before this change

#### Scenario: A side-effect hook emits nothing to the model

- **WHEN** `SessionEnd`, `PreCompact`, `PostCompact`, or `Stop` fires under Claude Code
- **THEN** the script SHALL write nothing to stdout that reaches the model

#### Scenario: Raising a cap requires a re-measurement

- **WHEN** a contributor raises any cap in this requirement
- **THEN** the change SHALL record the new measured value alongside the new cap
- **AND** the corresponding assertion SHALL be updated in the same commit

#### Scenario: The hints entry is bounded by the shared notice ceiling

- **WHEN** `POST /sessions/:id/recall-hints` returns its maximum three lines
- **THEN** the server SHALL have trimmed the emitted lines to at most `NOTICE_MAX_BYTES` in total, dropping whole lines rather than truncating a title
- **AND** the hints entry's emission SHALL stay within 641 bytes (~161 tokens) regardless of how many memories matched
