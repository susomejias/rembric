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
- **AND** the cached directory SHALL contain `.codex-plugin/plugin.json`, `.codex-plugin/mcp.json`, `bin/rembric-bridge.mjs`, `bin/rembric-dotenv.mjs`, `hooks/hooks.codex.json`, and the relevant `scripts/` files

### Requirement: Codex hooks MUST receive `session_id` from stdin in the same JSON shape as Claude Code

The shared scripts `session-start.sh`, `pre-compact.sh`, and `stop-sync.sh` SHALL read the hook stdin as a JSON object containing a `session_id` field (and `cwd` when relevant). Claude Code and Codex CLI both pass the host-session id in stdin JSON for `command`-type hooks.

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

### Requirement: Codex-specific MCP server configuration

The Codex plugin SHALL ship its own MCP server configuration file at `apps/plugin/.codex-plugin/mcp.json`, sibling to the Claude Code plugin's `apps/plugin/.claude-plugin/mcp.json`. The two files diverge in path resolution and env injection mechanism because Codex and Claude Code expose different MCP loader contracts (Codex does not substitute `${CLAUDE_PLUGIN_ROOT}` in `args`, and `Command::env_clear()` strips parent-env inheritance — see `codex-rs/core-plugins/src/loader.rs::normalize_plugin_mcp_server_value` and `codex-rs/rmcp-client/src/stdio_server_launcher.rs::launch_server`). The Codex-specific `env_vars` list also forwards the user's shell `PWD` so the bridge can resolve the user's project directory (Codex's spawn semantics put `process.cwd()` at the plugin cache dir, which is not the project).

#### Scenario: Codex MCP config file declares stdio bridge with plugin-root anchoring

- **WHEN** `apps/plugin/.codex-plugin/mcp.json` is loaded
- **THEN** the top-level object contains exactly one entry `mcpServers.rembric`
- **AND** the entry declares `command: "node"`
- **AND** the entry declares `args: ["./bin/rembric-bridge.mjs"]` — a relative path under the plugin root
- **AND** the entry declares `cwd: "."` so Codex's `normalize_plugin_mcp_server_value` resolves the working directory to the plugin root (`plugin_root.join(".") = plugin_root`)
- **AND** the entry declares `env_vars: ["REMBRIC_SERVER_URL", "REMBRIC_API_TOKEN", "PWD"]`
- **AND** the entry SHALL NOT declare an `env` field — Codex would treat any literal map values as opaque overrides that clobber `env_vars` reads

#### Scenario: Bridge resolves under Codex via plugin-root cwd

- **WHEN** Codex spawns the bridge per `apps/plugin/.codex-plugin/mcp.json`
- **THEN** `LocalStdioServerLauncher::launch_server` SHALL set `current_dir` on the spawned `Command` to the plugin root (resolved from `cwd: "."`)
- **AND** node SHALL receive `./bin/rembric-bridge.mjs` as its script argument and resolve it relative to the cwd → `plugin_root/bin/rembric-bridge.mjs`
- **AND** the bridge SHALL start without `Cannot find module` errors

#### Scenario: env*vars forwards REMBRIC*\* from the launching shell to the bridge

- **WHEN** Codex spawns the bridge per `apps/plugin/.codex-plugin/mcp.json`
- **THEN** `create_env_for_mcp_server` SHALL read `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` from Codex's own process env
- **AND** the curated env passed to the bridge subprocess SHALL contain those names with the user-supplied values
- **AND** the bridge SHALL build a real URL — e.g. `http://192.0.2.10:8787/mcp/<slug>` — not a placeholder literal

#### Scenario: env_vars forwards PWD so the bridge can resolve the user's project directory

- **WHEN** Codex spawns the bridge per `apps/plugin/.codex-plugin/mcp.json` AND the shell that launched `codex` has `PWD` set
- **THEN** `create_env_for_mcp_server` SHALL read `PWD` from Codex's own process env
- **AND** the curated env passed to the bridge subprocess SHALL contain `PWD` with the shell's working directory
- **AND** the bridge's project-directory resolution SHALL pick `PWD` as the `projectDir`
- **AND** path-scoping via `${projectDir}/.rembric` SHALL function correctly when the user has launched `codex` from their project root

#### Scenario: Bridge surfaces a useful error when env vars are missing

- **WHEN** the user launches `codex` without exporting `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN`
- **THEN** Codex's `env_vars` mechanism silently skips names it cannot find
- **AND** the bridge SHALL exit non-zero with a clear stderr message instructing the user to export the variables

