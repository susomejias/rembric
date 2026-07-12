## MODIFIED Requirements

### Requirement: Codex hook configuration

The repository SHALL host Codex hook configuration at `apps/plugin/hooks/hooks.codex.json`, sibling to the Claude Code plugin's `apps/plugin/hooks/hooks.json`, declaring the Codex-supported events the plugin wires.

Codex's hook surface differs from Claude Code's in ways the platform forces, and has evolved since this requirement was first written:

- Codex has no `SessionEnd` event (verified against `developers.openai.com/codex/hooks`).
- Codex DOES support `PreCompact` and `PostCompact` events as of current `codex-cli` releases (verified against `codex-rs/hooks/src/schema.rs` at `codex-cli` 0.142.3+); the plugin wires both.
- Codex's `SessionStart` stdin carries a `source` field (`startup|resume|clear|compact`), and the dispatcher matches `SessionStart` matchers against it — so, as of current `codex-cli`, a `matcher: "compact"` group behaves the same way it does for Claude Code (stdout injected as developer context, no HTTP side effect). The plugin wires a second `SessionStart` matcher group for `"compact"`, reusing the same `post-compact.sh` script Claude Code's `SessionStart(compact)` hook uses, so Codex gets the same "persist the summary after compaction" model directive.
- Codex's `Stop` hook REQUIRES JSON on stdout: "Stop expects JSON on stdout when it exits 0. Plain text output is invalid for this event." Per official docs.

Codex's mapping of lifecycle events to HTTP endpoints still diverges from Claude Code's where the platform forces it (no `SessionEnd`; Codex sessions stay `active` until the `abandonStale` job flips them to `abandoned` — this remains the steady state for Codex sessions), but no longer diverges on compaction-related hook support.

#### Scenario: Hook event coverage

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL declare entries for `SessionStart` (with two matcher groups — one for the default/unmatched case, one for `"compact"`), `UserPromptSubmit`, `Stop`, `PreCompact`, and `PostCompact`
- **AND** the `hooks` object SHALL NOT contain `SessionEnd` (Codex does not support this event)
- **AND** every hook entry SHALL be `type: "command"` — Codex does not support `type: "mcp_tool"` for hooks
- **AND** the default `SessionStart` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh codex-cli` (reused from the Claude Code plugin; the `agent` arg differs)
- **AND** the `SessionStart` `"compact"` matcher group SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compact.sh` (the same script Claude Code's `SessionStart(compact)` hook uses)
- **AND** the `UserPromptSubmit` hook SHALL declare the matcher `remember|recall|acuérdate|qué hicimos|what did we do` and invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh` (reused); because Codex's dispatcher does not filter `UserPromptSubmit` by matcher (unlike Claude Code's), `prompt-search.sh` itself SHALL apply the same keyword regex against the hook's stdin `prompt` field before proceeding, so the declared matcher and the script's own filtering agree on both clients
- **AND** the `PreCompact` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh codex-cli`
- **AND** the `PostCompact` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compaction.sh`

#### Scenario: Codex Stop wires to a per-turn summary writer

- **WHEN** the `Stop` hook fires (which it does once per agent turn under Codex semantics)
- **THEN** the hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-stop.sh codex-cli` (Codex-only — Claude Code does NOT wire `Stop` in this version)
- **AND** the script SHALL read `session_id`, `cwd`, and `transcript_path` from stdin
- **AND** SHALL read `${cwd}/.rembric` for the slug
- **AND** SHALL read `transcript_path` if readable, format it via `_transcript.sh`, derive a title from the first non-empty assistant message (≤100 chars)
- **AND** SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with body `{"summary": "<formatted>", "title": "<derived>", "final": false}` — note: `/summary` NOT `/end`, because Codex Stop is per-turn and the session must stay `active` for the next turn to keep updating
- **AND** SHALL emit `'{}'` to stdout (Codex requires JSON on Stop stdout; plain text is invalid per docs)
- **AND** SHALL exit zero even on internal error

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

- **GIVEN** the `UserPromptSubmit` hook fires on Codex for a prompt that does NOT match the recall-intent keywords
- **WHEN** `prompt-search.sh` runs (invoked regardless of the declared matcher, because Codex's dispatcher does not filter by matcher for this event)
- **THEN** the script SHALL detect the non-match against the prompt text from stdin and exit without emitting the recall nudge
- **AND** on Claude Code, where the matcher already filters invocation, the same script's self-filter SHALL be a harmless no-op re-check that still passes for matching prompts

#### Scenario: Compaction hooks are all correctly wired

- **WHEN** the repository is at HEAD after this change
- **THEN** `apps/plugin/scripts/pre-compact.sh`, `apps/plugin/scripts/post-compaction.sh`, and `apps/plugin/scripts/post-compact.sh` SHALL all exist
- **AND** `hooks.codex.json` SHALL reference `pre-compact.sh` from its `PreCompact` entry, `post-compaction.sh` from its `PostCompact` entry, and `post-compact.sh` from its `SessionStart` `"compact"` matcher group

### Requirement: `docs/agents.md` recommends the plugin install as primary

The Codex section of `docs/agents.md` SHALL recommend the **TUI installer** (`apps/plugin/install.sh` / the root shim) as the primary install path. It SHALL retain the Codex marketplace plugin install (`codex plugin marketplace add … && codex plugin add rembric@rembric`) and the manual `config.toml` fallback, but both SHALL appear under an explicitly-labelled "Manual / advanced" subsection, not as the lead instruction. The section SHALL document the credential flow, and the platform-required per-hook trust review (Codex hooks are stable and enabled by default as of current `codex-cli` releases; no feature flag needs to be enabled). The "trust each of the N plugin-bundled hooks" guidance SHALL enumerate the FIVE hook event types (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`).

#### Scenario: Codex section leads with the TUI installer

- **WHEN** a reader opens the Codex section of `docs/agents.md`
- **THEN** the first install instruction SHALL be the TUI installer
- **AND** the `codex plugin marketplace add` / `codex plugin add` commands and the manual `config.toml` SHALL appear only under a manual / advanced heading

#### Scenario: Platform-required hook trust review enumerates five hook types

- **WHEN** a reader follows the Codex install flow in `docs/agents.md`
- **THEN** the doc SHALL document, after the install + env-var snippets, that opening `/hooks` inside Codex and trusting each of the 5 plugin-bundled hook types (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`) is the only platform-required step remaining — Codex surfaces a startup banner of the form _"N hooks need review before they can run. Open `/hooks` to review them."_ — until each hook type is trusted, it loads but does not execute
- **AND** the doc SHALL NOT instruct readers to run `codex features enable plugin_hooks` (that feature flag was removed upstream; hooks are stable and on by default)
- **AND** the doc SHALL note that the trust persists in `~/.codex/config.toml`'s `[hooks.state]` block; users do not need to re-approve hooks after every Codex restart, only once per hook handler

(Other scenarios within this requirement remain unchanged.)
