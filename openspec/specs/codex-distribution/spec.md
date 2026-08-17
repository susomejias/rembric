# codex-distribution

## Purpose

Distribution and configuration of Rembric for Codex CLI. Defines the dual-manifest layout that lets one `apps/plugin/` source tree serve both the Claude Code and Codex marketplaces, the Codex-specific hook subset, the marketplace declaration, and the credential flow given Codex's lack of a keychain-style `userConfig` prompt.

## Requirements

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

### Requirement: Codex marketplace declaration

The repository SHALL host a Codex marketplace manifest at `.codex-plugin/marketplace.json` at the repo root, installable via `codex plugin marketplace add <repo>`. The `source.path` entry SHALL point at `./apps/plugin` so the marketplace's `git-subdir` extraction targets the relocated plugin tree.

#### Scenario: git-subdir source

- **WHEN** `.codex-plugin/marketplace.json` is loaded
- **THEN** it declares exactly one plugin entry named `rembric`
- **AND** the entry's `source` object is `{ "source": "git-subdir", "url": "https://github.com/susomejias/rembric.git", "path": "./apps/plugin", "ref": "main" }`
- **AND** the entry declares `policy.installation: "AVAILABLE"` and `policy.authentication: "ON_INSTALL"` and `category: "Memory"`

#### Scenario: Marketplace metadata

- **WHEN** the marketplace is loaded
- **THEN** the top-level object contains `name: "rembric"` and `interface.displayName: "Rembric"`

#### Scenario: Marketplace install resolves the relocated plugin tree

- **GIVEN** a clean Codex CLI installation with no `rembric` plugin cached
- **WHEN** the user runs `codex plugin marketplace add https://github.com/susomejias/rembric.git` followed by `codex plugin add rembric@rembric`
- **THEN** Codex SHALL clone the repo, extract the subtree at `./apps/plugin` per the `source.path`, and cache it under `~/.codex/plugins/cache/rembric/<version>/`
- **AND** the cached directory SHALL contain `.codex-plugin/plugin.json`, `.codex-plugin/mcp.json`, `hooks/hooks.codex.json`, and the relevant `scripts/` files
- **AND** it SHALL NOT be required to contain `bin/rembric-bridge.mjs` or a dotenv module: Codex spawns the published bridge through `npx`, so no repository file is on the MCP path for this client

### Requirement: Codex hooks MUST receive `session_id` from stdin in the same JSON shape as Claude Code

The shared scripts `session-start.sh`, `pre-compact.sh`, and `stop-report.sh` SHALL read the hook stdin as a JSON object containing a `session_id` field (and `cwd` when relevant). Claude Code and Codex CLI both pass the host-session id in stdin JSON for `command`-type hooks. `stop-report.sh` replaces the deleted `stop-sync.sh` named here before the nudge gate moved to the server; the stdin contract is unchanged by that substitution.

If Codex passes the id under a different key (e.g. `sessionId`), the scripts SHALL prefer `session_id` and SHALL fall back to `sessionId` so the same script supports both clients without per-client forks. When neither field is present the scripts SHALL skip the HTTP call and exit `0`.

#### Scenario: Script reads stdin in both shapes

- **WHEN** the script receives stdin `{"session_id": "x"}` (Claude shape)
- **THEN** it SHALL extract `x` as the session id

- **WHEN** the script receives stdin `{"sessionId": "x"}` (Codex shape, if it differs)
- **THEN** it SHALL extract `x` as the session id

- **WHEN** the script receives stdin with neither field
- **THEN** it SHALL skip the HTTP call, emit a stderr diagnostic, and exit `0`

#### Scenario: Codex session id format may differ from Claude's

- **WHEN** Codex passes an id like `codex-2026-05-15-abc123`
- **THEN** the server's regex `^[A-Za-z0-9_-]{8,128}$` SHALL accept it
- **AND** the upsert SHALL succeed under the calling token's namespace

#### Scenario: Codex session id outside the allowed format

- **WHEN** Codex passes an id that contains characters outside `[A-Za-z0-9_-]` (theoretical; should not happen in practice)
- **THEN** the server SHALL respond `400 invalid_input`
- **AND** the script SHALL exit `0` (failure is silent at the hook level)

### Requirement: End-user credential flow

Codex install material SHALL document the credential flow given Codex's lack of a `userConfig` keychain prompt and Codex's `env_clear` behaviour on MCP subprocesses.

#### Scenario: Documented env-var requirement