#### Scenario: Claude Code MCP config is unaffected

- **WHEN** the Claude Code plugin loads
- **THEN** it SHALL continue to load `apps/plugin/.claude-plugin/mcp.json` (unchanged behaviour)
- **AND** Claude Code's `${CLAUDE_PLUGIN_ROOT}` substitution in args SHALL keep working
- **AND** Claude Code's keychain-driven `${user_config.*}` substitution into the `env` map SHALL remain the canonical credential path under Claude Code

#### Scenario: Codex versions under the unified plugin track

- **WHEN** a contributor merges a commit modifying any file under `apps/plugin/` (a shared asset OR `apps/plugin/.codex-plugin/`)
- **THEN** release-please SHALL bump the single unified `plugin` component (tag `plugin-vX.Y.Z`), updating `apps/plugin/.codex-plugin/package.json::version` and `apps/plugin/.codex-plugin/plugin.json::version` (via the `plugin` component's `extra-files`) to the same version as every other client
- **AND** there SHALL be no separate `codex-plugin` component, no `codex-plugin-v*` tag, and no `node-workspace` cascade
- **AND** the server image SHALL NOT be rebuilt

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

### Requirement: The Codex post-compaction block MUST share the English protocol text

Codex CLI and Claude Code invoke the same post-compaction script, so the language defect and its fix apply to both clients simultaneously. The Codex hook manifest SHALL continue to invoke the shared script, and the English protocol text SHALL be asserted once in the shared fixtures rather than duplicated per client — a per-client copy is a sync bug by the plugin-tree discipline.

#### Scenario: Codex emits the same English block

- **WHEN** the Codex post-compaction hook fires
- **THEN** the emitted protocol block SHALL be byte-identical to the block emitted for Claude Code

#### Scenario: No per-client copy of the text exists

- **WHEN** the plugin tree is inspected for the post-compaction protocol text
- **THEN** exactly one copy SHALL exist outside the test fixtures

### Requirement: Codex hook configuration and its `SessionEnd` budget

The repository SHALL host Codex hook configuration at `apps/plugin/hooks/hooks.codex.json`, sibling to the Claude Code plugin's `apps/plugin/hooks/hooks.json`, declaring the Codex-supported events the plugin wires: **six event types across nine handler entries**.

Codex's hook surface differs from Claude Code's in ways the platform forces, and has evolved since this requirement was first written:

- **Codex DOES have a `SessionEnd` event, and this capability previously asserted it did not.** Per `learn.chatgpt.com/docs/hooks`, it "runs for the main thread when you archive or delete a conversation that's still open, when Codex closes normally, or after a conversation has been idle and isn't open in any connected client for 30 minutes. It won't run for subagents." Its stdin carries `session_id`, `transcript_path`, `cwd`, `hook_event_name` and `reason`; `matcher` filters `reason`, whose only current value is `other`, so the entry SHALL declare no matcher. Its output is advisory — "Their output won't steer Codex or keep the thread open" — so the handler SHALL emit nothing to stdout, matching Claude Code's `SessionEnd`.
- **`SessionEnd` carries the tightest time budget of any hook on either host, and it is not the 600-second default.** Verbatim: "If `timeout` is omitted, Codex uses 600 seconds for most hooks. `SessionEnd` uses `1` second by default and supports up to `3` seconds." The plugin's shared curl helper allows a POST 3 seconds (`claude-code-plugin`, `rembric_post`), so an undeclared timeout kills the handler before its request can complete, and a declared `"timeout": 3` with an unchanged POST budget leaves nothing for reading the transcript or emitting the failure diagnostic. The entry SHALL therefore declare `"timeout": 3` — the documented maximum — AND cap its own POST at 2 seconds through the helper's budget override. Neither half is optional: the timeout alone still lets one slow request consume the whole budget, and the override alone still leaves the handler dead at one second.
- Codex DOES support `PreCompact` and `PostCompact` events as of current `codex-cli` releases; the plugin wires both. `apps/plugin/scripts/pre-compact.sh` exists and is invoked from `hooks.codex.json`'s `PreCompact` entry — any statement that it should be removed for lack of a Codex event is false.
- Codex's `SessionStart` stdin carries a `source` field and the dispatcher matches `SessionStart` matchers against it, so a `matcher: "compact"` group behaves the same way it does for Claude Code. Both matcher groups are declared **explicitly**: `startup|resume|clear` and `compact`. Neither is a default/unmatched group. Codex's documented `source` values are exactly `startup`, `resume`, `clear` and `compact`; there is no `fork` source as there is on Claude Code, so the Codex manifest SHALL NOT declare one and the divergence from `hooks.json` is the hosts', not a plugin inconsistency.
- Codex's dispatcher does NOT filter `UserPromptSubmit` by matcher; the hook fires on every prompt regardless. The manifest therefore declares NO matcher on either `UserPromptSubmit` entry, and each script self-filters internally. Declaring an advisory matcher was previously required by this capability and is now prohibited: an advisory matcher that the dispatcher ignores misleads every reader about where the filtering lives, and Claude Code's registration was deliberately made matcher-less too, so first-prompt detection sees every prompt on both clients.
- Codex's `Stop` hook REQUIRES JSON on stdout: "Stop expects JSON on stdout when it exits 0. Plain text output is invalid for this event." Per official docs.

`apps/plugin/scripts/session-end.sh` SHALL take an optional agent-name argument selecting the per-client transcript parser, exactly as `pre-compact.sh <agent>` already does (`claude-code` default, `codex-cli` selecting the `*_codex_cli` helpers). There SHALL be no `session-end.codex.sh`. Both manifests SHALL pass the argument explicitly, so `hooks.json`'s invocation becomes `session-end.sh claude-code` rather than the bare form.

`abandonStale` remains the net for every Codex close where `SessionEnd` does not fire — subagent threads, a SIGKILL, or a handler killed by its 1–3 second budget before its POST landed. The steady state it covers is narrower than this capability previously claimed, not gone.

The authoritative table of which hook POSTs what for both clients is `plugin-session-protocol`'s lifecycle mapping, which also carries the cross-client rule that every ensure of a session id is followed once per process by `POST /api/<slug>/sessions/<id>/resume`.

#### Scenario: Hook event coverage

- **WHEN** `apps/plugin/hooks/hooks.codex.json` is loaded
- **THEN** the `hooks` object SHALL declare exactly these six event types and no others: `SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`, `SessionEnd`
- **AND** those six SHALL carry exactly nine handler entries in total
- **AND** `SessionStart` SHALL declare exactly two matcher groups, with the literal matchers `startup|resume|clear` and `compact`
- **AND** `UserPromptSubmit` SHALL declare exactly two entries, invoking `prompt-search.sh` and `prompt-nudge.sh`, and NEITHER SHALL carry a `matcher` key
- **AND** the `hooks` object SHALL NOT contain `PostToolUse`
- **AND** every hook entry SHALL be `type: "command"` — Codex does not support `type: "mcp_tool"` for hooks
- **AND** the `startup|resume|clear` `SessionStart` group SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-start.sh codex-cli` (reused from the Claude Code plugin; the `agent` arg differs)
- **AND** the `SessionStart` `"compact"` matcher group SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compact.sh codex-cli` (the same script Claude Code's `SessionStart(compact)` hook uses)
- **AND** the `PreCompact` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/pre-compact.sh codex-cli`
- **AND** the `PostCompact` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/post-compaction.sh`
- **AND** the `SessionEnd` hook SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/session-end.sh codex-cli`

#### Scenario: The four assertions that codified the false claim are retired and replaced

- **WHEN** `apps/plugin/test/hook-manifests.test.ts` is read at HEAD
- **THEN** `expect(codexHooks.SessionEnd).toBeUndefined()` SHALL be gone, replaced by an assertion that the entry exists, declares `"timeout": 3` and carries no `matcher` key
- **AND** the event-type set assertion SHALL name six events including `SessionEnd`, not five
- **AND** the handler-count assertion SHALL be `9`, not `8`
- **AND** the ordered invocation list for `hooks.codex.json` SHALL include `SessionEnd command scripts/session-end.sh codex-cli`, and the list for `hooks.json` SHALL read `SessionEnd command scripts/session-end.sh claude-code`
- **AND** each assertion SHALL still be an exact set or exact count, never a containment check — a `toContain` cannot catch a manifest claiming an event is absent, which is the defect class that produced this requirement

#### Scenario: The SessionEnd handler fits inside the event's budget

- **WHEN** `hooks.codex.json`'s `SessionEnd` entry is read
- **THEN** it SHALL declare `"timeout": 3`
- **AND** it SHALL set the shared helper's POST budget to a value strictly below that timeout, so a hanging server yields the failed-POST stderr diagnostic rather than a handler killed with no record
- **AND** the control SHALL pass in the same run: the entry's timeout SHALL NOT be raised above `3`, which the host does not honour for this event

#### Scenario: A normally-closed Codex session reaches `ended`

- **GIVEN** a Codex session of N turns whose `Stop` hook posted `/summary` each turn
- **WHEN** Codex closes normally and `SessionEnd` fires with a readable `transcript_path`
- **THEN** the handler SHALL POST `/api/<slug>/sessions/<id>/end` with `{summary, title, final:false}`, or `{}` when the transcript is unreadable or parses empty
- **AND** the row SHALL be `status='ended'` with `ended_at` set
- **AND** the handler SHALL emit nothing to stdout, because Codex documents `SessionEnd` output as advisory and it cannot reach the model

#### Scenario: A Codex close where SessionEnd does not fire still reaches a terminal state

- **GIVEN** a Codex session terminated by SIGKILL, or running as a subagent thread (for which the host documents that `SessionEnd` does not run)
- **WHEN** the process disappears
- **THEN** the row SHALL remain `status='active'`
- **AND** the `abandonStale` job (running per `SESSION_ABANDON_AFTER_MS`, default 24h) SHALL flip it to `status='abandoned'`
- **AND** the row's `summary` and `title` SHALL reflect the most recent `Stop`'s POST

#### Scenario: A resumed Codex conversation re-attaches its memories

- **GIVEN** a Codex session `<S>` whose row is `ended` (normal close) or `abandoned` (sweep)
- **WHEN** the operator reopens that conversation and Codex fires `SessionStart` with `source: "resume"` for the same `session_id`
- **THEN** `session-start.sh` SHALL POST the ensure and then `POST /api/<slug>/sessions/<S>/resume`
- **AND** the row SHALL be `status='active'` with `ended_at IS NULL`
- **AND** a subsequent `memory.save` on that conversation's MCP transport SHALL persist a non-null `session_id`
- **AND** the control SHALL pass in the same run: the same `memory.save` without the resume persists `session_id = NULL`

#### Scenario: Codex Stop wires to a per-turn summary writer

- **WHEN** the `Stop` hook fires (which it does once per agent turn under Codex semantics)
- **THEN** the hook's FIRST entry SHALL invoke `${CLAUDE_PLUGIN_ROOT}/scripts/stop-sync.sh codex-cli` — the same script Claude Code's `Stop` hook invokes with `claude-code` in its own first entry, diverging in exactly THREE ways selected by that agent-name argument: (1) the transcript parser (`*_codex_cli` vs `*_claude_code`), (2) the stdout contract (Codex MUST `printf '{}'`; Claude Code MUST emit nothing), and (3) the `final` field (Codex sends `"final":false` explicitly; Claude Code OMITS the key entirely). It also diverges in execution model, which the agent argument selects rather than the caller: Codex runs synchronously because it has no documented async escape hatch and must emit its JSON before exiting, while Claude Code daemonizes the body into a detached, output-redirected subshell
- **AND** the script SHALL read `session_id`, `cwd`, and `transcript_path` from stdin
- **AND** SHALL read `${cwd}/.rembric` for the slug
- **AND** SHALL read `transcript_path` if readable, format it via `_transcript.sh`, derive a title from the first non-empty assistant message (≤100 chars)
- **AND** SHALL POST `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with body `{"summary": "<formatted>", "title": "<derived>", "final": false}` — note: `/summary` NOT `/end`, because Codex `Stop` is per-turn and the session must stay `active` for the next turn to keep updating
- **AND** SHALL emit `'{}'` to stdout (Codex requires JSON on Stop stdout; plain text is invalid per docs)
- **AND** SHALL exit zero even on internal error

#### Scenario: Only one copy of stop-sync.sh exists

- **WHEN** the plugin tree is inspected
- **THEN** `apps/plugin/scripts/stop-sync.sh` SHALL exist exactly once and be referenced by both `hooks.json` and `hooks.codex.json`
- **AND** no `stop-sync.codex.sh` variant SHALL exist

#### Scenario: Only one copy of session-end.sh exists

- **WHEN** the plugin tree is inspected
- **THEN** `apps/plugin/scripts/session-end.sh` SHALL exist exactly once and be referenced by both `hooks.json` and `hooks.codex.json`
- **AND** no `session-end.codex.sh` variant SHALL exist
- **AND** the per-client transcript parser SHALL be selected by the agent-name argument, not by a second script

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
