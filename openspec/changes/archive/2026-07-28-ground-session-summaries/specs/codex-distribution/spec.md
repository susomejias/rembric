## MODIFIED Requirements

### Requirement: Codex hook configuration

The repository SHALL host Codex hook configuration at `apps/plugin/hooks/hooks.codex.json`, sibling to the Claude Code plugin's `apps/plugin/hooks/hooks.json`, declaring the Codex-supported events the plugin wires: **five event types across eight handler entries**.

Codex's hook surface differs from Claude Code's in ways the platform forces, and has evolved since this requirement was first written:

- Codex has no `SessionEnd` event (verified against `developers.openai.com/codex/hooks`).
- Codex DOES support `PreCompact` and `PostCompact` events as of current `codex-cli` releases (verified against `codex-rs/hooks/src/schema.rs` at `codex-cli` 0.142.3+); the plugin wires both. `apps/plugin/scripts/pre-compact.sh` exists and is invoked from `hooks.codex.json`'s `PreCompact` entry — any statement that it should be removed for lack of a Codex event is false.
- Codex's `SessionStart` stdin carries a `source` field (`startup|resume|clear|compact`), and the dispatcher matches `SessionStart` matchers against it — so a `matcher: "compact"` group behaves the same way it does for Claude Code. Both matcher groups are declared **explicitly**: `startup|resume|clear` and `compact`. Neither is a default/unmatched group.
- Codex's dispatcher does NOT filter `UserPromptSubmit` by matcher; the hook fires on every prompt regardless. The manifest therefore declares NO matcher on either `UserPromptSubmit` entry, and each script self-filters internally. Declaring an advisory matcher was previously required by this capability and is now prohibited: an advisory matcher that the dispatcher ignores misleads every reader about where the filtering lives, and Claude Code's registration was deliberately made matcher-less too, so first-prompt detection sees every prompt on both clients.
- Codex's `Stop` hook REQUIRES JSON on stdout: "Stop expects JSON on stdout when it exits 0. Plain text output is invalid for this event." Per official docs.

Codex's mapping of lifecycle events to HTTP endpoints still diverges from Claude Code's where the platform forces it (no `SessionEnd`; Codex sessions stay `active` until the `abandonStale` job flips them to `abandoned` — this remains the steady state for Codex sessions), but no longer diverges on compaction-related hook support. The authoritative table of which hook POSTs what for both clients is `plugin-session-protocol`'s lifecycle mapping.

