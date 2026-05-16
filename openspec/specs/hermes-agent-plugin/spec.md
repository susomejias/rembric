# hermes-agent-plugin Specification

## Purpose

TBD - created by archiving change add-hermes-agent-plugin. Update Purpose after archive.

## Requirements

### Requirement: Plugin source location

The plugin SHALL live in this monorepo at `plugin/.hermes-plugin/`, sibling to `plugin/.claude-plugin/` and `plugin/.codex-plugin/`. The directory SHALL contain exactly four files: `plugin.yaml`, `__init__.py`, `install.sh`, `README.md`. No subdirectories.

#### Scenario: Plugin tree contains the four files

- **WHEN** the repository is at HEAD
- **THEN** `ls plugin/.hermes-plugin/` lists `plugin.yaml`, `__init__.py`, `install.sh`, and `README.md`
- **AND** there are no nested directories under `plugin/.hermes-plugin/`

### Requirement: Plugin manifest declares lifecycle hooks

`plugin/.hermes-plugin/plugin.yaml` SHALL declare the canonical Hermes manifest fields: `name: "rembric"`, `version: "<semver>"` (kept in lock-step with `plugin/.claude-plugin/plugin.json::version` and `plugin/.codex-plugin/plugin.json::version`), `description`, `author`, `homepage`. The manifest SHALL declare a `hooks` array listing the lifecycle events the provider implements with real behavior: `[on_session_end, on_pre_compress]`. The manifest SHALL NOT declare `requires_env` because the provider declares its required configuration via `get_config_schema()` instead.

#### Scenario: Manifest declares only effective hooks

- **WHEN** Hermes reads `plugin.yaml` at install time
- **THEN** it sees `hooks: [on_session_end, on_pre_compress]` and surfaces no other hook bindings
- **AND** `requires_env` is absent so the install does not prompt for env values that the provider's config schema covers

### Requirement: Provider class implements the MemoryProvider ABC

`plugin/.hermes-plugin/__init__.py` SHALL define a class `RembricMemoryProvider` extending `agent.memory_provider.MemoryProvider`. The file SHALL guard the import with `try: from agent.memory_provider import MemoryProvider / except ImportError:` falling back to a local stub ABC defining the same method names, so the file is importable for tests and linting without Hermes installed.

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

### Requirement: Slug resolution cascade

The provider SHALL resolve the project slug in `initialize` using this strict precedence chain. The chain SHALL stop at the first source that yields a slug that matches the regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` (identical to the bridge's regex in `plugin/bin/rembric-bridge.mjs`):

1. `REMBRIC_PROJECT_SLUG` environment variable.
2. The `project_slug` field from `<hermes_home>/rembric.json` (written via `save_config`). `<hermes_home>` defaults to `~/.hermes` and respects the `HERMES_HOME` env var.
3. The `PROJECT_SLUG` value parsed from `<kwargs.cwd>/.rembric`, using the same dotenv-style parser as the bridge: trim whitespace, skip blank lines and lines starting with `#`, accept `KEY=VALUE`, and strip matched outer single or double quotes from the value.
4. The final path segment of `urlparse(REMBRIC_SERVER_URL).path` if the path matches `/mcp/<slug>`.
5. `None` — degraded mode, all session-related POSTs are skipped silently.

The resolved slug SHALL be validated against the slug regex; non-matching candidates SHALL be discarded and the cascade continues to the next source. The provider SHALL NOT walk parent directories looking for `.rembric` — only the literal `cwd` is checked.

#### Scenario: Env wins over stored config

- **WHEN** both `REMBRIC_PROJECT_SLUG=alpha` is set and `~/.hermes/rembric.json` has `{"project_slug":"beta"}`
- **THEN** the provider resolves the slug as `alpha`

#### Scenario: Stored config wins over .rembric file

- **WHEN** `REMBRIC_PROJECT_SLUG` is unset, `~/.hermes/rembric.json` has `{"project_slug":"beta"}`, and `<cwd>/.rembric` contains `PROJECT_SLUG=gamma`
- **THEN** the provider resolves the slug as `beta`

