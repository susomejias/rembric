# hermes-agent-plugin Specification

## Purpose

TBD - created by archiving change add-hermes-agent-plugin. Update Purpose after archive.

## Requirements

### Requirement: Plugin source location

The plugin SHALL live in this monorepo at `apps/plugin/.hermes-plugin/`, sibling to `apps/plugin/.claude-plugin/` and `apps/plugin/.codex-plugin/`. The directory SHALL contain exactly four files: `plugin.yaml`, `__init__.py`, `install.sh`, `README.md`. No subdirectories.

#### Scenario: Plugin tree contains the four files

- **WHEN** the repository is at HEAD
- **THEN** `ls apps/plugin/.hermes-plugin/` lists `plugin.yaml`, `__init__.py`, `install.sh`, and `README.md`
- **AND** there are no nested directories under `apps/plugin/.hermes-plugin/`

### Requirement: Plugin manifest declares lifecycle hooks

`apps/plugin/.hermes-plugin/plugin.yaml` SHALL declare the canonical Hermes manifest fields: `name: "rembric"`, `version: "<semver>"` (managed by release-please as an independent component — bumps independently of `claude-code` / `codex`), `description`, `author`, `homepage`. The manifest SHALL declare a `hooks` array listing the lifecycle events the provider implements with real behavior: `[on_session_end, on_pre_compress, on_session_switch]`. The manifest SHALL declare a `requires_env` array listing the three runtime environment variables the plugin needs, in this order and with these descriptors:

1. `name: REMBRIC_SERVER_URL`, `description: "Rembric server base URL (WITHOUT /mcp suffix). Example: https://memory.example.com — no trailing slash."`.
2. `name: REMBRIC_API_TOKEN`, `description: "Bearer token issued by 'rembric token create'."`, `secret: true`.
3. `name: REMBRIC_PROJECT_SLUG`, `description: "Default project slug. Overridden per-cwd if a .rembric file is present, or by the trailing /mcp/<slug> segment of REMBRIC_SERVER_URL."`.

Declaring `requires_env` triggers Hermes's documented install-time prompt: `hermes plugins install` asks the user for the three values, writes them to `${HERMES_HOME:-~/.hermes}/.env` via `save_env_value`, and exports them into the running process's `os.environ`. On subsequent Hermes launches the same `.env` is loaded before plugins import. Subprocesses Hermes spawns from `mcp_servers.*` (including the bundled MCP bridge) inherit the same env.

The `hooks` array SHALL include `on_session_switch` (new addition) because the provider now overrides that method to rotate session ids on compression. Without listing it, Hermes does NOT call the override (the `hooks` array gates lifecycle method invocation).

#### Scenario: Manifest declares hooks and requires_env in lock-step

