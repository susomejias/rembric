## MODIFIED Requirements

### Requirement: Per-client lifecycle mapping MUST be honoured

The cross-client write contract maps lifecycle events to HTTP endpoints as follows. Implementations SHALL conform; divergences from this mapping SHALL be considered specification violations.

| Client      | Lifecycle event                                   | HTTP call                                                                       | `final`  |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------------------------- | -------- |
| Claude Code | `SessionStart` (`startup\|resume\|clear`)         | `POST /sessions {id, cwd, agent}` (placeholder title)                           | n/a      |
| Claude Code | `SessionStart` (`compact`)                        | `POST /sessions {id, cwd, agent}` (idempotent re-ensure) + stdout instruction    | n/a      |
| Claude Code | `UserPromptSubmit`                                | none (stdout nudges only)                                                       | n/a      |
| Claude Code | `Stop` (every turn)                               | `POST /summary {summary, title}` — `final` OMITTED                              | absent   |
| Claude Code | `PreCompact`                                      | `POST /summary {summary, title, final:false}`, or `{}` when no transcript        | false    |
| Claude Code | `PostCompact`                                     | `POST /summary {summary, final:false}`, or `{}` when no compaction summary       | false    |
| Claude Code | `SessionEnd`                                      | `POST /end {summary, title, final:false}`, or `{}` when no transcript            | false    |
| Codex CLI   | `SessionStart` (`startup\|resume\|clear`)         | `POST /sessions {id, cwd, agent}`                                               | n/a      |
| Codex CLI   | `SessionStart` (`compact`)                        | `POST /sessions {id, cwd, agent}` (idempotent re-ensure) + stdout instruction    | n/a      |
| Codex CLI   | `UserPromptSubmit`                                | none (stdout nudges only)                                                       | n/a      |
| Codex CLI   | `Stop` (every turn)                               | `POST /summary {summary, title, final:false}` + stdout `'{}'`                   | false    |
| Codex CLI   | `PreCompact`                                      | `POST /summary {summary, title, final:false}`, or `{}` when no transcript        | false    |
| Codex CLI   | `PostCompact`                                     | `POST /summary {summary, final:false}`, or `{}` when no compaction summary       | false    |
| Hermes      | `initialize`                                      | `POST /sessions {id, cwd, agent}`                                               | n/a      |
| Hermes      | `on_pre_compress(messages)`                       | `POST /summary {summary, final:false}`                                          | false    |
| Hermes      | `on_session_switch(new_id, parent_id)`            | `POST /end old + POST /sessions new`                                            | n/a      |
| Hermes      | `on_session_end(messages)`                        | `POST /end {summary, title, final:false}`                                       | false    |
| Any (model) | `memory.session_summary({summary, title?})` (MCP) | internal write (no HTTP) with `final:true`                                       | true     |

Two rows are load-bearing and easy to get wrong:

- **Claude Code `Stop` omits `final` entirely** — it is never sent as `true` and never sent as `false`. Codex's `Stop` sends `final:false` explicitly, because Codex has no `SessionEnd` and its row must stay `active` for the next turn. `apps/plugin/scripts/stop-sync.sh` selects between the two from its agent-name argument.
- **`SessionStart (compact)` does make an HTTP call on both clients.** `post-compact.sh` re-POSTs `/sessions` as an idempotent ensure before emitting its stdout block, covering the case where the stale sweep abandoned the row between the pre-compact moment and the resume. Its stdout block is additionally injected into the resumed model's context.

Codex CLI has no `SessionEnd` event, so a Codex session row stays `active` until the `abandonStale` job flips it to `abandoned`.

#### Scenario: Claude Code hooks.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for exactly these six event types and no others: `SessionStart`, `UserPromptSubmit`, `SessionEnd`, `PreCompact`, `PostCompact`, `Stop`
- **AND** `SessionStart` SHALL declare exactly two matcher groups, `startup|resume|clear` and `compact`
- **AND** `UserPromptSubmit` SHALL declare exactly two entries, neither carrying a `matcher` key
- **AND** the six event types SHALL carry eight handler entries in total
- **AND** the `Stop` handler SHALL declare `"async": true`
- **AND** the `hooks` object SHALL NOT contain a `PostToolUse` entry

