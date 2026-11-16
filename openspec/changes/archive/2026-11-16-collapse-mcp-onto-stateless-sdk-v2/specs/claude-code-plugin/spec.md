## MODIFIED Requirements

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
| `UserPromptSubmit`, per FIRING turn             | ≤272 tokens     |
| `UserPromptSubmit`, amortised over 10 turns     | ≤60 tokens/turn |
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

The `sessionIdTemplate` line remains the largest single per-turn client-composed contributor (51.0 tokens) and SHALL NOT be removed to reduce the budget. It is not redundant: `resolveActiveSessionId` has two paths, an explicit `sessionId` and `findActiveForTransport`; the server binds no session to a connection, and `findActiveForTransport` refuses by design to guess under concurrent ambiguity within its staleness window. With two host sessions open on one repository the line is the only mechanism that attaches a memory to the right session.

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

## ADDED Requirements

### Requirement: A path-less bridge connection MUST resolve to the default project, and a new slug MUST be created from the dashboard

When the bridge falls back to path-less `/mcp` — no `.rembric`, a parse failure, no `PROJECT_SLUG`, or an invalid slug — the connection SHALL resolve to the server's default project for its whole life. The plugin SHALL NOT rely on MCP roots discovery or on any tool call to select another project: the server does neither, and no tool can switch a connection's project. The bridge's stderr diagnostic SHALL name the fix (a `.rembric` file containing `PROJECT_SLUG=<slug>`, or `REMBRIC_PROJECT_SLUG`), as the `mcp-bridge` capability specifies.

When the bridge path-scopes the URL with a slug that does not yet correspond to a Rembric project, every scope-resolving tool SHALL be refused with `project_not_found`, and the refusal SHALL point to the dashboard. The project SHALL be created from the dashboard; no agent-side bootstrap call exists, and the plugin's model-facing text SHALL NOT instruct the agent to create or switch a project. Subsequent tool calls on the same URL find the project once the operator has created it.

To work in another project the operator changes `.rembric` (or `REMBRIC_PROJECT_SLUG`) and starts a new host session; there is no in-session override.

#### Scenario: No slug means the default project

- **GIVEN** a project directory with no `.rembric` and no `REMBRIC_PROJECT_SLUG`, and a host that advertises the `roots` capability
- **WHEN** the agent calls `memory.save` through the plugin
- **THEN** the row SHALL carry the default project's `project_id`
- **AND** the server SHALL NOT have sent `roots/list` to the host

#### Scenario: A new slug is created from the dashboard, not by the agent

- **GIVEN** `.rembric` containing `PROJECT_SLUG=brand-new` and no project with that slug
- **WHEN** the agent calls `memory.search` through the plugin
- **THEN** the call SHALL be refused with `project_not_found`, the refusal SHALL point to the dashboard, and no `projects` row SHALL be inserted
- **AND** after the operator creates `brand-new` from the dashboard, the same call on the same URL SHALL succeed against it
