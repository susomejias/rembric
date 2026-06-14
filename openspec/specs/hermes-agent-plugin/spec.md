# hermes-agent-plugin Specification

## Purpose

TBD - created by archiving change add-hermes-agent-plugin. Update Purpose after archive.

## Requirements

### Requirement: Plugin source location

The plugin SHALL live in this monorepo at `apps/plugin/.hermes-plugin/`, sibling to `apps/plugin/.claude-plugin/`, `apps/plugin/.codex-plugin/`, and `apps/plugin/.opencode-plugin/`. The directory SHALL contain exactly five files at the top level: `plugin.yaml`, `__init__.py`, `install.sh`, `uninstall.sh`, `README.md`. A nested `apps/plugin/.hermes-plugin/tests/` directory MAY exist for Python unittest sources and SHALL NOT ship to end users (the `install.sh` whitelist of three shipped files — `plugin.yaml`, `__init__.py`, `README.md` — is what guarantees this; nothing else under `apps/plugin/.hermes-plugin/` is copied). `uninstall.sh` is a local-execution maintenance script and, like `install.sh`, is NOT itself copied into the user's plugin directory.

#### Scenario: Plugin tree contains the five top-level files

- **WHEN** the repository is at HEAD
- **THEN** `ls apps/plugin/.hermes-plugin/` lists `plugin.yaml`, `__init__.py`, `install.sh`, `uninstall.sh`, `README.md`, and the `tests/` directory
- **AND** the only nested directory permitted under `apps/plugin/.hermes-plugin/` is `tests/`, and its contents SHALL NOT be referenced by `install.sh` or `uninstall.sh`

### Requirement: Plugin manifest declares lifecycle hooks