- **WHEN** a user reads `docs/agents.md`'s Codex section
- **THEN** the doc SHALL state that Codex users MUST export `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` in the shell that launches `codex` — this is the canonical path under Codex, not a fallback
- **AND** the doc SHALL provide a literal `export REMBRIC_SERVER_URL=...; export REMBRIC_API_TOKEN=...` snippet
- **AND** the doc SHALL explain that the plugin's `env_vars` field is what forwards those vars to the bridge subprocess (citing `create_env_for_mcp_server` in `codex-rs/rmcp-client/src/utils.rs` so future readers can verify), AND that Codex's `env_clear()` semantics make `env_vars` mandatory — there is no implicit inheritance from the parent shell

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

### Requirement: The Codex hook catalog SHALL ship the shared unified `UserPromptSubmit` per-turn nudge hook

`apps/plugin/hooks/hooks.codex.json` SHALL declare a `UserPromptSubmit` entry invoking the SAME `${CLAUDE_PLUGIN_ROOT}/scripts/prompt-nudge.sh` used by Claude Code (single-copy discipline — no Codex-specific variant), alongside the second `UserPromptSubmit` entry invoking `prompt-search.sh`. It SHALL NOT declare a `PostToolUse` save-nudge entry (the prior `post-tool.sh` approach is removed). Codex's behavior on this event is verified against its official hooks docs: the matcher is not used for `UserPromptSubmit` (the hook fires on every prompt), and plain text on stdout is added as extra developer context.

- Neither `UserPromptSubmit` entry SHALL declare a matcher. Codex would ignore one, and Claude Code's registration is deliberately matcher-less as well, so the two manifests agree.
- **The script no longer throttles.** The per-session turn counter that used to be the sole throttle on both clients is deleted: the firing decision belongs to the server (`session-nudges`), and this entry prints what the previous turn's report cached. The lines it emits are the sessionId line, the session opening on a newly created session, and the server-composed notice — the same set, from the same sources, as under Claude Code.
- The emitted text SHALL be PLAIN stdout, never a JSON object. On `UserPromptSubmit`, plain stdout is the correct injection shape (unlike `PostToolUse`, where plain stdout is ignored and only JSON is honored).
- **The `rembric:` prefix on the server-composed notice is the SERVER's responsibility**, and that is what keeps Codex's `looks_like_json` heuristic from flagging it. A client-side prefix would be a second place for the two hosts to diverge, which is exactly what the shared-fixture discipline exists to prevent.
- The emitted text is subject to the per-line byte budgets in `claude-code-plugin`'s token-budget requirement; those budgets are client-agnostic because the client-composed lines share fixtures and the notice has a single server-side bound.
- Fail-safe behavior is identical: unreadable or empty stdin exits 0 with no output, and an unreadable cache file emits nothing rather than a partial line.

#### Scenario: Codex reuses the shared script and prints what the server sent

- **GIVEN** the Codex plugin is installed and its `UserPromptSubmit` hook type is trusted in `/hooks`
- **WHEN** Codex fires `UserPromptSubmit` on a turn whose predecessor's report returned notice lines
- **THEN** `prompt-nudge.sh` SHALL emit the sessionId line followed by those lines verbatim
- **AND** on a turn with no cached lines and no opening due, it SHALL emit nothing

#### Scenario: Plain stdout, never JSON, on this event

- **WHEN** the script emits on a turn with lines to print under Codex
- **THEN** it SHALL write plain `rembric:`-prefixed text (no `hookSpecificOutput` wrapper), which Codex injects as extra developer context
- **AND** the prefix SHALL have come from the server for the notice and from the shared fixtures for the client-composed lines

#### Scenario: No PostToolUse save-nudge entry

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is inspected
- **THEN** it SHALL contain no `PostToolUse` entry emitting a `memory.save` reminder

#### Scenario: Single-copy discipline preserved

- **WHEN** the repo is inspected for hook-script duplication
- **THEN** `apps/plugin/scripts/prompt-nudge.sh` SHALL exist exactly once and be referenced by both `hooks.json` and `hooks.codex.json`; no `prompt-nudge.codex.sh` variant SHALL exist

#### Scenario: Codex finally receives the periodic reminder at all

- **GIVEN** a Codex session in which several turns invoked tools and a nudge floor has elapsed
- **WHEN** the reminder would fire
- **THEN** the notice SHALL be printed on the next `UserPromptSubmit`
- **AND** this SHALL be a behaviour change from before this requirement's revision, where the periodic reminder was measurably unreachable on Codex: the end-of-turn script's fact extractor had no `codex_cli` implementation, so `rembric_session_facts_raw codex_cli` returned empty and the reminder emitted `{}` on every firing turn