#### Scenario: .rembric file wins over URL parse

- **WHEN** env and stored config are unset, `<cwd>/.rembric` contains `PROJECT_SLUG=gamma`, and `REMBRIC_SERVER_URL=https://memory.example.com/mcp/delta`
- **THEN** the provider resolves the slug as `gamma`

#### Scenario: URL parse is the final source

- **WHEN** env, stored config, and `<cwd>/.rembric` are all absent, and `REMBRIC_SERVER_URL=https://memory.example.com/mcp/delta`
- **THEN** the provider resolves the slug as `delta`

#### Scenario: Invalid candidate is skipped

- **WHEN** `REMBRIC_PROJECT_SLUG=Has_Underscores` (does not match the slug regex) and `<cwd>/.rembric` has `PROJECT_SLUG=gamma`
- **THEN** the provider rejects the env value and resolves the slug as `gamma`

#### Scenario: All sources empty yields None

- **WHEN** no source produces a valid slug
- **THEN** the provider's resolved slug is `None`
- **AND** all session-related POSTs in subsequent lifecycle calls are skipped silently

### Requirement: Provider config schema

`RembricMemoryProvider.get_config_schema` SHALL return a list of exactly three entries in this order:

1. `{"key": "server_url", "description": "Rembric server base URL (WITHOUT /mcp suffix)", "env_var": "REMBRIC_SERVER_URL", "required": True}`
2. `{"key": "api_token", "description": "Bearer token issued by 'rembric token create'", "env_var": "REMBRIC_API_TOKEN", "secret": True, "required": True}`
3. `{"key": "project_slug", "description": "Default project slug; overridden by REMBRIC_PROJECT_SLUG env or <cwd>/.rembric if present", "env_var": "REMBRIC_PROJECT_SLUG", "required": False}`

`RembricMemoryProvider.save_config(values, hermes_home)` SHALL write the values as pretty-printed JSON (indent=2) to `Path(hermes_home) / "rembric.json"`. Failures are silent stderr diagnostics; the provider continues operating with whatever values are already in `os.environ`.

The provider SHALL read its effective configuration at runtime exclusively from `os.environ` for `REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN`, and (if used) `REMBRIC_PROJECT_SLUG`. Values stored by `save_config` are pre-loaded into `os.environ` via the dotenv preload (next requirement) or by Hermes's own `requires_env`-equivalent flow.

#### Scenario: Config schema is exposed in the documented order

- **WHEN** Hermes calls `provider.get_config_schema()`
- **THEN** the returned list has three entries with `key` values `["server_url", "api_token", "project_slug"]` in that exact order
- **AND** the `api_token` entry has `"secret": True`
- **AND** the `project_slug` entry has `"required": False`

### Requirement: Configuration preload from `~/.rembric/.env`

At module import time, before `RembricMemoryProvider` is instantiated, the plugin SHALL attempt to read each of the following files in order and, for every parseable `KEY=VALUE` line, call `os.environ.setdefault(KEY, VALUE)`:

1. `${HOME}/.rembric/.env`
2. `${XDG_CONFIG_HOME}/rembric/.env` (only if `XDG_CONFIG_HOME` is set)

The preload SHALL use dotenv-style parsing identical to the bridge (`#` comments, blank lines skipped, matched-quote stripping). The preload SHALL be silent on any failure (file absent, unreadable, malformed). Shell-set environment variables ALWAYS win because `setdefault` does not overwrite existing keys.

#### Scenario: Preload fills missing env values

- **WHEN** the file `~/.rembric/.env` contains `REMBRIC_SERVER_URL=http://localhost:8787` and the env does not have `REMBRIC_SERVER_URL` set
- **THEN** after plugin import `os.environ["REMBRIC_SERVER_URL"] == "http://localhost:8787"`

#### Scenario: Shell env wins over preload

- **WHEN** the shell exports `REMBRIC_SERVER_URL=http://prod.example.com:8787` and `~/.rembric/.env` contains `REMBRIC_SERVER_URL=http://localhost:8787`
- **THEN** after plugin import `os.environ["REMBRIC_SERVER_URL"] == "http://prod.example.com:8787"`

