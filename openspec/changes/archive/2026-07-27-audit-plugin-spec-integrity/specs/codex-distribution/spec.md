## ADDED Requirements

### Requirement: `/rembric:*` slash commands are Claude-Code-only and SHALL be documented as such

Rembric's four `/rembric:*` commands are auto-discovered by Claude Code from `apps/plugin/commands/*.md`; there is no `commands` field in `.claude-plugin/plugin.json` and none in `.codex-plugin/plugin.json`, which declares only `mcpServers` and `hooks`. Codex users therefore get the MCP tools and the hooks but **no slash commands**.

Both this capability and `claude-code-plugin` are currently silent on the asymmetry, so a reader of either has no way to learn it. This capability SHALL state it explicitly, and the Codex section of `docs/agents.md` SHALL state it in the operator-facing install material, so a Codex user does not go looking for `/rembric:remember`. The equivalent Codex path is to ask the agent in plain language; the protocol guidance the agent needs arrives server-side through the MCP `initialize.instructions` handshake, which is client-agnostic and unaffected.

This is a documentation requirement, not a feature gap: adding a Codex command surface is a separate change, and nothing here SHALL be read as committing to one.

#### Scenario: Neither manifest declares a commands field

- **WHEN** `apps/plugin/.codex-plugin/plugin.json` and `apps/plugin/.claude-plugin/plugin.json` are loaded
- **THEN** neither SHALL declare a `commands` field
- **AND** `.codex-plugin/plugin.json`'s only capability declarations SHALL be `mcpServers` and `hooks`

#### Scenario: The Codex install material states the asymmetry

- **WHEN** a reader opens the Codex section of `docs/agents.md`
- **THEN** it SHALL state that `/rembric:*` slash commands are a Claude Code feature and are not available under Codex
- **AND** it SHALL direct Codex users to ask the agent in plain language instead

## MODIFIED Requirements

### Requirement: Codex plugin manifest

The repository SHALL host a Codex plugin manifest at `apps/plugin/.codex-plugin/plugin.json`, sibling to the existing `apps/plugin/.claude-plugin/plugin.json`, declaring Codex's view of the shared `apps/plugin/` tree.

The two manifests SHALL agree on the fields that identify the same artifact and MAY diverge only where the platform or the audience differs. Enumerating both sets replaces an earlier requirement that the `author` block "match the Claude Code manifest" — untestable as written, and false as read, since `author.url` differed between the two files and the Claude Code manifest carries no `homepage` at all, so no single field set could be said to "match".

- Fields that SHALL be byte-identical across the two manifests: `name`, `version`, `license`, `repository`, `author.name`, `author.url`, `keywords`.
- Fields that MAY legitimately diverge: `description` (each names its client), `homepage` (Codex-only), `$schema` (Claude-Code-only), `userConfig` (Claude-Code-only — Codex has no keychain prompt; see the credential-flow requirement), `mcpServers`, and `hooks`.

#### Scenario: Required fields

- **WHEN** `apps/plugin/.codex-plugin/plugin.json` is loaded
- **THEN** it contains `name: "rembric"`, a `version`, a `description`, `license: "MIT"`, `repository`, `homepage`, and an `author` block with `name` and `url`
- **AND** it declares `mcpServers: "./.codex-plugin/mcp.json"` referencing the Codex-specific MCP config (NOT the Claude Code `mcp.json`)
- **AND** it declares `hooks: "./hooks/hooks.codex.json"` referencing the Codex-specific hook file

#### Scenario: Shared identity fields agree with the Claude Code manifest

- **WHEN** both manifests are loaded
- **THEN** `name`, `version`, `license`, `repository`, `author.name`, `author.url` and `keywords` SHALL be byte-identical in both
- **AND** a divergence in any of them SHALL fail the build

#### Scenario: No skills declaration

- **WHEN** the Codex manifest is loaded
- **THEN** it SHALL NOT declare a `skills` field — protocol guidance is delivered server-side via `initialize.instructions`, matching the Claude Code plugin's behaviour