#### Scenario: Hook event coverage

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL declare exactly these five event types and no others: `SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`
- **AND** those five SHALL carry exactly eight handler entries in total
- **AND** `SessionStart` SHALL declare exactly two matcher groups, with the literal matchers `startup|resume|clear` and `compact`
- **AND** `UserPromptSubmit` SHALL declare exactly two entries, invoking `prompt-search.sh` and `prompt-nudge.sh`, and NEITHER SHALL carry a `matcher` key
- **AND** the `hooks` object SHALL NOT contain `SessionEnd` (Codex does not support this event)
- **AND** every hook entry SHALL be `type: "command"` — Codex does not support `type: "mcp_tool"` for hooks
- **AND** the `startup|resume|clear` `SessionStart` group SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh codex-cli` (reused from the Claude Code plugin; the `agent` arg differs)
- **AND** the `SessionStart` `"compact"` matcher group SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compact.sh codex-cli` (the same script Claude Code's `SessionStart(compact)` hook uses)
- **AND** the `PreCompact` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh codex-cli`
- **AND** the `PostCompact` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compaction.sh`

#### Scenario: Codex Stop wires to a per-turn summary writer

- **WHEN** the `Stop` hook fires (which it does once per agent turn under Codex semantics)
- **THEN** the hook's FIRST entry SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/stop-sync.sh codex-cli` — the same script Claude Code's `Stop` hook invokes with `claude-code` in its own first entry, diverging in exactly THREE ways selected by that agent-name argument: (1) the transcript parser (`*_codex_cli` vs `*_claude_code`), (2) the stdout contract (Codex MUST `printf '{}'`; Claude Code MUST emit nothing), and (3) the `final` field (Codex sends `"final":false` explicitly; Claude Code OMITS the key entirely). It also diverges in execution model, which the agent argument selects rather than the caller: Codex runs synchronously because it has no documented async escape hatch and must emit its JSON before exiting, while Claude Code daemonizes the body into a detached, output-redirected subshell
- **AND** the script SHALL read `session_id`, `cwd`, and `transcript_path` from stdin
- **AND** SHALL read `${cwd}/.rembric` for the slug
- **AND** SHALL read `transcript_path` if readable, format it via `_transcript.sh`, derive a title from the first non-empty assistant message (≤100 chars)
- **AND** SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with body `{"summary": "<formatted>", "title": "<derived>", "final": false}` — note: `/summary` NOT `/end`, because Codex Stop is per-turn and the session must stay `active` for the next turn to keep updating
- **AND** SHALL emit `'{}'` to stdout (Codex requires JSON on Stop stdout; plain text is invalid per docs)
- **AND** SHALL exit zero even on internal error

#### Scenario: Only one copy of stop-sync.sh exists

- **WHEN** the plugin tree is inspected
- **THEN** `apps/plugin/scripts/stop-sync.sh` SHALL exist exactly once and be referenced by both `hooks.json` and `hooks.codex.json`
- **AND** no `stop-sync.codex.sh` variant SHALL exist

#### Scenario: Codex sessions remain active until abandoned by sweep

- **GIVEN** a Codex session where Stop has fired N times
- **WHEN** the user closes Codex CLI
- **THEN** the session row SHALL remain `status='active'` (no SessionEnd signal to transition it)
- **AND** the `abandonStale` job (running per `SESSION_ABANDON_AFTER_MS`, default 24h) SHALL eventually flip the row to `status='abandoned'`
- **AND** the row's `summary` and `title` SHALL reflect the most recent Stop's POST (the latest transcript)

#### Scenario: Codex Stop output without JSON would fail the hook

- **GIVEN** a script that POSTs `/summary` correctly but emits plain text to stdout
- **WHEN** Codex receives that stdout
- **THEN** Codex SHALL flag the hook output as invalid (per the "Stop expects JSON" contract) and the hook SHALL be considered failed for that turn

#### Scenario: prompt-search.sh self-filters on Codex

- **GIVEN** the `UserPromptSubmit` hook fires on Codex for a prompt that does NOT match the recall-intent keywords, on a turn that is not the session's first
- **WHEN** `prompt-search.sh` runs (invoked on every prompt, because no matcher is declared and Codex's dispatcher would ignore one anyway)
- **THEN** the script SHALL detect the non-match against the prompt text from stdin and exit without emitting either line
- **AND** on Claude Code the same matcher-less registration and the same self-filter SHALL produce byte-identical behaviour, since the filtering lives entirely in the script on both clients

#### Scenario: Compaction hooks are all correctly wired

- **WHEN** the repository is at HEAD
- **THEN** `apps/plugin/scripts/pre-compact.sh`, `apps/plugin/scripts/post-compaction.sh`, and `apps/plugin/scripts/post-compact.sh` SHALL all exist and be executable
- **AND** `hooks.codex.json` SHALL reference `pre-compact.sh` from its `PreCompact` entry, `post-compaction.sh` from its `PostCompact` entry, and `post-compact.sh` from its `SessionStart` `"compact"` matcher group

#### Scenario: Codex's Stop carries the end-of-turn reminder as a second entry

- **WHEN** `hooks.codex.json`'s `Stop` handlers are read in order
- **THEN** the second SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/stop-nudge.sh codex-cli`
- **AND** it SHALL be the same single script Claude Code invokes with no agent argument, diverging only in the stdout contract: Codex requires a JSON object on every invocation, so a silent turn SHALL emit `{}` where Claude Code emits nothing
- **AND** no `stop-nudge.codex.sh` variant SHALL exist