#### Scenario: Missing file is silent

- **WHEN** neither `~/.rembric/.env` nor `${XDG_CONFIG_HOME}/rembric/.env` exists
- **THEN** plugin import completes without raising and without writing to stderr

### Requirement: Distribution via curl-installer

The plugin SHALL be installable through a single shell script hosted at `plugin/.hermes-plugin/install.sh` in the rembric monorepo. The script SHALL:

- Default to `PLUGIN_SRC="https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin"`.
- Honour an overriding `PLUGIN_SRC` environment variable that points at any local directory (for developers with a cloned monorepo) or any other reachable URL prefix.
- Honour `HERMES_HOME` (default `${HOME}/.hermes`).
- Honour `GH_PAT`, `GH_TOKEN`, or `GITHUB_TOKEN` (in that precedence; first non-empty wins) as a GitHub Personal Access Token used for HTTPS fetches. When set, the script SHALL include `Authorization: Bearer <token>` on every internal `curl` call so the same script works against private `raw.githubusercontent.com` URLs without further command-line plumbing.
- Create the target directory `${HERMES_HOME}/plugins/rembric/` if it does not exist.
- Copy or fetch exactly three files into the target directory: `plugin.yaml`, `__init__.py`, `README.md`. When `PLUGIN_SRC` resolves to a local path that contains these files, the script SHALL prefer local `cp`; otherwise the script SHALL `curl -fsSL` from the prefix.
- Exit non-zero on any unrecoverable error (target directory cannot be created; all sources for a required file fail). Print a clear `[rembric] error: <reason>` line to stderr before exiting. When a fetch fails AND no auth token was set, the stderr line SHALL include the hint `(private repo? set GH_PAT)` so the user gets a single useful diagnostic.
- Print a one-line success message identifying the install location and the next step to stdout: `✓ rembric installed at <path>\n  enable: hermes plugins enable rembric`.

The recommended public install command in `README.md` SHALL be:

```
curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh
```

The plugin's README and docs SHALL NOT recommend a `git clone + cp -r` two-step install as a parallel path. The curl-installer with `PLUGIN_SRC` covers both the casual-user and the developer-with-clone case.

#### Scenario: Default install fetches the three files via curl

- **WHEN** a user runs `curl -fsSL https://raw.githubusercontent.com/susomejias/rembric/main/plugin/.hermes-plugin/install.sh | sh` in a fresh shell with `HERMES_HOME` unset
- **THEN** the script creates `${HOME}/.hermes/plugins/rembric/` and writes `plugin.yaml`, `__init__.py`, `README.md` into it
- **AND** stdout includes `✓ rembric installed at` followed by the resolved path

#### Scenario: Developer install reads from local clone

- **WHEN** a developer with a clone of rembric runs `PLUGIN_SRC="$(pwd)/plugin/.hermes-plugin" sh plugin/.hermes-plugin/install.sh`
- **THEN** the three files in the target directory are byte-identical to the files in the local source
- **AND** no network request is issued by the script

#### Scenario: Missing remote file fails loudly

- **WHEN** the script runs with the default `PLUGIN_SRC` and the upstream `plugin.yaml` returns HTTP 404
- **THEN** the script writes `[rembric] error:` to stderr and exits with a non-zero status
- **AND** the target directory may exist but does not contain a half-written `plugin.yaml`

#### Scenario: GH_PAT is forwarded to every internal fetch

- **WHEN** the user runs `export GH_PAT=ghp_xxx; curl -fsSL -H "Authorization: Bearer $GH_PAT" .../install.sh | sh` against a private `raw.githubusercontent.com` URL prefix
- **THEN** the piped `sh` subprocess inherits `GH_PAT` from the parent shell
- **AND** the script's three internal `curl` calls each include `Authorization: Bearer ghp_xxx`
- **AND** the install succeeds without further user intervention

#### Scenario: Anonymous private-repo fetch hints at GH_PAT

- **WHEN** the script runs with the default `PLUGIN_SRC`, no `GH_PAT`/`GH_TOKEN`/`GITHUB_TOKEN` is set, and the upstream `plugin.yaml` returns HTTP 404 (private repo masking)
- **THEN** the stderr line includes the substring `(private repo? set GH_PAT)`
- **AND** the script exits non-zero

