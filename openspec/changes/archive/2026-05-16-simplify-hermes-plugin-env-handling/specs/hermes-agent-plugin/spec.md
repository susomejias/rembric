## MODIFIED Requirements

### Requirement: Plugin manifest declares lifecycle hooks

`plugin/.hermes-plugin/plugin.yaml` SHALL declare the canonical Hermes manifest fields: `name: "rembric"`, `version: "<semver>"` (kept in lock-step with `plugin/.claude-plugin/plugin.json::version` and `plugin/.codex-plugin/plugin.json::version`), `description`, `author`, `homepage`. The manifest SHALL declare a `hooks` array listing the lifecycle events the provider implements with real behavior: `[on_session_end, on_pre_compress]`. The manifest SHALL declare a `requires_env` array listing the three runtime environment variables the plugin needs, in this order and with these descriptors:

1. `name: REMBRIC_SERVER_URL`, `description: "Rembric server base URL (WITHOUT /mcp suffix). Example: https://memory.example.com — no trailing slash."`.
2. `name: REMBRIC_API_TOKEN`, `description: "Bearer token issued by 'rembric token create'."`, `secret: true`.
3. `name: REMBRIC_PROJECT_SLUG`, `description: "Default project slug. Overridden per-cwd if a .rembric file is present, or by the trailing /mcp/<slug> segment of REMBRIC_SERVER_URL."`.

Declaring `requires_env` triggers Hermes's documented install-time prompt: `hermes plugins install` asks the user for the three values, writes them to `${HERMES_HOME:-~/.hermes}/.env` via `save_env_value`, and exports them into the running process's `os.environ`. On subsequent Hermes launches the same `.env` is loaded before plugins import. Subprocesses Hermes spawns from `mcp_servers.*` (including the bundled MCP bridge) inherit the same env.

#### Scenario: Manifest declares hooks and requires_env in lock-step