- **WHEN** Hermes reads `plugin.yaml` at install time
- **THEN** it sees `hooks: [on_session_end, on_pre_compress, on_session_switch]` and surfaces no other hook bindings
- **AND** it sees `requires_env: [REMBRIC_SERVER_URL, REMBRIC_API_TOKEN, REMBRIC_PROJECT_SLUG]` and prompts the user for any of those not already set in the parent shell env
- **AND** answered values land in `${HERMES_HOME:-~/.hermes}/.env` (Hermes's standard env file) and become available to the plugin module at import time and to all `mcp_servers.*` subprocesses Hermes spawns

### Requirement: Provider class implements the MemoryProvider ABC

`apps/plugin/.hermes-plugin/__init__.py` SHALL define a class `RembricMemoryProvider` extending `agent.memory_provider.MemoryProvider`. The file SHALL guard the import with `try: from agent.memory_provider import MemoryProvider / except ImportError:` falling back to a local stub ABC defining the same method names, so the file is importable for tests and linting without Hermes installed.

The file SHALL expose a module-level `register(ctx)` function that calls `ctx.register_memory_provider(RembricMemoryProvider())`. No other registrations.

#### Scenario: Plugin loads under Hermes

- **WHEN** Hermes loads the plugin from `~/.hermes/plugins/rembric/`
- **THEN** `register(ctx)` runs and registers the provider via `ctx.register_memory_provider`
- **AND** no other registration (tools, hooks, skills, commands, CLI subcommands) occurs

#### Scenario: Plugin file is importable without Hermes

- **WHEN** the file is imported in a Python environment that lacks the `agent.memory_provider` module
- **THEN** the `try/except ImportError` branch defines a local stub ABC and the import succeeds
- **AND** the file's classes and helper functions can be unit-tested

### Requirement: Provider lifecycle method behavior

`RembricMemoryProvider` SHALL implement the `MemoryProvider` ABC with these behaviors:

- `name` returns `"rembric"`.
- `is_available` performs `GET ${REMBRIC_SERVER_URL}/healthz` with `Authorization: Bearer ${REMBRIC_API_TOKEN}` and a 2-second timeout, returning `True` only on HTTP 200. It SHALL return `False` if `REMBRIC_SERVER_URL` or `REMBRIC_API_TOKEN` are unset, or if the request fails for any reason (including HTTP 401 when the token is invalid and HTTP 503 when the server's database is unavailable).
- `initialize(session_id, **kwargs)` SHALL:
  - Resolve the project slug via the cascade defined in "Slug resolution cascade".
  - When a valid slug is resolved, `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions` with `Authorization: Bearer ${REMBRIC_API_TOKEN}`, `Content-Type: application/json`, and body `{"id": session_id, "cwd": kwargs.get("cwd", os.getcwd()), "agent": "hermes"}`. Timeout 3 seconds. Discard response body. The server writes the placeholder title.
  - When no slug is resolvable, skip the POST and log a single-line stderr diagnostic of the form `[rembric] no project slug for session <session_id>; skipping session POST`. The provider SHALL still register; subsequent lifecycle calls SHALL silently skip their HTTP work.
  - Cache the resolved slug, session id, and cwd on the provider instance; subsequent lifecycle calls within the same session SHALL NOT re-resolve.
- `on_pre_compress(messages, **kwargs)` SHALL, if a slug and session id were cached at `initialize`, build a textual transcript from `messages` via `_format_transcript(messages)` (oldest-first `role: content` lines, truncated from the head if the result exceeds 19,500 characters), and `POST /api/<slug>/sessions/<session_id>/summary` with body `{"summary": <transcript>, "final": false}`. The provider SHALL NOT include `title` in this POST — title derivation is reserved for `on_session_end` and the server-side placeholder. Timeout 3 seconds. Failures are silent stderr diagnostics. The provider SHALL NOT mutate the `messages` argument. The provider's return value SHALL be `""` (empty string — the docstring promises it goes into the compressor prompt; we contribute nothing yet).
- `on_session_end(messages, **kwargs)` SHALL, if a slug and session id were cached, build a transcript via `_format_transcript(messages)`, derive a title from the first non-empty assistant message in `messages` (truncated to 100 chars; falling back to empty string if no assistant message exists), and `POST /api/<slug>/sessions/<session_id>/end` with body `{"summary": <transcript>, "title": <derived_title>, "final": false}`. When the transcript is empty (no messages), the body SHALL be `{}` (degraded end). Timeout 3 seconds. Failures are silent stderr diagnostics. The provider SHALL NOT call `memory.session_end` over MCP.
- `on_session_switch(new_session_id, *, parent_session_id="", reset=False, **kwargs)` SHALL override per the "Provider MUST override on_session_switch" requirement.
- `get_tool_schemas` SHALL return `[]`. The provider contributes no agent-callable tools.
- `handle_tool_call(name, args)` SHALL return `json.dumps({"error": "unknown_tool", "hint": "register the rembric MCP bridge in mcp_servers.rembric to access memory tools"})`.
- `system_prompt_block` SHALL return a single-paragraph block (≤300 chars) directing the agent to call `memory.session_summary({title, summary})` before declaring work done. Title ≤100 chars descriptive of what was actually worked on; summary follows Goal · Discoveries · Accomplished · Next Steps · Files. This is the Hermes-side counterpart to Claude/Codex's `initialize.instructions` nudge.
- `prefetch(query, **kwargs)` SHALL return `""`.
- `queue_prefetch(query, **kwargs)` SHALL be a no-op (return `None`).
- `sync_turn(user, assistant, **kwargs)` SHALL be a no-op.
- `on_memory_write(action, target, content, **kwargs)` SHALL be a no-op.
- `shutdown(**kwargs)` SHALL be a no-op.

The provider SHALL NOT implement `get_config_schema` or `save_config`. Credentials live in `~/.hermes/.env`. The provider SHALL NOT preload any plugin-specific dotenv file.

#### Scenario: is_available with both envs set and a healthy server returns True

- **GIVEN** `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` are set
- **AND** `GET ${REMBRIC_SERVER_URL}/healthz` with the bearer header returns `200`
- **WHEN** Hermes calls `provider.is_available()`
- **THEN** the provider SHALL return `True`

#### Scenario: is_available with a missing token returns False without making a request

- **GIVEN** `REMBRIC_SERVER_URL` is set but `REMBRIC_API_TOKEN` is unset
- **WHEN** Hermes calls `provider.is_available()`
- **THEN** the provider SHALL return `False`
- **AND** the provider SHALL NOT issue any HTTP request

#### Scenario: is_available with an invalid token returns False

- **GIVEN** `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` are set
- **AND** `GET ${REMBRIC_SERVER_URL}/healthz` with the bearer header returns `401`
- **WHEN** Hermes calls `provider.is_available()`
- **THEN** the provider SHALL return `False`

#### Scenario: is_available with the server's database unavailable returns False

- **GIVEN** `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` are set
- **AND** `GET ${REMBRIC_SERVER_URL}/healthz` with the bearer header returns `503`
- **WHEN** Hermes calls `provider.is_available()`
- **THEN** the provider SHALL return `False`

#### Scenario: Session initialize POSTs to the sessions endpoint with agent: hermes

- **WHEN** Hermes starts a session and calls `provider.initialize(session_id="01XYZ", cwd="/home/user/repo")` with a resolvable slug `myproj`
- **THEN** the provider issues `POST ${REMBRIC_SERVER_URL}/api/myproj/sessions` with `Authorization: Bearer …` and body `{"id":"01XYZ","cwd":"/home/user/repo","agent":"hermes"}`
- **AND** the response is discarded
- **AND** the provider caches `slug="myproj"`, `session_id="01XYZ"`, `cwd="/home/user/repo"` for subsequent lifecycle calls

#### Scenario: Pre-compress posts a transcript summary

- **WHEN** `provider.on_pre_compress(messages=[...])` is called for an initialized session
- **THEN** the provider serializes messages to `role: content` lines (oldest-first), caps at 19,500 chars, and POSTs to `${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/summary` with `{"summary":"<transcript>","final":false}`
- **AND** the body SHALL NOT include `title`
- **AND** the `messages` argument is NOT mutated by the provider
- **AND** the return value SHALL be `""`

#### Scenario: Session end posts to the end endpoint with summary and derived title

- **WHEN** Hermes ends the session and calls `provider.on_session_end(messages=[{role:"user",content:"hi"},{role:"assistant",content:"Fixed the auth bug; refactored login flow"}])` for an initialized session
- **THEN** the provider issues `POST ${REMBRIC_SERVER_URL}/api/<slug>/sessions/<session_id>/end` with body containing `summary` = the formatted transcript, `title` = `"Fixed the auth bug; refactored login flow"` (or truncated to 100 chars), `final: false`
- **AND** the response is discarded

#### Scenario: Session end with empty messages degrades to `{}`

- **WHEN** `provider.on_session_end(messages=[])` is called
- **THEN** the provider POSTs `/end` with body `{}` (no summary, no title)
- **AND** the server transitions the row to `ended` with summary/title unchanged

#### Scenario: Session end when model already wrote a final summary

- **GIVEN** during the session the agent called `memory.session_summary({summary, title})` via the MCP bridge (server-side `summary_final = true`)
- **WHEN** `provider.on_session_end(messages)` posts `/end {summary, title, final: false}`
- **THEN** the server transitions the row to `ended` but the `final:false` writes are skipped due to precedence
- **AND** the model's summary and title SHALL remain intact

#### Scenario: Lifecycle calls without a resolved slug skip silently

- **WHEN** `provider.initialize(session_id="01XYZ", cwd="/tmp")` runs with no resolvable slug from any cascade source
- **THEN** the provider writes a single stderr diagnostic `[rembric] no project slug for session 01XYZ; skipping session POST`
- **AND** no HTTP request is issued
- **AND** subsequent calls to `on_pre_compress`, `on_session_end`, and `on_session_switch` skip silently without diagnostic spam

#### Scenario: system_prompt_block emits the session-close protocol

- **WHEN** Hermes calls `provider.system_prompt_block()`
- **THEN** the returned string SHALL be non-empty and SHALL contain the substring `memory.session_summary`
- **AND** SHALL contain a reference to `title` and the structure `Goal · Discoveries · Accomplished · Next Steps · Files`
- **AND** SHALL be ≤300 chars

#### Scenario: handle_tool_call returns a defensive error

- **WHEN** for any reason `provider.handle_tool_call(name="memory_save", args={})` is invoked
- **THEN** the provider returns the JSON string `{"error":"unknown_tool","hint":"register the rembric MCP bridge in mcp_servers.rembric to access memory tools"}`

#### Scenario: Provider does not manage credential storage

- **WHEN** Hermes inspects the provider's published surface
- **THEN** the provider does NOT override `get_config_schema` (default returns `[]`) and does NOT override `save_config` (default no-op)
- **AND** no `~/.hermes/rembric.json` file is created by the provider

### Requirement: Slug resolution cascade

The provider SHALL resolve the project slug in `initialize` using this strict precedence chain. The chain SHALL stop at the first source that yields a slug that matches the regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` (identical to the bridge's regex in `apps/plugin/bin/rembric-bridge.mjs`):

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

### Requirement: Distribution via curl-installer

The plugin SHALL be installable through a single shell script hosted at `apps/plugin/.hermes-plugin/install.sh` in the rembric monorepo. The script SHALL:

- Default to `PLUGIN_SRC="https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin"`.
- Honour an overriding `PLUGIN_SRC` environment variable that points at any local directory (for developers with a cloned monorepo) or any other reachable URL prefix.
- Honour `HERMES_HOME` (default `${HOME}/.hermes`).
- Honour `GH_PAT`, `GH_TOKEN`, or `GITHUB_TOKEN` (in that precedence; first non-empty wins) as a GitHub Personal Access Token used for HTTPS fetches. When set, the script SHALL include `Authorization: Bearer <token>` on every internal `curl` call so the same script works against any auth-protected `raw.githubusercontent.com` URL prefix (a non-public fork, a private mirror, or a fork the user owns and keeps private) without further command-line plumbing.
- Create the target directory `${HERMES_HOME}/plugins/rembric/` if it does not exist.
- Copy or fetch exactly three files into the target directory: `plugin.yaml`, `__init__.py`, `README.md`. When `PLUGIN_SRC` resolves to a local path that contains these files, the script SHALL prefer local `cp`; otherwise the script SHALL `curl -fsSL` from the prefix.
- Exit non-zero on any unrecoverable error (target directory cannot be created; all sources for a required file fail). Print a clear `[rembric] error: <reason>` line to stderr before exiting. When a fetch fails AND no auth token was set, the stderr line SHALL include the hint `(source requires auth? set GH_PAT)` so the user gets a single useful diagnostic for the most common failure mode against non-public forks or mirrors.
- Print a one-line success message identifying the install location and the next step to stdout: `✓ rembric installed at <path>\n  enable: hermes plugins enable rembric`.

The recommended public install command in `README.md` SHALL be:

```
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh
```

The plugin's README and docs SHALL NOT recommend a `git clone + cp -r` two-step install as a parallel path. The curl-installer with `PLUGIN_SRC` covers both the casual-user and the developer-with-clone case.

#### Scenario: Default install fetches the three files via curl

- **WHEN** a user runs `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh` in a fresh shell with `HERMES_HOME` unset
- **THEN** the script creates `${HOME}/.hermes/plugins/rembric/` and writes `plugin.yaml`, `__init__.py`, `README.md` into it
- **AND** stdout includes `✓ rembric installed at` followed by the resolved path

#### Scenario: Developer install reads from local clone

- **WHEN** a developer with a clone of rembric runs `PLUGIN_SRC="$(pwd)/apps/plugin/.hermes-plugin" sh apps/plugin/.hermes-plugin/install.sh`
- **THEN** the three files in the target directory are byte-identical to the files in the local source
- **AND** no network request is issued by the script

#### Scenario: Missing remote file fails loudly

- **WHEN** the script runs with the default `PLUGIN_SRC` and the upstream `plugin.yaml` returns HTTP 404
- **THEN** the script writes `[rembric] error:` to stderr and exits with a non-zero status
- **AND** the target directory may exist but does not contain a half-written `plugin.yaml`

#### Scenario: GH_PAT is forwarded to every internal fetch

- **WHEN** the user runs `export GH_PAT=ghp_xxx; curl -fsSL -H "Authorization: Bearer $GH_PAT" .../install.sh | sh` against an auth-protected `raw.githubusercontent.com` URL prefix
- **THEN** the piped `sh` subprocess inherits `GH_PAT` from the parent shell
- **AND** the script's three internal `curl` calls each include `Authorization: Bearer ghp_xxx`
- **AND** the install succeeds without further user intervention

#### Scenario: Anonymous fetch against an auth-protected source hints at GH_PAT

- **WHEN** the script runs with a `PLUGIN_SRC` pointing at an auth-protected source, no `GH_PAT`/`GH_TOKEN`/`GITHUB_TOKEN` is set, and the upstream `plugin.yaml` returns HTTP 404 (auth-required source masked as not-found)
- **THEN** the stderr line includes the substring `(source requires auth? set GH_PAT)`
- **AND** the script exits non-zero

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

`apps/plugin/README.md` and `apps/plugin/CHANGELOG.md` SHALL be updated to include Hermes alongside Claude/Codex.

#### Scenario: README pairs provider and bridge in the config example

- **WHEN** a user reads `apps/plugin/.hermes-plugin/README.md` end-to-end
- **THEN** the first config block they see registers BOTH the `mcp_servers.rembric` entry (bridge) AND the `memory.provider: rembric` entry (provider) in the same `~/.hermes/config.yaml` snippet
- **AND** the prose preceding the block explicitly notes that lifecycle (provider) and tool access (bridge) are complementary, not redundant
- **AND** the README contains no reference to `~/.rembric/.env` or `get_config_schema`

### Requirement: Versioning managed by release-please as an independent component

The `version` field in `apps/plugin/.hermes-plugin/plugin.yaml` SHALL be managed by release-please as an independent component (NOT joined to the `bridge-bundlers` linked-versions group that covers `claude-code` and `codex`). Hermes bumps independently because its `install.sh` re-fetches plugin assets from `main` at install time — shared changes to `apps/plugin/bin/` or `apps/plugin/scripts/` propagate to Hermes installs without requiring a coordinated version bump on the Hermes manifest. Operators do NOT hand-edit the version; Conventional Commits drive the bump via release-please.

#### Scenario: Hermes manifest bumps via release-please on a Hermes-scoped change

- **WHEN** a Conventional Commit scoped to `hermes` (e.g. `feat(hermes): ...`) lands on `main`
- **THEN** release-please opens (or updates) a release PR that bumps only the `version` field in `apps/plugin/.hermes-plugin/plugin.yaml` and the manifest entry for the `hermes` component — `claude-code` and `codex` are untouched
- **AND** the matching Hermes-component changelog entry is generated by release-please from the commit subject

### Requirement: No modification to existing plugin assets

This change SHALL NOT modify any of:

- `apps/plugin/bin/rembric-bridge.mjs`
- `apps/plugin/scripts/_api.sh`, `apps/plugin/scripts/session-start.sh`, `apps/plugin/scripts/session-stop.sh`, `apps/plugin/scripts/pre-compact.sh`, `apps/plugin/scripts/prompt-search.sh`
- `apps/plugin/hooks/hooks.json`, `apps/plugin/hooks/hooks.codex.json`
- `apps/plugin/.claude-plugin/mcp.json`, `apps/plugin/.codex-plugin/mcp.json`
- `apps/server/src/server/api-router.ts` (endpoints, schemas, auth)
- DB schema or migrations
- Existing capability specs in `openspec/specs/` other than the documentation-only edit to `CLAUDE.md` invariant wording (which is project guidance, not a spec).

The Hermes plugin consumes the **existing** HTTP session endpoints in `apps/server/src/server/api-router.ts` and the **existing** bridge entry point. No new server-side runtime dependencies are introduced.

#### Scenario: Bridge and bash scripts are byte-identical post-change

- **WHEN** the change is applied
- **THEN** `git diff` against `apps/plugin/bin/rembric-bridge.mjs` and every file under `apps/plugin/scripts/`, `apps/plugin/hooks/`, `apps/plugin/.claude-plugin/`, `apps/plugin/.codex-plugin/` shows no modifications

### Requirement: Provider MUST override `on_session_switch` to rotate session ids cleanly

`RembricMemoryProvider` SHALL override `on_session_switch(new_session_id: str, *, parent_session_id: str = "", reset: bool = False, **kwargs)`. Hermes fires this method on context compression, `/resume`, `/branch`, `/reset`, and `/new` — every path that reassigns `AIAgent.session_id` without tearing the provider down. Without overriding, our `self._session_id` becomes stale and all subsequent lifecycle posts target the wrong row.

Behaviour:

1. If `parent_session_id` matches the provider's cached `self._session_id` AND that cached session is registered with a resolved slug: `POST /api/<slug>/sessions/<parent_session_id>/end` with body `{}` to close the old row. Empty body — no summary write here, because `on_pre_compress` already wrote one when the compression happened (compression is the canonical trigger for this case).
2. Update `self._session_id = new_session_id`.
3. `POST /api/<slug>/sessions` with body `{"id": new_session_id, "cwd": <cached cwd or os.getcwd()>, "agent": "hermes"}` to register the new row. The server writes the placeholder title.
4. If `parent_session_id` is empty or does not match the cached id, only step 2 and 3 SHALL run (no old-session close). The branch covers `/reset` / `/new` where there's no continuation lineage to close.

All four steps SHALL silently swallow HTTP errors (single-line stderr diagnostic) — provider failure SHALL NOT crash the host Hermes process.

#### Scenario: Context compression rotates session id

- **GIVEN** the provider is initialized with `self._session_id = "01OLD"` and slug `"foo"`
- **WHEN** Hermes calls `on_session_switch(new_session_id="01NEW", parent_session_id="01OLD", reset=False)` mid-process
- **THEN** the provider SHALL POST `/api/foo/sessions/01OLD/end` with `{}`
- **AND** SHALL update `self._session_id = "01NEW"`
- **AND** SHALL POST `/api/foo/sessions` with `{"id":"01NEW","cwd":<cached>,"agent":"hermes"}`

#### Scenario: /reset switches with no parent lineage

- **GIVEN** the provider initialized with `self._session_id = "01OLD"`
- **WHEN** Hermes calls `on_session_switch(new_session_id="01NEW", reset=True)` with empty `parent_session_id`
- **THEN** the provider SHALL NOT POST `/end` for the old id
- **AND** SHALL update `self._session_id = "01NEW"`
- **AND** SHALL POST `/api/<slug>/sessions` with the new id

#### Scenario: Switch when slug never resolved is a no-op

- **GIVEN** `initialize` ran with no resolvable slug (provider in degraded mode)
- **WHEN** Hermes calls `on_session_switch` for any reason
- **THEN** the provider SHALL only update `self._session_id` (no HTTP calls)