`apps/plugin/.hermes-plugin/plugin.yaml` SHALL declare the canonical Hermes manifest fields: `name: "rembric"`, `version: "<semver>"` (managed by release-please's `hermes-plugin` component via the `extra-files` updater — NOT in lock-step with other plugin manifests anymore), `description`, `author`, `homepage`. The manifest SHALL declare a `hooks` array listing the lifecycle events the provider implements with real behavior: `[on_session_end, on_pre_compress, on_session_switch]`. The manifest SHALL declare a `requires_env` array listing the three runtime environment variables the plugin needs, in this order and with these descriptors:

1. `name: REMBRIC_SERVER_URL`, `description: "Rembric server base URL (WITHOUT /mcp suffix). Example: https://memory.example.com — no trailing slash."`.
2. `name: REMBRIC_API_TOKEN`, `description: "Bearer token issued from the Rembric dashboard at /dashboard/tokens."`, `secret: true`.
3. `name: REMBRIC_PROJECT_SLUG`, `description: "Default project slug. Overridden per-cwd if a .rembric file is present, or by the trailing /mcp/<slug> segment of REMBRIC_SERVER_URL."`.

Declaring `requires_env` triggers Hermes's documented install-time prompt: `hermes plugins install` asks the user for the three values, writes them to `${HERMES_HOME:-~/.hermes}/.env` via `save_env_value`, and exports them into the running process's `os.environ`. On subsequent Hermes launches the same `.env` is loaded before plugins import. Subprocesses Hermes spawns from `mcp_servers.*` (including the bundled MCP bridge) inherit the same env.

The `hooks` array SHALL include `on_session_switch` because the provider now overrides that method to rotate session ids on compression. Without listing it, Hermes does NOT call the override (the `hooks` array gates lifecycle method invocation).

#### Scenario: Manifest declares hooks and requires_env

- **WHEN** Hermes reads `plugin.yaml` at install time
- **THEN** it sees `hooks: [on_session_end, on_pre_compress, on_session_switch]` and surfaces no other hook bindings
- **AND** it sees `requires_env: [REMBRIC_SERVER_URL, REMBRIC_API_TOKEN, REMBRIC_PROJECT_SLUG]` and prompts the user for any of those not already set in the parent shell env
- **AND** answered values land in `${HERMES_HOME:-~/.hermes}/.env` and become available to the plugin module at import time and to all `mcp_servers.*` subprocesses Hermes spawns

#### Scenario: Version is managed by the hermes-plugin release-please component

- **WHEN** a commit modifies any file under `apps/plugin/.hermes-plugin/`
- **THEN** release-please's `hermes-plugin` component SHALL detect the change and stage a version bump for `apps/plugin/.hermes-plugin/plugin.yaml`
- **AND** the bump SHALL be independent of the `claude-code-plugin`, `codex-plugin`, and `opencode-plugin` components
- **AND** a `hermes-plugin-vX.Y.Z` git tag SHALL be created when the release-please PR is merged

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
- `system_prompt_block` SHALL return a single-paragraph block (**≤300 chars**) directing the agent to (a) call `memory.session_summary({title, summary})` before declaring work done — title ≤100 chars descriptive of what was actually worked on; summary follows Goal · Discoveries · Accomplished · Next Steps · Files — AND (b) call `memory.context` after any compaction event when the compact summary lacks detail (file paths, specific decisions, errors). This is the Hermes-side counterpart to Claude/Codex's `initialize.instructions` nudge, which now also carries the memory.context post-compact recovery guidance for symmetry.
- `prefetch(query, **kwargs)` SHALL return `""`.
- `queue_prefetch(query, **kwargs)` SHALL be a no-op (return `None`).
- `sync_turn(user, assistant, **kwargs)` SHALL be a no-op.
- `on_memory_write(action, target, content, **kwargs)` SHALL be a no-op.
- `shutdown(**kwargs)` SHALL be a no-op.

The provider SHALL NOT implement `get_config_schema` or `save_config`. Credentials live in `~/.hermes/.env`. The provider SHALL NOT preload any plugin-specific dotenv file.

#### Scenario: is_available with both envs set and a healthy server returns True

(Unchanged from the prior spec.)

#### Scenario: is_available with a missing token returns False without making a request

(Unchanged from the prior spec.)

#### Scenario: is_available with an invalid token returns False

(Unchanged from the prior spec.)

#### Scenario: is_available with the server's database unavailable returns False

(Unchanged from the prior spec.)

#### Scenario: Session initialize POSTs to the sessions endpoint with agent: hermes

(Unchanged from the prior spec.)

#### Scenario: Pre-compress posts a transcript summary

(Unchanged from the prior spec.)

#### Scenario: Session end posts to the end endpoint with summary and derived title

(Unchanged from the prior spec.)

#### Scenario: Session end with empty messages degrades to `{}`

(Unchanged from the prior spec.)

#### Scenario: Session end when model already wrote a final summary

(Unchanged from the prior spec.)

#### Scenario: Lifecycle calls without a resolved slug skip silently

(Unchanged from the prior spec.)

#### Scenario: system_prompt_block emits the session-close protocol AND memory.context post-compact guidance

- **WHEN** Hermes calls `provider.system_prompt_block()`
- **THEN** the returned string SHALL be non-empty and SHALL contain the substring `memory.session_summary`
- **AND** SHALL contain a reference to `title` and the structure `Goal · Discoveries · Accomplished · Next Steps · Files`
- **AND** SHALL contain the substring `memory.context` (new — post-compact recovery guidance)
- **AND** SHALL be ≤300 chars total (unchanged cap — the new content MUST fit within the existing cap, requiring concise phrasing)

#### Scenario: handle_tool_call returns a defensive error

(Unchanged from the prior spec.)

#### Scenario: Provider does not manage credential storage

(Unchanged from the prior spec.)

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
- Create the target directory `${HERMES_HOME}/plugins/rembric/` if it does not exist.
- Copy or fetch exactly three files into the target directory: `plugin.yaml`, `__init__.py`, `README.md`. When `PLUGIN_SRC` resolves to a local path that contains these files, the script SHALL prefer local `cp`; otherwise the script SHALL `curl -fsSL` from the prefix.
- Exit non-zero on any unrecoverable error (target directory cannot be created; all sources for a required file fail). Print a clear `[rembric] error: <reason>` line to stderr before exiting.
- Print a one-line success message identifying the install location and the next step to stdout: `✓ rembric installed at <path>\n  enable: hermes plugins enable rembric`.

The recommended public install command in `README.md` SHALL be:

```
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh
```

The legacy URL `https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh` SHALL return HTTP 404 — no shim file is kept under `plugin/.hermes-plugin/`. The breakage is communicated via the first post-restructure `hermes-plugin-vX.Y.Z` release notes (BREAKING), and via the install command published in `README.md`, `docs/agents.md`, and `apps/plugin/.hermes-plugin/README.md`.

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

#### Scenario: Legacy install URL returns 404

- **WHEN** a user runs the legacy command `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh`
- **THEN** `curl -fsSL` SHALL fail with a 404 from `raw.githubusercontent.com` and exit non-zero
- **AND** no plugin files SHALL be installed
- **AND** the user SHALL find the corrected install command in the README / docs / release notes

### Requirement: Uninstall via local script

The plugin SHALL be removable through a script at `apps/plugin/.hermes-plugin/uninstall.sh`, mirroring the conservative, idempotent semantics of `apps/plugin/.opencode-plugin/uninstall.sh`. The script SHALL:

- Be POSIX-compatible and run cleanly such that re-running it on an already-clean system is a no-op that still exits zero (idempotent).
- Honour `HERMES_HOME` (default `${HOME}/.hermes`).
- Remove the three installed plugin files (`plugin.yaml`, `__init__.py`, `README.md`) from `${HERMES_HOME}/plugins/rembric/` if present, then `rmdir` the `rembric` plugin directory when it is empty.
- Run `hermes plugins disable rembric` on a best-effort basis (failure SHALL NOT abort the uninstall).
- NOT remove operator-owned state: it SHALL leave `${HERMES_HOME}/.env`, any stored credentials, and any `.rembric` project markers untouched.
- Print which files were removed, which were already absent, and an explicit list of what it deliberately left in place (the `.env` credentials and `.rembric` files), so the operator can remove them manually if desired.

#### Scenario: Uninstall removes plugin files and reports

- **WHEN** the plugin is installed at `${HOME}/.hermes/plugins/rembric/` and the user runs `sh apps/plugin/.hermes-plugin/uninstall.sh`
- **THEN** the three plugin files SHALL be removed and the now-empty `rembric` directory SHALL be `rmdir`-ed
- **AND** stdout SHALL list the removed files and the deliberately-left-behind state

#### Scenario: Uninstall is idempotent

- **WHEN** `uninstall.sh` runs against a system where the plugin is already absent
- **THEN** it SHALL exit zero
- **AND** it SHALL report the files as already absent without erroring

#### Scenario: Uninstall preserves credentials and project markers

- **WHEN** `uninstall.sh` completes
- **THEN** `${HERMES_HOME}/.env` and any `.rembric` files SHALL remain on disk
- **AND** stdout SHALL name them as deliberately left in place

### Requirement: User documentation

The plugin's `README.md` (at `apps/plugin/.hermes-plugin/README.md`) SHALL include, in this order:

1. The **TUI installer** as the primary install/upgrade instruction (the root `install.sh` shim, canonical URL `.../main/install.sh`, or `--agent=hermes`). The per-client manual install — `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/apps/plugin/.hermes-plugin/install.sh | sh` followed by `hermes plugins install rembric` to trigger the `requires_env` prompts — SHALL be retained below under an explicitly-labelled "Manual install" heading, not as the lead instruction.
2. A description of what Hermes prompts for during install (the three `requires_env` vars) and where the answers are persisted (`${HERMES_HOME:-~/.hermes}/.env`).
3. A two-block `~/.hermes/config.yaml` example showing **both** the `mcp_servers.rembric` block (registering the bundled bridge via `node` or `npx`) AND the `memory: provider: rembric` block, so users wire both the tool surface and the lifecycle in one go.
4. A short "Project slug resolution" section explaining the four-step cascade in plain prose.
5. A "Troubleshooting" section that covers: provider visible in `hermes memory status` but server unhealthy, missing slug diagnostic, mismatched provider-vs-bridge slug, `~/.hermes/.env` edited manually after install.

The README SHALL NOT mention `~/.rembric/.env`, `${XDG_CONFIG_HOME}/rembric/.env`, `get_config_schema`, `save_config`, or `~/.hermes/rembric.json`. Those mechanisms were removed; documenting them would mislead users into setting up files the plugin ignores.

The repository's root `README.md` SHALL be updated to list Hermes Agent under "Supported clients" alongside Claude Code, Codex CLI, and opencode, with a link to the plugin README at `apps/plugin/.hermes-plugin/README.md`.

`docs/agents.md` SHALL gain (or retain, after path swap) a "Hermes Agent" section mirroring the structure of the existing Claude Code and Codex CLI sections, leading with the TUI installer and covering install (including the `requires_env` prompt flow as the manual fallback), config, env vars, slug resolution, and a pointer to the plugin README at the new path.

`apps/plugin/README.md` and `apps/plugin/CHANGELOG.md` SHALL be updated to include Hermes alongside the other clients.

#### Scenario: README leads with the TUI, manual curl-installer retained below

- **WHEN** a user reads `apps/plugin/.hermes-plugin/README.md` top-to-bottom
- **THEN** the first install instruction SHALL be the TUI installer
- **AND** the `curl … install.sh | sh` + `hermes plugins install rembric` flow SHALL appear under an explicit "Manual install" heading

#### Scenario: README pairs provider and bridge in the config example

- **WHEN** a user reads `apps/plugin/.hermes-plugin/README.md` end-to-end
- **THEN** the first config block they see registers BOTH the `mcp_servers.rembric` entry (bridge) AND the `memory.provider: rembric` entry (provider) in the same `~/.hermes/config.yaml` snippet
- **AND** the prose preceding the block explicitly notes that lifecycle (provider) and tool access (bridge) are complementary, not redundant
- **AND** the README contains no reference to `~/.rembric/.env` or `get_config_schema`

### Requirement: Version coupling with other client manifests

The `version` field in `apps/plugin/.hermes-plugin/plugin.yaml` SHALL be managed by release-please's `hermes-plugin` component independently of the other plugin clients. There is NO `linked-versions` group. The Claude Code and Codex surfaces are their own independent components (`claude-code-plugin`, `codex-plugin`) that declare `@rembric/plugin` as a dependency, so the `node-workspace` plugin (`merge: false`) cascades a patch bump to them when shared assets under `apps/plugin/bin/`, `hooks/`, `commands/`, or `scripts/` change. `opencode-plugin` and `hermes-plugin` declare NO such dependency and are therefore outside the cascade graph — fully independent.

`hermes-plugin` is independent of `plugin-shared` because the Hermes installer re-fetches from `main` at install time; changes to shared code under `apps/plugin/` reach Hermes users on their next `curl … install.sh | sh` run without requiring a coordinated `hermes-plugin-vX.Y.Z` release.

The "Releasing a new plugin version" rule in `CLAUDE.md` SHALL describe this per-component model (server · plugin-shared · claude-code-plugin · codex-plugin · opencode-plugin · hermes-plugin, node-workspace cascade, no grouping).

#### Scenario: A Hermes-only fix produces only a Hermes release

- **WHEN** a contributor merges a `fix:` commit that modifies only files under `apps/plugin/.hermes-plugin/`
- **THEN** release-please SHALL open a release PR that bumps only `hermes-plugin`
- **AND** `plugin-shared`, `claude-code-plugin`, `codex-plugin`, `opencode-plugin`, and `server` versions SHALL remain unchanged
- **AND** the resulting git tag SHALL be of the form `hermes-plugin-vX.Y.Z`

#### Scenario: A shared-bin change does not produce a Hermes release

- **WHEN** a contributor merges a `feat:` commit that modifies `apps/plugin/bin/rembric-bridge.mjs`
- **THEN** release-please SHALL bump `plugin-shared` and cascade a `+patch` to `claude-code-plugin` and `codex-plugin` (the dependents) via `node-workspace`
- **AND** `hermes-plugin` SHALL NOT be bumped (it is outside the cascade graph)
- **AND** Hermes users SHALL receive the updated bridge on their next re-run of the install.sh from `main`

### Requirement: No modification to existing plugin assets

This change SHALL NOT modify the runtime behavior of:

- `apps/plugin/bin/rembric-bridge.mjs`
- `apps/plugin/bin/rembric-dotenv.mjs`
- `apps/plugin/scripts/_api.sh`, `apps/plugin/scripts/session-start.sh`, `apps/plugin/scripts/session-stop.sh`, `apps/plugin/scripts/prompt-search.sh`, `apps/plugin/scripts/session-end.sh`, `apps/plugin/scripts/post-compact.sh`
- `apps/plugin/hooks/hooks.json`, `apps/plugin/hooks/hooks.codex.json`
- `apps/plugin/.claude-plugin/mcp.json`, `apps/plugin/.codex-plugin/mcp.json`
- `apps/server/src/server/api-router.ts` (endpoints, schemas, auth)
- DB schema or migrations
- Existing capability specs in `openspec/specs/` other than the path-swap edits coordinated under this change.

The Hermes plugin consumes the **existing** HTTP session endpoints in `apps/server/src/server/api-router.ts` and the **existing** bridge entry point. No new server-side runtime dependencies are introduced.

#### Scenario: Existing plugin asset paths swap but content is unchanged

- **WHEN** comparing the file at `apps/plugin/bin/rembric-bridge.mjs` (post-restructure) against `plugin/bin/rembric-bridge.mjs` (pre-restructure git history)
- **THEN** the file contents SHALL be byte-identical
- **AND** only the directory path SHALL have changed

#### Scenario: Server endpoints consumed by Hermes are unchanged

- **WHEN** the Hermes provider POSTs `/api/<slug>/sessions/<id>/end` or `/api/<slug>/sessions/<id>/summary`
- **THEN** the server SHALL respond identically to its behaviour before the restructure
- **AND** no new request fields, response shapes, status codes, or auth checks SHALL apply

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
