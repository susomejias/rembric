## MODIFIED Requirements

### Requirement: Codex hook configuration

The repository SHALL host Codex hook configuration at `apps/plugin/hooks/hooks.codex.json`, sibling to the Claude Code plugin's `apps/plugin/hooks/hooks.json`, declaring the FIVE Codex-supported events the plugin wires.

Codex's hook surface differs from Claude Code's in ways the platform forces:

- Codex has no `SessionEnd` event (verified against `developers.openai.com/codex/plugins/hooks` AND the upstream source `codex-rs/hooks/src/engine/output_parser.rs` which lacks a `parse_session_end`).
- Codex's `SessionStart` matcher does not include `"compact"` — only `startup|resume|clear`.
- Codex's `Stop` hook REQUIRES JSON on stdout: "Stop expects JSON on stdout when it exits 0. Plain text output is invalid for this event." Per official docs.
- **Codex DOES support `PreCompact` and `PostCompact`** — verified against the upstream source `codex-rs/hooks/src/engine/output_parser.rs::parse_pre_compact` and `::parse_post_compact`. The public docs at `developers.openai.com/codex/plugins/hooks` do not document these events (incomplete docs), but the source is authoritative. This corrects the prior spec's claim "Codex has no PreCompact or PostCompact event", which was authored against the partial public docs.

Therefore Codex's mapping of lifecycle events to HTTP endpoints diverges from Claude Code's by necessity (no SessionEnd), NOT by choice. Codex sessions stay `active` until the `abandonStale` job flips them to `abandoned`; this is the steady state for Codex sessions.

#### Scenario: Hook event coverage

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL declare entries for `SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, and `PostCompact` (five events)
- **AND** the `hooks` object SHALL NOT contain `SessionEnd` (Codex does not support this event)
- **AND** every hook entry SHALL be `type: "command"` — Codex does not support `type: "mcp_tool"` for hooks
- **AND** the `SessionStart` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh codex-cli` (reused from the Claude Code plugin; the `agent` arg differs)
- **AND** the `UserPromptSubmit` hook SHALL declare the matcher `remember|recall|acordate|qué hicimos|what did we do` and invoke `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-search.sh` (reused)
- **AND** the `PreCompact` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh codex-cli` (reused from the Claude Code plugin; the agent arg selects the codex_cli variant of the transcript helpers)
- **AND** the `PostCompact` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compaction.sh` (reused; the script does not need an agent argument because `compaction_summary` is the same field across clients)

#### Scenario: Codex Stop wires to a per-turn summary writer

