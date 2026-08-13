## MODIFIED Requirements

### Requirement: The token budget MUST be stated per firing turn and amortised over the cadence window, in a pinned unit, and asserted in the shared fixtures

Every token figure in this capability SHALL be measured with one pinned proxy: **UTF-8 bytes ÷ 4**, over the stored fixture string and therefore EXCLUDING any trailing newline the emitting script adds. Totals for a whole turn, where a script emits several lines, SHALL include one newline per emitted line — that is the only place the newline counts. `sessionIdTemplate` is measured rendered with a 36-character UUID session id.

Two conventions have to be pinned, not one, and conflating them is what made the ambiguity load-bearing: the canonical post-compact block is 168.0 tokens counted as JS characters and **170.8** counted as UTF-8 bytes, a difference caused by multibyte punctuation. Counting its emitted trailing newline produces 171.0, so quoting that value against the character count would change two variables at once. Per-line caps below are newline-exclusive; turn totals are newline-inclusive. Raising any cap is a deliberate spec edit accompanied by a re-measurement; it is not a test adjustment.

**Always-on cost** (added to every turn while the plugin is enabled, in addition to the MCP tool listings the user already pays for):

- Four command listings (`/rembric:<name> <description>`): ≤80 tokens total.
- **Total: ≤80 tokens**, auditable via `claude plugin details rembric` against a ~100-token ceiling (80 design target plus a 20-token margin).

The plugin ships no skills, so there is no skill description and no skill body in the always-on or on-invoke budget. The previously-published `≤35 tokens` skill-description and `≤500 tokens` skill-body lines were vacuous, and the previous `≤75 tokens` always-on total was satisfiable **only** because the vacuous 35-token line absorbed the four command listings' real cost (~68.8 tokens against a stated `≤40`).

**On-invoke cost**, per hook:

| Surface                                     | Cap                      |
| ------------------------------------------- | ------------------------ |
| `SessionStart` (`startup\|resume\|clear`)   | ≤30 tokens               |
| `SessionStart` (`compact`)                  | ≤175 tokens              |
| `UserPromptSubmit`, per FIRING turn         | ≤240 tokens              |
| `UserPromptSubmit`, amortised over 10 turns | ≤45 tokens/turn          |
| `SessionEnd`                                | 0 tokens                 |
| `PreCompact`                                | 0 tokens                 |
| `PostCompact`                               | 0 tokens                 |
| `Stop` (`stop-sync.sh` handler)             | 0 tokens                 |
| `Stop` (`stop-nudge.sh` handler)            | no fixed cap — see below |