- **WHEN** Hermes reads `plugin.yaml` at install time
- **THEN** it sees `hooks: [on_session_end, on_pre_compress]` and surfaces no other hook bindings
- **AND** it sees `requires_env: [REMBRIC_SERVER_URL, REMBRIC_API_TOKEN, REMBRIC_PROJECT_SLUG]` and prompts the user for any of those not already set in the parent shell env
- **AND** answered values land in `${HERMES_HOME:-~/.hermes}/.env` (Hermes's standard env file) and become available to the plugin module at import time and to all `mcp_servers.*` subprocesses Hermes spawns

### Requirement: Provider lifecycle method behavior

`RembricMemoryProvider` SHALL implement the `MemoryProvider` ABC with these behaviors:

- `name` returns `"rembric"`.
- `is_available` performs `GET ${REMBRIC_SERVER_URL}/healthz` with a 2-second timeout, returning `True` only on HTTP 200. It SHALL return `False` if `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` are unset, or if the request fails for any reason.
- `initialize(session_id, **kwargs)` SHALL:
  - Resolve the project slug via the cascade defined in "Slug resolution cascade".
  - When a valid slug is resolved, `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions` with `Authorization: Bearer ${REMBRIC_API_TOKEN}`, `Content-Type: application/json`, and body `{"id": session_id, "cwd": kwargs.get("cwd", os.getcwd()), "agent": "hermes"}`. Timeout 3 seconds. Discard response body.
  - When no slug is resolvable, skip the POST and log a single-line stderr diagnostic of the form `[rembric] no project slug for session <session_id>; skipping session POST`. The provider SHALL still register; subsequent lifecycle calls SHALL silently skip their HTTP work.
  - Cache the resolved slug and session id on the provider instance; subsequent lifecycle calls within the same session SHALL NOT re-resolve.
- `on_pre_compress(messages, **kwargs)` SHALL, if a slug and session id were cached at `initialize`, build a textual transcript from `messages` (`role: content` per line, oldest-first), truncate from the head if the result exceeds 20,000 characters (the schema cap of `sessionSummarySchema` in `src/server/api-router.ts`), and `POST /api/<slug>/sessions/<session_id>/summary` with body `{"summary": <transcript>}`. Timeout 3 seconds. Failures are silent stderr diagnostics. The provider SHALL NOT mutate the `messages` argument.
- `on_session_end(messages, **kwargs)` SHALL, if a slug and session id were cached, `POST /api/<slug>/sessions/<session_id>/end` with an empty JSON body (`{}`). Timeout 3 seconds. Failures are silent stderr diagnostics. The provider SHALL NOT call `memory.session_end` over MCP.
- `get_tool_schemas` SHALL return `[]`. The provider contributes no agent-callable tools; the MCP bridge (registered separately in `mcp_servers`) is the canonical tool surface.
- `handle_tool_call(name, args)` SHALL return `json.dumps({"error": "unknown_tool", "hint": "register the rembric MCP bridge in mcp_servers.rembric to access memory tools"})`. This method should never be invoked (because `get_tool_schemas` is empty), but is implemented defensively.
- `system_prompt_block` SHALL return `""` (empty string).
- `prefetch(query, **kwargs)` SHALL return `""`.
- `queue_prefetch(query, **kwargs)` SHALL be a no-op (return `None`).
- `sync_turn(user, assistant, **kwargs)` SHALL be a no-op.
- `on_memory_write(action, target, content, **kwargs)` SHALL be a no-op.
- `shutdown(**kwargs)` SHALL be a no-op.

The provider SHALL NOT implement `get_config_schema` or `save_config` (overriding the default no-op behavior of `MemoryProvider`). Credentials live in `~/.hermes/.env`, written by Hermes itself via the `requires_env` install flow — the plugin does not manage credential storage.

The provider SHALL NOT preload any plugin-specific dotenv file (no `~/.rembric/.env`, no `${XDG_CONFIG_HOME}/rembric/.env`). All runtime env comes from `os.environ`, which Hermes populates from `~/.hermes/.env` before the plugin module imports.

#### Scenario: Session initialize POSTs to the sessions endpoint with agent: hermes

- **WHEN** Hermes starts a session and calls `provider.initialize(session_id="01XYZ", cwd="/home/user/repo")` with a resolvable slug `myproj`
- **THEN** the provider issues `POST ${REMBRIC_SERVER_URL}/api/myproj/sessions` with `Authorization: Bearer …` and body `{"id":"01XYZ","cwd":"/home/user/repo","agent":"hermes"}`
- **AND** the response is discarded
- **AND** the provider caches `slug="myproj"` and `session_id="01XYZ"` for subsequent lifecycle calls

#### Scenario: Pre-compress posts a transcript summary

- **WHEN** `provider.on_pre_compress(messages=[...])` is called for an initialized session
- **THEN** the provider serializes messages to `role: content` lines (oldest-first), caps at 20,000 chars, and POSTs to `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with `{"summary":"<transcript>"}`
- **AND** the `messages` argument is NOT mutated by the provider

#### Scenario: Session end posts to the end endpoint

- **WHEN** Hermes ends the session and calls `provider.on_session_end(messages=[…])` for an initialized session
- **THEN** the provider issues `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/end` with empty JSON `{}`
- **AND** the response is discarded

#### Scenario: Lifecycle calls without a resolved slug skip silently

- **WHEN** `provider.initialize(session_id="01XYZ", cwd="/tmp")` runs with no resolvable slug from any cascade source
- **THEN** the provider writes a single stderr diagnostic `[rembric] no project slug for session 01XYZ; skipping session POST`
- **AND** no HTTP request is issued
- **AND** subsequent calls to `on_pre_compress` and `on_session_end` skip silently without diagnostic spam

#### Scenario: Memory-touching lifecycle methods are no-ops

- **WHEN** Hermes calls `provider.system_prompt_block()`, `provider.prefetch(query="x")`, `provider.queue_prefetch(query="x")`, `provider.sync_turn(user="…", assistant="…")`, or `provider.on_memory_write(action="add", target="MEMORY.md", content="…")`
- **THEN** no HTTP request is issued
- **AND** the methods return `""` (`system_prompt_block`, `prefetch`) or `None` (the rest)

#### Scenario: handle_tool_call returns a defensive error

- **WHEN** for any reason `provider.handle_tool_call(name="memory_save", args={})` is invoked
- **THEN** the provider returns the JSON string `{"error":"unknown_tool","hint":"register the rembric MCP bridge in mcp_servers.rembric to access memory tools"}`

#### Scenario: Provider does not manage credential storage

- **WHEN** Hermes inspects the provider's published surface
- **THEN** the provider does NOT override `get_config_schema` (default returns `[]`) and does NOT override `save_config` (default no-op)
- **AND** no `~/.hermes/rembric.json` file is created by the provider

### Requirement: Slug resolution cascade

The provider SHALL resolve the project slug in `initialize` using this strict precedence chain. The chain SHALL stop at the first source that yields a slug that matches the regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` (identical to the bridge's regex in `plugin/bin/rembric-bridge.mjs`):

1. `REMBRIC_PROJECT_SLUG` environment variable (populated by Hermes from `~/.hermes/.env` via the `requires_env` install flow, or set directly in the parent shell).
2. The `PROJECT_SLUG` value parsed from `<kwargs.cwd>/.rembric`, using the same dotenv-style parser as the bridge: trim whitespace, skip blank lines and lines starting with `#`, accept `KEY=VALUE`, and strip matched outer single or double quotes from the value.
3. The final path segment of `urlparse(REMBRIC_SERVER_URL).path` if the path matches `/mcp/<slug>`.
4. `None` — degraded mode, all session-related POSTs are skipped silently.

The resolved slug SHALL be validated against the slug regex; non-matching candidates SHALL be discarded and the cascade continues to the next source. The provider SHALL NOT walk parent directories looking for `.rembric` — only the literal `cwd` is checked.

#### Scenario: Env wins over .rembric file

- **WHEN** `REMBRIC_PROJECT_SLUG=alpha` is set and `<cwd>/.rembric` contains `PROJECT_SLUG=gamma`
- **THEN** the provider resolves the slug as `alpha`

#### Scenario: .rembric file wins over URL parse

- **WHEN** env is unset, `<cwd>/.rembric` contains `PROJECT_SLUG=gamma`, and `REMBRIC_SERVER_URL=https://memory.example.com/mcp/delta`
- **THEN** the provider resolves the slug as `gamma`

#### Scenario: URL parse is the final source

- **WHEN** env and `<cwd>/.rembric` are absent, and `REMBRIC_SERVER_URL=https://memory.example.com/mcp/delta`
- **THEN** the provider resolves the slug as `delta`

#### Scenario: Invalid candidate is skipped

- **WHEN** `REMBRIC_PROJECT_SLUG=Has_Underscores` (does not match the slug regex) and `<cwd>/.rembric` has `PROJECT_SLUG=gamma`
- **THEN** the provider rejects the env value and resolves the slug as `gamma`

#### Scenario: All sources empty yields None

- **WHEN** no source produces a valid slug
- **THEN** the provider's resolved slug is `None`
- **AND** all session-related POSTs in subsequent lifecycle calls are skipped silently

### Requirement: User documentation

The plugin's `README.md` SHALL include, in this order:

1. A one-line install command using `curl -fsSL ... | sh`, followed by `hermes plugins install rembric` (or equivalent) to trigger the `requires_env` prompts.
2. A description of what Hermes prompts for during install (the three `requires_env` vars) and where the answers are persisted (`${HERMES_HOME:-~/.hermes}/.env`).
3. A two-block `~/.hermes/config.yaml` example showing **both** the `mcp_servers.rembric` block (registering the bundled bridge via `node` or `npx`) AND the `memory: provider: rembric` block, so users wire both the tool surface and the lifecycle in one go.
4. A short "Project slug resolution" section explaining the four-step cascade in plain prose.
5. A "Troubleshooting" section that covers: provider visible in `hermes memory status` but server unhealthy, missing slug diagnostic, mismatched provider-vs-bridge slug, `~/.hermes/.env` edited manually after install.

The README SHALL NOT mention `~/.rembric/.env`, `${XDG_CONFIG_HOME}/rembric/.env`, `get_config_schema`, `save_config`, or `~/.hermes/rembric.json`. Those mechanisms were removed; documenting them would mislead users into setting up files the plugin ignores.

The repository's root `README.md` SHALL be updated to list Hermes Agent under "Supported clients" alongside Claude Code and Codex CLI, with a link to the plugin README.

`docs/agents.md` SHALL gain a new "Hermes Agent" section mirroring the structure of the existing Claude Code and Codex CLI sections, covering install (including the `requires_env` prompt flow), config, env vars, slug resolution, and a pointer to the plugin README.

`plugin/README.md` and `plugin/CHANGELOG.md` SHALL be updated to include Hermes alongside Claude/Codex.

#### Scenario: README pairs provider and bridge in the config example

- **WHEN** a user reads `plugin/.hermes-plugin/README.md` end-to-end
- **THEN** the first config block they see registers BOTH the `mcp_servers.rembric` entry (bridge) AND the `memory.provider: rembric` entry (provider) in the same `~/.hermes/config.yaml` snippet
- **AND** the prose preceding the block explicitly notes that lifecycle (provider) and tool access (bridge) are complementary, not redundant
- **AND** the README contains no reference to `~/.rembric/.env` or `get_config_schema`

## REMOVED Requirements

### Requirement: Provider config schema

**Reason**: The `get_config_schema()` + `save_config()` mechanism was the wrong abstraction for Rembric's credentials. Those three env vars need to reach both the in-process provider AND the bridge subprocess Hermes spawns from `mcp_servers.rembric`. Hermes's `requires_env:` manifest field handles both consumers via `~/.hermes/.env`; the plugin's `get_config_schema()` only reached the in-process side. With `requires_env:` declared, the provider no longer needs to manage credential storage at all.

**Migration**: not externally exposed (0.3.x not in production use). `~/.hermes/rembric.json` is no longer read; safe to delete.

### Requirement: Configuration preload from `~/.rembric/.env`

**Reason**: The custom dotenv preload was a workaround for the absence of `requires_env:` in the manifest. With `requires_env:` declared, Hermes loads `~/.hermes/.env` into `os.environ` before plugins import — the same vars are available to the provider directly with no preload helper. The `~/.rembric/.env` file is now obsolete and silently ignored.

**Migration**: not externally exposed (0.3.x not in production use). `~/.rembric/.env` is no longer read; safe to delete.