### Requirement: User documentation

The plugin's `README.md` SHALL include, in this order:

1. A one-line install command using `curl -fsSL ... | sh`.
2. A two-block `~/.hermes/config.yaml` example showing **both** the `mcp_servers.rembric` block (registering the bundled bridge via `node` or `npx`) AND the `memory: provider: rembric` block, so users wire both the tool surface and the lifecycle in one go.
3. The list of environment variables: `REMBRIC_SERVER_URL` (required), `REMBRIC_API_TOKEN` (required), `REMBRIC_PROJECT_SLUG` (optional with cascade explanation).
4. A short "Project slug resolution" section explaining the five-step cascade in plain prose.
5. A "Troubleshooting" section that covers: provider visible in `hermes memory status` but server unhealthy, missing slug diagnostic, mismatched provider-vs-bridge slug, the `~/.rembric/.env` preload.

The repository's root `README.md` SHALL be updated to list Hermes Agent under "Supported clients" alongside Claude Code and Codex CLI, with a link to the plugin README.

`docs/agents.md` SHALL gain a new "Hermes Agent" section mirroring the structure of the existing Claude Code and Codex CLI sections, covering install, config, env vars, slug resolution, and a pointer to the plugin README.

`plugin/README.md` and `plugin/CHANGELOG.md` SHALL be updated to include Hermes alongside Claude/Codex.

#### Scenario: README pairs provider and bridge in the config example

- **WHEN** a user reads `plugin/.hermes-plugin/README.md` end-to-end
- **THEN** the first config block they see registers BOTH the `mcp_servers.rembric` entry (bridge) AND the `memory.provider: rembric` entry (provider) in the same `~/.hermes/config.yaml` snippet
- **AND** the prose preceding the block explicitly notes that lifecycle (provider) and tool access (bridge) are complementary, not redundant

### Requirement: Version coupling with other client manifests

The `version` field in `plugin/.hermes-plugin/plugin.yaml` SHALL stay numerically equal to `plugin/.claude-plugin/plugin.json::version` and `plugin/.codex-plugin/plugin.json::version`. The "Releasing a new plugin version" rule in `CLAUDE.md` SHALL be extended in the same commit so that the version-bump rule covers all three manifests.

#### Scenario: All three manifests bump together

- **WHEN** any client-visible change in `plugin/` is committed (scripts, hooks, mcp.json, bin/, or any of the manifests themselves)
- **THEN** the same commit bumps the `version` field in all three of `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, and `plugin/.hermes-plugin/plugin.yaml`
- **AND** `plugin/CHANGELOG.md` gains a corresponding `[X.Y.Z]` entry

### Requirement: No modification to existing plugin assets

This change SHALL NOT modify any of:

- `plugin/bin/rembric-bridge.mjs`
- `plugin/scripts/_api.sh`, `plugin/scripts/session-start.sh`, `plugin/scripts/session-stop.sh`, `plugin/scripts/pre-compact.sh`, `plugin/scripts/prompt-search.sh`
- `plugin/hooks/hooks.json`, `plugin/hooks/hooks.codex.json`
- `plugin/.claude-plugin/mcp.json`, `plugin/.codex-plugin/mcp.json`
- `src/server/api-router.ts` (endpoints, schemas, auth)
- DB schema or migrations
- Existing capability specs in `openspec/specs/` other than the documentation-only edit to `CLAUDE.md` invariant wording (which is project guidance, not a spec).

The Hermes plugin consumes the **existing** HTTP session endpoints in `src/server/api-router.ts` and the **existing** bridge entry point. No new server-side runtime dependencies are introduced.

#### Scenario: Bridge and bash scripts are byte-identical post-change

- **WHEN** the change is applied
- **THEN** `git diff` against `plugin/bin/rembric-bridge.mjs` and every file under `plugin/scripts/`, `plugin/hooks/`, `plugin/.claude-plugin/`, `plugin/.codex-plugin/` shows no modifications