#### Scenario: Codex hooks.codex.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for exactly these five event types and no others: `SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`
- **AND** `SessionStart` SHALL declare exactly two matcher groups, `startup|resume|clear` and `compact`
- **AND** `UserPromptSubmit` SHALL declare exactly two entries, neither carrying a `matcher` key
- **AND** the five event types SHALL carry seven handler entries in total
- **AND** the `hooks` object SHALL NOT contain a `SessionEnd` entry (Codex does not support the event)
- **AND** the `Stop` script SHALL emit `'{}'` to stdout (Codex requires JSON on Stop stdout — plain text is invalid per docs)

#### Scenario: `pre-compact.sh` exists and is wired on both clients

- **WHEN** the repository is inspected at HEAD
- **THEN** `apps/plugin/scripts/pre-compact.sh` SHALL exist and be executable
- **AND** `hooks.json`'s `PreCompact` entry SHALL invoke it with the agent argument `claude-code`
- **AND** `hooks.codex.json`'s `PreCompact` entry SHALL invoke it with the agent argument `codex-cli`

#### Scenario: Claude Code `Stop` never marks the session curated

- **GIVEN** a Claude Code session whose `summary_final` is `false`
- **WHEN** the `Stop` hook fires and POSTs `/summary`
- **THEN** the request body SHALL NOT contain a `final` key
- **AND** the row's `summary_final` and `title_final` SHALL remain `false`

#### Scenario: Hermes plugin.yaml declares the lifecycle methods

- **WHEN** `apps/plugin/.hermes-plugin/plugin.yaml` is loaded
- **THEN** the `hooks` array SHALL contain `on_pre_compress`, `on_session_end`, and `on_session_switch`

### Requirement: Plugin-injected protocol nudges MUST surface the summary length cap

The agent-facing protocol nudges injected by the per-client plugins SHALL state the summary length cap inline so the agent budgets for it on the first attempt and does not trip the MCP rejection path. The affected injection sites are:

- `apps/plugin/scripts/post-compact.sh` — the `SessionStart matcher:"compact"` hook stdout, shared by Claude Code and Codex CLI (budget ≤150 tokens; see `claude-code-plugin`'s token-budget requirement for the measurement unit). The protocol block listed for the agent SHALL include the cap on the `summary` field.
- `apps/plugin/.hermes-plugin/__init__.py` — Hermes provider's system-message injection (around line 313). The session-close protocol sentence SHALL include the cap.
- `apps/plugin/commands/summary.md` — the slash command description SHALL mention the cap so users invoking `/rembric:summary` see the budget too.

Each plugin SHALL emit the literal substring `10000` (the current cap value) in the injected text so a test can grep for it and a contributor changing the cap is forced to update every site.

The `≤150` budget replaces a previously-published `≤120`, which the shipped block exceeded from the moment it was written (measured 552 bytes = 138.0 tokens under the newline-exclusive per-line convention `claude-code-plugin` pins; 138.3 if the emitting script's trailing newline is counted, which only turn totals do). The cap was raised rather than the text trimmed: this block fires at the moment of highest consequence — the model has just lost its context and this is the only instruction telling it what to persist — so trimming it to recover 16 tokens once per compaction trades instruction-following for nothing. `claude-code-plugin` asserts the same number and the two SHALL be changed together.

#### Scenario: Claude Code post-compact injection mentions the cap

- **WHEN** `apps/plugin/scripts/post-compact.sh` runs and emits its stdout protocol block
- **THEN** the emitted text SHALL contain the substring `10000`
- **AND** the text SHALL describe the cap as a limit on the `summary` field passed to `memory.session_summary`

#### Scenario: The post-compact block stays within its raised budget

- **WHEN** the `postCompact` fixture is measured in UTF-8 bytes
- **THEN** it SHALL be ≤600 bytes (≤150 tokens at the pinned bytes÷4 proxy)
- **AND** the assertion SHALL fail the build when exceeded

#### Scenario: Hermes provider injection mentions the cap

- **WHEN** Hermes loads the rembric plugin and its system-message injection runs
- **THEN** the injected protocol text SHALL contain the substring `10000`

#### Scenario: Slash command description mentions the cap

- **WHEN** a user opens the `/rembric:summary` slash command's description text
- **THEN** the description SHALL contain the substring `10000`