`Stop` carries two independent handler entries in `hooks.json` (`plugin-session-protocol`'s "The summary reminder MUST be delivered at the end of the turn, and MUST NEVER interrupt" specifies the second one), and a single `0 tokens` figure for the whole event was true of only one of them. `stop-sync.sh` is the asynchronous raw-transcript sync: a pure side effect, no stdout, `0 tokens`, unchanged. `stop-nudge.sh` is the synchronous end-of-turn summary reminder: it carries the canonical summary structure in full plus the session's own grounded facts, and is deliberately uncapped, unlike every other row in this table — `plugin-session-protocol` states this explicitly ("This is the surface that carries the long form precisely because it has no length budget, unlike a tool description"). Collapsing both handlers under one `0 tokens` row published the opposite of what that requirement already requires of the same handler; the split above is the correction, and it costs nothing else in this table because `stop-nudge.sh` was never actually silent — it already emits `hookSpecificOutput.additionalContext` carrying the rubric and the extracted facts.

`UserPromptSubmit` SHALL be governed by the pair — a per-firing-turn ceiling plus an amortised budget — and not by a flat per-turn figure. The two matcher-less entries fire on **turn 1**, on `count % 5 == 0` (save), on `count == 1 || count % 10 == 0` (summary), and on any turn whose prompt matches a recall keyword, each on its own counter. Turns matching neither cadence nor the keyword emit **zero** tokens. With the 382-byte canonical Markdown summary fixture, measured firing turns are approximately 173.1 (turn 1), 81.3 (turn 5) and 171.6 (turn 10), and 42.6 tokens/turn amortised across ten turns. Turn 1 with a recall keyword measures approximately 195.8, but the independent counters can diverge so all five lines fire together — approximately **225.8** tokens. That reachable case sets the 240-token ceiling. Final fixture output SHALL be re-measured and the exact values recorded with the implementation.

**Per-line caps**, each asserted individually against `apps/plugin/test/nudge-fixtures.json` so a single loose aggregate cannot mask an individual violation:

| Fixture / emitted line           | Cap (bytes) | Cap (tok) |
| -------------------------------- | ----------- | --------- |
| `SessionStart` nudge             | 100         | 25        |
| recall nudge                     | 100         | 25        |
| `firstPromptRelevance`           | 140         | 35        |
| `save`                           | 132         | 33        |
| `sessionIdTemplate` (36-char id) | 224         | 56        |
| `summary`                        | 400         | 100       |
| `postCompact`                    | 700         | 175       |

`endOfTurnRubric` (the `stop-nudge.sh` template) deliberately has NO row in this table, for the same reason the table above gives it no fixed cap: it is the one surface `plugin-session-protocol` specifies as carrying the long form precisely because it has no length budget.

The `sessionIdTemplate` line is the largest single per-turn contributor (51.0 tokens) and SHALL NOT be removed to reduce the budget. Removing it does not reach the previously-published cap anyway — measured without it, firing turns fall only to 91.0 / 30.0 / 89.5 — and it is not redundant: of `resolveActiveSessionId`'s three paths, the `SessionRouter` fallback is populated only by `memory.session_start`, which the plugin never calls because the session lifecycle is HTTP, and `findActiveForTransport` refuses by design to guess under concurrent ambiguity within its staleness window. With two host sessions open on one repository the nudge is the only mechanism that attaches a memory to the right session. Removing it is therefore blocked on a server-side fix to implicit session attachment under concurrency, which is out of scope for this capability.

#### Scenario: Every fixture line has its own asserted budget

- **WHEN** the shared nudge fixtures are measured in UTF-8 bytes
- **THEN** each of `save`, `summary`, `sessionIdTemplate` (rendered with a 36-character id), `firstPromptRelevance`, the recall nudge, the `SessionStart` nudge and `postCompact` SHALL be within its cap in the table above
- **AND** each SHALL be a separate assertion, so one violation is attributable to one line

#### Scenario: The turn-1 firing turn stays under its tighter sub-budget

- **GIVEN** a session driven through real per-session counter files
- **WHEN** turn 1 fires with a recall keyword in the prompt (first-prompt line, recall line, sessionId line, summary line)
- **THEN** the total emitted output SHALL be ≤800 bytes (≤200 tokens) — a tighter sub-budget on the aligned-counter case, NOT the per-firing-turn ceiling

#### Scenario: The two prompt counters diverge and every line fires at once

- **GIVEN** a session where `prompt-nudge.sh`'s counter has reached a multiple of ten while `prompt-search.sh`'s counter is at one
- **WHEN** that turn's prompt also carries a recall keyword
- **THEN** the total emitted output SHALL be ≤960 bytes (≤240 tokens), and this — not turn 1 — is the case the per-firing-turn ceiling is set against

#### Scenario: The amortised budget holds over a cadence window

- **WHEN** ten consecutive `UserPromptSubmit` turns are driven through both matcher-less entries
- **THEN** the sum of all emitted bytes divided by ten SHALL be ≤180 bytes/turn (≤45 tokens/turn)
- **AND** turns 2, 3, 4, 6, 7, 8 and 9 SHALL emit zero bytes when no recall keyword is present

#### Scenario: A side-effect hook emits nothing to the model

- **WHEN** `SessionEnd`, `PreCompact`, `PostCompact`, or the `stop-sync.sh` handler of `Stop` fires under Claude Code
- **THEN** the script SHALL write nothing to stdout

#### Scenario: The Stop reminder handler is exempt from the zero-output cap

- **GIVEN** the `stop-nudge.sh` handler, the second `Stop` entry in `hooks.json`
- **WHEN** it fires under Claude Code at its own cadence
- **THEN** its emitted `hookSpecificOutput.additionalContext` MAY be non-empty
- **AND** it SHALL NOT be held to a fixed byte or token cap by this capability — `plugin-session-protocol`'s end-of-turn summary-reminder requirement governs its content, not the per-hook table above

#### Scenario: Raising a cap requires a re-measurement

- **WHEN** a contributor raises any cap in this requirement
- **THEN** the change SHALL record the new measured value alongside the new cap
- **AND** the corresponding fixture assertion SHALL be updated in the same commit