### Requirement: The Codex post-compaction block MUST share the English protocol text

Codex CLI and Claude Code invoke the same post-compaction script, so the language defect and its fix apply to both clients simultaneously. The Codex hook manifest SHALL continue to invoke the shared script, and the English protocol text SHALL be asserted once in the shared fixtures rather than duplicated per client — a per-client copy is a sync bug by the plugin-tree discipline.

#### Scenario: Codex emits the same English block

- **WHEN** the Codex post-compaction hook fires
- **THEN** the emitted protocol block SHALL be byte-identical to the block emitted for Claude Code

#### Scenario: No per-client copy of the text exists

- **WHEN** the plugin tree is inspected for the post-compaction protocol text
- **THEN** exactly one copy SHALL exist outside the test fixtures

### Requirement: Codex hook configuration and its `SessionEnd` budget

The repository SHALL host Codex hook configuration at `apps/plugin/hooks/hooks.codex.json`, sibling to the Claude Code plugin's `apps/plugin/hooks/hooks.json`, declaring the Codex-supported events the plugin wires: **six event types across eight handler entries**.

Codex's hook surface differs from Claude Code's in ways the platform forces, and has evolved since this requirement was first written:

- **Codex DOES have a `SessionEnd` event, and this capability previously asserted it did not.** Per `learn.chatgpt.com/docs/hooks`, it "runs for the main thread when you archive or delete a conversation that's still open, when Codex closes normally, or after a conversation has been idle and isn't open in any connected client for 30 minutes. It won't run for subagents." Its stdin carries `session_id`, `transcript_path`, `cwd`, `hook_event_name` and `reason`; `matcher` filters `reason`, whose only current value is `other`, so the entry SHALL declare no matcher. Its output is advisory — "Their output won't steer Codex or keep the thread open" — so the handler SHALL emit nothing to stdout, matching Claude Code's `SessionEnd`.
- **`SessionEnd` carries the tightest time budget of any hook on either host, and it is not the 600-second default.** Verbatim: "If `timeout` is omitted, Codex uses 600 seconds for most hooks. `SessionEnd` uses `1` second by default and supports up to `3` seconds." The plugin's shared curl helper allows a POST 3 seconds (`claude-code-plugin`, `rembric_post`), so an undeclared timeout kills the handler before its request can complete, and a declared `"timeout": 3` with an unchanged POST budget leaves nothing for reading the transcript or emitting the failure diagnostic. The entry SHALL therefore declare `"timeout": 3` — the documented maximum — AND cap its own POST at 2 seconds through the helper's budget override. Neither half is optional: the timeout alone still lets one slow request consume the whole budget, and the override alone still leaves the handler dead at one second. **The deterministic fact extraction that moves onto this path (`sessions`) SHALL NOT change that arithmetic on Codex, because no `codex_cli` fact extractor exists — the call returns empty and the existing transcript formatter runs, exactly as before.** Should one be added later, it SHALL be bounded so the handler still fits the 3-second maximum.
- Codex DOES support `PreCompact` and `PostCompact` events as of current `codex-cli` releases; the plugin wires both. `apps/plugin/scripts/pre-compact.sh` exists and is invoked from `hooks.codex.json`'s `PreCompact` entry — any statement that it should be removed for lack of a Codex event is false.
- Codex's `SessionStart` stdin carries a `source` field and the dispatcher matches `SessionStart` matchers against it, so a `matcher: "compact"` group behaves the same way it does for Claude Code. Both matcher groups are declared **explicitly**: `startup|resume|clear` and `compact`. Neither is a default/unmatched group. Codex's documented `source` values are exactly `startup`, `resume`, `clear` and `compact`; there is no `fork` source as there is on Claude Code, so the Codex manifest SHALL NOT declare one and the divergence from `hooks.json` is the hosts', not a plugin inconsistency.
- Codex's dispatcher does NOT filter `UserPromptSubmit` by matcher; the hook fires on every prompt regardless. The manifest therefore declares NO matcher on either `UserPromptSubmit` entry, and each script self-filters internally.
- Codex's `Stop` hook REQUIRES JSON on stdout: "Stop expects JSON on stdout when it exits 0. Plain text output is invalid for this event." Per official docs. **`Stop` now carries exactly ONE entry**, `stop-report.sh codex-cli`, whose entire model-facing output is that `{}`.

