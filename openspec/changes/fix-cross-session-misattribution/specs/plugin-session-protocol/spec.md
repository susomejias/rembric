## ADDED Requirements

### Requirement: Each client MUST tag its session-lifecycle HTTP calls with a bridge instance id read from the local correlation file

Each client's session-lifecycle HTTP calls (the same calls enumerated in "Per-client lifecycle mapping MUST be honoured") SHALL attempt to read a local correlation file at `${TMPDIR:-/tmp}/rembric-bridge-instance/<sanitized-cwd>` (`<sanitized-cwd>` = the project directory with non-alphanumeric characters replaced by `_`, mirroring the existing `SAFE_ID` pattern used for session-id-keyed files elsewhere in this plugin tree) and, when the file exists and is non-empty, include its content as `bridgeInstanceId` in the POST body. When the file is absent, empty, or unreadable, the client SHALL omit the field and proceed exactly as it does today — this MUST NOT block, delay, or fail the underlying lifecycle call.

The file is written exclusively by the MCP bridge (`rembric-bridge.mjs`), never by the HTTP-lifecycle client code. This requirement governs only the read side.

#### Scenario: A lifecycle POST includes the bridge instance id when the file is present

- **GIVEN** the correlation file for the current project directory contains `"bi-42"`
- **WHEN** any client's session-lifecycle code issues its `POST /sessions`, `/summary`, or `/end` call
- **THEN** the request body SHALL include `bridgeInstanceId: "bi-42"`

#### Scenario: A lifecycle POST omits the field when the correlation file does not exist

- **GIVEN** no correlation file exists for the current project directory (the bridge has not started yet, or never will for this session)
- **WHEN** any client's session-lifecycle code issues its `POST /sessions`, `/summary`, or `/end` call
- **THEN** the request body SHALL NOT include a `bridgeInstanceId` field, and the call SHALL proceed and succeed exactly as it did before this requirement existed

## MODIFIED Requirements

### Requirement: Per-client lifecycle mapping MUST be honoured

The cross-client write contract maps lifecycle events to HTTP endpoints as follows. Implementations SHALL conform; divergences from this mapping SHALL be considered specification violations. Every HTTP call listed below MAY additionally carry a `bridgeInstanceId` field per "Each client MUST tag its session-lifecycle HTTP calls with a bridge instance id read from the local correlation file" — omitted from the table below for brevity, since it applies uniformly to every row.

| Client      | Lifecycle event                                   | HTTP call                                                     | `final` |
| ----------- | ------------------------------------------------- | ------------------------------------------------------------- | ------- |
| Claude Code | `SessionStart` (`startup\|resume\|clear`)         | `POST /sessions {id, cwd, agent}` (placeholder title)         | n/a     |
| Claude Code | `SessionStart` (`compact`)                        | stdout instruction to model; no HTTP                          | n/a     |
| Claude Code | `SessionEnd`                                      | `POST /end {summary, title, final:false}`                     | false   |
| Codex CLI   | `SessionStart` (any)                              | `POST /sessions {id, cwd, agent}`                             | n/a     |
| Codex CLI   | `Stop` (every turn)                               | `POST /summary {summary, title, final:false}` + stdout `'{}'` | false   |
| Hermes      | `initialize`                                      | `POST /sessions {id, cwd, agent}`                             | n/a     |
| Hermes      | `on_pre_compress(messages)`                       | `POST /summary {summary, final:false}`                        | false   |
| Hermes      | `on_session_switch(new_id, parent_id)`            | `POST /end old + POST /sessions new`                          | n/a     |
| Hermes      | `on_session_end(messages)`                         | `POST /end {summary, title, final:false}`                     | false   |
| Any (model) | `memory.session_summary({summary, title?})` (MCP) | internal write (no HTTP) with `final:true`                    | true    |

The Claude Code `Stop` hook SHALL NOT be wired in `apps/plugin/hooks/hooks.json`. The Claude Code `pre-compact.sh` script SHALL NOT exist. The Codex `pre-compact.sh` reference in `hooks.codex.json` SHALL be removed (there is no equivalent event in Codex).

#### Scenario: Claude Code hooks.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for `SessionStart` (with two matcher groups — one for `startup|resume|clear`, one for `compact`), `UserPromptSubmit`, and `SessionEnd`
- **AND** the `hooks` object SHALL NOT contain a `Stop` entry
- **AND** the `hooks` object SHALL NOT contain a `PreCompact` entry

#### Scenario: Codex hooks.codex.json contains the mapped events

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL contain entries for `SessionStart`, `UserPromptSubmit`, and `Stop`
- **AND** the `hooks` object SHALL NOT contain a `PreCompact` entry
- **AND** the `Stop` script SHALL emit `'{}'` to stdout (Codex requires JSON on Stop stdout — plain text is invalid per docs)

#### Scenario: Hermes plugin.yaml declares the lifecycle methods

- **WHEN** `apps/plugin/.hermes-plugin/plugin.yaml` is loaded
- **THEN** the `hooks` array SHALL contain `on_pre_compress`, `on_session_end`, and `on_session_switch`