### Requirement: Codex hook configuration

The repository SHALL host Codex hook configuration at `apps/plugin/hooks/hooks.codex.json`, sibling to the Claude Code plugin's `apps/plugin/hooks/hooks.json`, declaring the Codex-supported events the plugin wires: **five event types across seven handler entries**.

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
- **AND** those five SHALL carry exactly seven handler entries in total
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
- **THEN** the hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/stop-sync.sh codex-cli` — the same single script Claude Code's `Stop` hook invokes with `claude-code`, diverging in exactly THREE ways selected by that agent-name argument: (1) the transcript parser (`*_codex_cli` vs `*_claude_code`), (2) the stdout contract (Codex MUST `printf '{}'`; Claude Code MUST emit nothing), and (3) the `final` field (Codex sends `"final":false` explicitly; Claude Code OMITS the key entirely). It also diverges in execution model, which the agent argument selects rather than the caller: Codex runs synchronously because it has no documented async escape hatch and must emit its JSON before exiting, while Claude Code daemonizes the body into a detached, output-redirected subshell
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

### Requirement: The Codex hook catalog SHALL ship the shared unified `UserPromptSubmit` per-turn nudge hook

`apps/plugin/hooks/hooks.codex.json` SHALL declare a `UserPromptSubmit` entry invoking the SAME `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-nudge.sh` used by Claude Code (single-copy discipline — no Codex-specific variant), alongside the second `UserPromptSubmit` entry invoking `prompt-search.sh`. It SHALL NOT declare a `PostToolUse` save-nudge entry (the prior `post-tool.sh` approach is removed). Codex's behavior on this event is verified against its official hooks docs: the matcher is not used for `UserPromptSubmit` (the hook fires on every prompt), and plain text on stdout is added as extra developer context.

- Neither `UserPromptSubmit` entry SHALL declare a matcher. Codex would ignore one, and Claude Code's registration is deliberately matcher-less as well, so the two manifests agree and the script's own per-session turn counter is the sole throttle on both clients.
- The script emits the SAME plain `rembric:` save (every 5th turn), summary (turn 1 / every 10th) and sessionId (whenever either fires, and only when a session id is known) nudge lines as for Claude Code, as PLAIN stdout — NOT a JSON object. On `UserPromptSubmit`, plain stdout is the correct injection shape (unlike `PostToolUse`, where plain stdout is ignored and only JSON is honored).
- The emitted text is subject to the per-line byte budgets in `claude-code-plugin`'s token-budget requirement; those budgets are client-agnostic because the fixtures are shared.
- Fail-safe behavior is identical: unreadable/empty stdin exits 0 with no output, and an unreadable turn counter fails closed rather than defaulting to `0`.

#### Scenario: Codex reuses the shared script and self-throttles

- **GIVEN** the Codex plugin is installed and its `UserPromptSubmit` hook type is trusted in `/hooks`
- **WHEN** Codex fires `UserPromptSubmit` on the 5th and the 10th prompt of a session
- **THEN** `prompt-nudge.sh` SHALL emit the save nudge on turn 5 and BOTH the save and summary nudges on turn 10, using its own per-session counter (not any manifest matcher)

#### Scenario: Plain stdout, never JSON, on this event

- **WHEN** the script emits on a firing turn under Codex
- **THEN** it SHALL write plain `rembric:`-prefixed text (no `hookSpecificOutput` wrapper), which Codex injects as extra developer context
- **AND** the `rembric:` prefix SHALL keep Codex's `looks_like_json` heuristic from flagging it

#### Scenario: No PostToolUse save-nudge entry

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is inspected
- **THEN** it SHALL contain no `PostToolUse` entry emitting a `memory.save` reminder

#### Scenario: Single-copy discipline preserved

- **WHEN** the repo is inspected for hook-script duplication
- **THEN** `apps/plugin/scripts/prompt-nudge.sh` SHALL exist exactly once and be referenced by both `hooks.json` and `hooks.codex.json`; no `prompt-nudge.codex.sh` variant SHALL exist