`apps/plugin/scripts/session-end.sh` SHALL take an optional agent-name argument selecting the per-client transcript parser, exactly as `pre-compact.sh <agent>` already does (`claude-code` default, `codex-cli` selecting the `*_codex_cli` helpers). There SHALL be no `session-end.codex.sh`. Both manifests SHALL pass the argument explicitly.

`abandonStale` remains the net for every Codex close where `SessionEnd` does not fire — subagent threads, a SIGKILL, or a handler killed by its 1–3 second budget before its POST landed. **What keeps a LIVE Codex session out of that sweep is now the per-turn report** rather than the per-turn `/summary` POST: `POST /api/<slug>/sessions/<id>/turn` stamps `last_activity_at` on every turn (`http-api`), which is the obligation the deleted raw sync used to discharge.

The authoritative table of which hook POSTs what for both clients is `plugin-session-protocol`'s lifecycle mapping, which also carries the cross-client rule that every ensure of a session id is followed once per process by `POST /api/<slug>/sessions/<id>/resume`, and the rule that every client reports exactly one turn per turn.

#### Scenario: Hook event coverage

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL declare exactly these six event types and no others: `SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`, `SessionEnd`
- **AND** those six SHALL carry exactly eight handler entries in total
- **AND** `SessionStart` SHALL declare exactly two matcher groups, with the literal matchers `startup|resume|clear` and `compact`
- **AND** `UserPromptSubmit` SHALL declare exactly two entries, invoking `prompt-search.sh` and `prompt-nudge.sh`, and NEITHER SHALL carry a `matcher` key
- **AND** `Stop` SHALL declare exactly ONE entry, invoking `${CLAUDE_PLUGIN_ROOT}/scripts/stop-report.sh codex-cli`
- **AND** the `hooks` object SHALL NOT contain `PostToolUse`
- **AND** every hook entry SHALL be `type: "command"` — Codex does not support `type: "mcp_tool"` for hooks
- **AND** the `startup|resume|clear` `SessionStart` group SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh codex-cli`
- **AND** the `SessionStart` `"compact"` matcher group SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compact.sh codex-cli`
- **AND** the `PreCompact` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh codex-cli`
- **AND** the `PostCompact` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compaction.sh`
- **AND** the `SessionEnd` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-end.sh codex-cli`

#### Scenario: The manifest test asserts the new counts as exact sets

- **WHEN** `apps/plugin/test/hook-manifests.test.ts` is read at HEAD
- **THEN** the `SessionEnd` assertion SHALL still require the entry to exist, declare `"timeout": 3` and carry no `matcher` key
- **AND** the event-type set assertion SHALL name six events including `SessionEnd`
- **AND** the handler-count assertion SHALL be `8`, not `9`
- **AND** the ordered invocation list SHALL name `Stop command scripts/stop-report.sh codex-cli` exactly once and SHALL NOT name `stop-sync.sh` or `stop-nudge.sh`
- **AND** each assertion SHALL still be an exact set or exact count, never a containment check

#### Scenario: The SessionEnd handler fits inside the event's budget

- **WHEN** `hooks.codex.json`'s `SessionEnd` entry is read
- **THEN** it SHALL declare `"timeout": 3`
- **AND** it SHALL set the shared helper's POST budget to a value strictly below that timeout, so a hanging server yields the failed-POST stderr diagnostic rather than a handler killed with no record
- **AND** the control SHALL pass in the same run: the entry's timeout SHALL NOT be raised above `3`, which the host does not honour for this event

#### Scenario: A normally-closed Codex session reaches `ended`

- **GIVEN** a Codex session of N turns whose `Stop` hook reported each turn
- **WHEN** Codex closes normally and `SessionEnd` fires with a readable `transcript_path`
- **THEN** the handler SHALL POST `/api/<slug>/sessions/<id>/end` with `{summary, title, final:false}`, or `{}` when the transcript is unreadable or parses empty
- **AND** the row SHALL be `status='ended'` with `ended_at` set
- **AND** the handler SHALL emit nothing to stdout, because Codex documents `SessionEnd` output as advisory and it cannot reach the model

#### Scenario: A Codex close where SessionEnd does not fire still reaches a terminal state

- **GIVEN** a Codex session terminated by SIGKILL, or running as a subagent thread (for which the host documents that `SessionEnd` does not run)
- **WHEN** the process disappears
- **THEN** the row SHALL remain `status='active'`
- **AND** the `abandonStale` job (running per `SESSION_ABANDON_AFTER_MS`, default 24h) SHALL flip it to `status='abandoned'`
- **AND** the row's `summary` SHALL be whatever the last curated write or milestone flush stored — no per-turn transcript is written any more, so a session hard-killed between milestones may carry no summary at all

#### Scenario: A resumed Codex conversation re-attaches its memories

- **GIVEN** a Codex session `<S>` whose row is `ended` (normal close) or `abandoned` (sweep)
- **WHEN** the operator reopens that conversation and Codex fires `SessionStart` with `source: "resume"` for the same `session_id`
- **THEN** `session-start.sh` SHALL POST the ensure and then `POST /api/<slug>/sessions/<S>/resume`
- **AND** the row SHALL be `status='active'` with `ended_at IS NULL`
- **AND** a subsequent `memory.save` on that conversation's MCP transport SHALL persist a non-null `session_id`
- **AND** the control SHALL pass in the same run: the same `memory.save` without the resume persists `session_id = NULL`

#### Scenario: Codex Stop reports the turn and emits only `{}`

- **WHEN** the `Stop` hook fires (which it does once per agent turn under Codex semantics)
- **THEN** the single entry SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/stop-report.sh codex-cli` — the same script Claude Code's `Stop` hook invokes with `claude-code`, diverging in exactly TWO ways selected by that agent-name argument: (1) the transcript marker used to detect tool use (`"function_call"` / `mcp_tool_call` vs `"type":"tool_use"`), and (2) the stdout contract (Codex MUST `printf '{}'`; Claude Code MUST emit nothing)
- **AND** the script SHALL read `session_id`, `cwd`, `transcript_path` and `stop_hook_active` from stdin
- **AND** SHALL read `${cwd}/.rembric` for the slug
- **AND** SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/turn` with `{"usedTools": <bool>}` and cache the response's `lines`
- **AND** SHALL emit `'{}'` to stdout and nothing else
- **AND** SHALL exit zero even on internal error

#### Scenario: A degenerate turn-report response still leaves Codex its `{}`

- **GIVEN** a `/turn` call answered `200` with a body that carries no `lines` key, an empty `lines` array the raw-body fast path does not match, or no JSON at all
- **WHEN** the `Stop` hook runs under `codex-cli`
- **THEN** stdout SHALL still be exactly `{}`
- **AND** the control SHALL pass in the same run: the report SHALL have been POSTed, so the `{}` is not the early return that skips it

This is stated because it was broken: `_api.sh`'s promise that "every function exits 0 on failure … so a plugin-side problem NEVER aborts the host agent" is enforced by the `trap 'exit 0' ERR` at the top of that file, and the trap is NOT inherited by shell functions (there is no `set -E`). A helper that returns non-zero therefore fails at the CALLER's `LINES="$(…)"` assignment, where the trap does apply, and the caller dies before `_emit_nothing`. Both of the report helper's terminating statements SHALL return zero on their own.

#### Scenario: `stop-sync.sh` and `stop-nudge.sh` no longer exist

- **WHEN** the plugin tree is inspected at HEAD
- **THEN** neither `apps/plugin/scripts/stop-sync.sh` nor `apps/plugin/scripts/stop-nudge.sh` SHALL exist
- **AND** neither manifest SHALL reference them

#### Scenario: Only one copy of stop-report.sh exists

- **WHEN** the plugin tree is inspected
- **THEN** `apps/plugin/scripts/stop-report.sh` SHALL exist exactly once and be referenced by both `hooks.json` and `hooks.codex.json`
- **AND** no `stop-report.codex.sh` variant SHALL exist

#### Scenario: Only one copy of session-end.sh exists

- **WHEN** the plugin tree is inspected
- **THEN** `apps/plugin/scripts/session-end.sh` SHALL exist exactly once and be referenced by both `hooks.json` and `hooks.codex.json`
- **AND** no `session-end.codex.sh` variant SHALL exist
- **AND** the per-client transcript parser SHALL be selected by the agent-name argument, not by a second script

#### Scenario: Codex Stop output without JSON would fail the hook

- **GIVEN** a script that reports the turn correctly but emits plain text to stdout
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

### Requirement: Codex-specific MCP server configuration MUST spawn the pinned bridge through `npx`

The Codex plugin SHALL ship its own MCP server configuration file at `apps/plugin/.codex-plugin/mcp.json`, sibling to the Claude Code plugin's `apps/plugin/.claude-plugin/mcp.json`. The two files still diverge, but for one reason rather than two: Codex's `Command::env_clear()` strips parent-env inheritance, so `env_vars` is the only channel by which anything reaches the spawned process (see `codex-rs/rmcp-client/src/utils.rs::create_env_for_mcp_server`). The path-resolution divergence disappears — neither manifest names a repository file any more, because both spawn the published `@rembric/mcp-bridge` through `npx`.

The `env_vars` list SHALL forward the user's shell `PWD` so the bridge can resolve the user's project directory: Codex's spawn semantics put `process.cwd()` at the plugin cache directory, which is not the project.

**`PATH` forwarding is not optional and is not assumed.** `command: "node"` working under `env_clear()` is not evidence that `command: "npx"` will: `npx` must itself be locatable and must locate `node`. Whether the launcher's program resolution suffices SHALL be **verified against a real Codex before this manifest is switched**, and if it does not, `PATH` SHALL be added to `env_vars`. A manifest that spawns a program the curated environment cannot resolve fails at session start with an error the user cannot interpret.

#### Scenario: Codex MCP config file spawns the pinned bridge

- **WHEN** `apps/plugin/.codex-plugin/mcp.json` is loaded
- **THEN** the top-level object contains exactly one entry `mcpServers.rembric`
- **AND** the entry declares `command: "npx"`
- **AND** the entry declares `args: ["-y", "@rembric/mcp-bridge@<x.y.z>"]` with an exact version and no further argument
- **AND** the entry declares `env_vars` including `REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN` and `PWD`
- **AND** the entry SHALL NOT declare an `env` field — Codex would treat any literal map values as opaque overrides that clobber `env_vars` reads

#### Scenario: `npx` resolves under Codex's curated environment

- **WHEN** Codex spawns the entry with its `env_clear()` semantics
- **THEN** `npx` SHALL be locatable and SHALL be able to spawn `node`
- **AND** if that requires `PATH` in `env_vars`, `env_vars` SHALL declare it
- **AND** this SHALL have been verified against a real Codex rather than inferred from the previous `command: "node"` entry working

#### Scenario: env_vars forwards REMBRIC\_\* from the launching shell

- **WHEN** Codex spawns the bridge per `apps/plugin/.codex-plugin/mcp.json`
- **THEN** `create_env_for_mcp_server` SHALL read `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from Codex's own process env
- **AND** the curated env passed to the subprocess SHALL contain those names with the user-supplied values
- **AND** the bridge SHALL build a real URL — e.g. `http://192.0.2.10:8787/mcp/<slug>` — not a placeholder literal