- **WHEN** the `Stop` hook fires (which it does once per agent turn under Codex semantics)
- **THEN** the hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-stop.sh codex-cli` (Codex-only — Claude Code does NOT wire `Stop` in this version)
- **AND** the script SHALL read `session_id`, `cwd`, and `transcript_path` from stdin
- **AND** SHALL read `${cwd}/.rembric` for the slug
- **AND** SHALL read `transcript_path` if readable, format it via `_transcript.sh`, derive a title from the first non-empty assistant message (≤100 chars)
- **AND** SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with body `{"summary": "<formatted>", "title": "<derived>", "final": false}` — note: `/summary` NOT `/end`, because Codex Stop is per-turn and the session must stay `active` for the next turn to keep updating
- **AND** SHALL emit `'{}'` to stdout (Codex requires JSON on Stop stdout; plain text is invalid per docs)
- **AND** SHALL exit zero even on internal error

#### Scenario: Codex PreCompact persists the transcript before context is wiped

- **GIVEN** a Codex session and `${cwd}/.rembric` containing `PROJECT_SLUG=foo`
- **WHEN** Codex fires the `PreCompact` hook with stdin containing `session_id`/`sessionId`, `cwd`, and `transcript_path` (exact key names verified during implementation against `codex-rs/hooks/src/schema.rs`)
- **THEN** `pre-compact.sh codex-cli` SHALL POST `/api/foo/sessions/<id>/summary` with the formatted transcript using the `codex_cli` variant of the `_transcript.sh` helpers
- **AND** the script SHALL emit no stdout (Codex's `PreCompact` stdout contract permits empty output)

#### Scenario: Codex PostCompact persists the model-authored compaction summary

- **WHEN** Codex completes a compaction and fires `PostCompact` with stdin containing `session_id`/`sessionId`, `cwd`, and `compaction_summary` (or `compactionSummary` — the shared helper handles both via the fallback path)
- **THEN** `post-compaction.sh` SHALL POST `/api/<slug>/sessions/<id>/summary` with body `{"summary": "<compaction_summary>", "final": false}`
- **AND** the script SHALL emit no stdout

#### Scenario: Codex sessions remain active until abandoned by sweep

- **GIVEN** a Codex session where Stop has fired N times and PreCompact/PostCompact may have fired
- **WHEN** the user closes Codex CLI
- **THEN** the session row SHALL remain `status='active'` (no SessionEnd signal to transition it)
- **AND** the `abandonStale` job (running per `SESSION_ABANDON_AFTER_MS`, default 24h) SHALL eventually flip the row to `status='abandoned'`
- **AND** the row's `summary` and `title` SHALL reflect whichever was most recent: Stop's per-turn POST, PreCompact's transcript snapshot, or PostCompact's compaction_summary

#### Scenario: pre-compact-codex.sh deletion remains in effect

- **WHEN** the repository is at HEAD after this change
- **THEN** the file `apps/plugin/scripts/pre-compact-codex.sh` SHALL NOT exist (it was removed by an earlier change and stays removed)
- **AND** `apps/plugin/scripts/pre-compact.sh` SHALL exist as the SHARED script consumed by both `hooks.json` and `hooks.codex.json` (per the `shared-plugin-logic` doctrine)

## MODIFIED Requirements

### Requirement: Codex hooks MUST receive `session_id` from stdin in the same JSON shape as Claude Code

The shared scripts `session-start.sh`, `session-stop.sh`, `pre-compact.sh`, and `post-compaction.sh` SHALL read the hook stdin as a JSON object containing a `session_id` field (and `cwd` when relevant). Claude Code and Codex CLI both pass the host-session id in stdin JSON for `command`-type hooks.

If Codex passes the id under a different key (e.g. `sessionId`), the scripts SHALL prefer `session_id` and SHALL fall back to `sessionId` so the same script supports both clients without per-client forks. When neither field is present the scripts SHALL skip the HTTP call and exit `0`.

`post-compaction.sh` additionally reads `compaction_summary` and SHALL apply the same naming-fallback discipline (`compaction_summary` then `compactionSummary`) — the contract MUST stay symmetric with how `session_id`/`sessionId` is handled today, so no per-client forks accrue.

#### Scenario: Script reads stdin in both shapes

- **WHEN** the script receives stdin `{"session_id": "x"}` (Claude shape)
- **THEN** it SHALL extract `x` as the session id

- **WHEN** the script receives stdin `{"sessionId": "x"}` (Codex shape, if it differs)
- **THEN** it SHALL extract `x` as the session id

- **WHEN** the script receives stdin with neither field
- **THEN** it SHALL skip the HTTP call, emit a stderr diagnostic, and exit `0`

#### Scenario: post-compaction.sh reads compaction_summary in both shapes

- **WHEN** `post-compaction.sh` receives stdin `{"compaction_summary": "..."}` (Claude shape)
- **THEN** it SHALL extract the value as the summary text

- **WHEN** the script receives stdin `{"compactionSummary": "..."}` (Codex shape, if different)
- **THEN** it SHALL extract the value as the summary text

- **WHEN** the script receives stdin with neither field
- **THEN** it SHALL POST `/summary {}`, emit a stderr diagnostic, and exit `0`

#### Scenario: Codex session id format may differ from Claude's

(Unchanged from the prior spec — the regex `^[A-Za-z0-9_-]{8,128}$` continues to accept all Codex id shapes seen to date.)

## MODIFIED Requirements

### Requirement: `docs/agents.md` recommends the plugin install as primary

The Codex section of `docs/agents.md` SHALL recommend the marketplace plugin install as the primary path, document the credential flow, document the platform-required enablement steps for plugin hooks (which Codex gates behind an under-development feature flag and a per-hook trust review as of `codex-cli 0.130.0`), and retain a manual `config.toml` fallback for users who do not want the plugin. The "trust each of the N plugin-bundled hooks" guidance SHALL be updated to enumerate the now-FIVE hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`) — superseding the previous "4 plugin-bundled hooks" wording.

#### Scenario: Platform-required hook enablement enumerates five hooks

- **WHEN** a reader follows the Codex install flow in `docs/agents.md`
- **THEN** the doc SHALL document, after the install + env-var snippets, that two additional platform-required steps are necessary to make plugin-bundled hooks fire under `codex-cli 0.130.0`:
  - **Step 1**: enable the `plugin_hooks` feature with `codex features enable plugin_hooks`. The doc SHALL note that this feature is currently `under development` in Codex (default off) and that future Codex releases may default it on — readers should run `codex features list` to confirm before assuming.
  - **Step 2**: open `/hooks` inside Codex and trust each of the 5 plugin-bundled hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`). Codex surfaces a startup banner of the form _"N hooks need review before they can run. Open `/hooks` to review them."_ — until each hook is trusted, it loads but does not execute.
- **AND** the doc SHALL note that the trust persists in `~/.codex/config.toml`'s `[hooks.state]` block; users do not need to re-approve hooks after every Codex restart, only once per hook handler.

(Other scenarios within this requirement remain unchanged.)