#### Scenario: env_vars forwards PWD so the bridge can resolve the user's project directory

- **WHEN** Codex spawns the bridge AND the shell that launched `codex` has `PWD` set
- **THEN** the curated env SHALL contain `PWD` with the shell's working directory
- **AND** the bridge's project-directory resolution SHALL pick `PWD` as the `projectDir`
- **AND** path-scoping via `${projectDir}/.rembric` SHALL function correctly when the user has launched `codex` from their project root

#### Scenario: The bridge surfaces a useful error when env vars are missing

- **WHEN** the user launches `codex` without exporting `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN`
- **THEN** Codex's `env_vars` mechanism silently skips names it cannot find
- **AND** the bridge SHALL exit non-zero with a clear stderr message instructing the user to export the variables

#### Scenario: The bearer is never in the argument vector

- **WHEN** the spawned process's `/proc/<pid>/cmdline` is inspected during a Codex session
- **THEN** the token's value SHALL NOT appear
- **AND** `args` SHALL contain only `-y` and the pinned package specifier

#### Scenario: Claude Code MCP config remains a separate file

- **WHEN** the Claude Code plugin loads
- **THEN** it SHALL continue to load `apps/plugin/.claude-plugin/mcp.json`
- **AND** Claude Code's keychain-driven `${user_config.*}` substitution into the `env` map SHALL remain the canonical credential path under Claude Code
- **AND** the two manifests SHALL agree on the pinned bridge version, both being carriers of the same plugin version

#### Scenario: Codex versions under the unified plugin track

- **WHEN** a contributor merges a commit modifying any file under `apps/plugin/` (a shared asset OR `apps/plugin/.codex-plugin/`)
- **THEN** release-please SHALL bump the single unified `plugin` component (tag `plugin-vX.Y.Z`), updating `apps/plugin/.codex-plugin/package.json::version` and `apps/plugin/.codex-plugin/plugin.json::version` (via the `plugin` component's `extra-files`) to the same version as every other client
