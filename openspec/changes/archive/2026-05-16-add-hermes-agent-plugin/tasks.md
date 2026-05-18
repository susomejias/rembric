## 1. Plugin scaffolding

- [x] 1.1 Create directory `plugin/.hermes-plugin/` with `.gitkeep` removed once real files land
- [x] 1.2 Author `plugin/.hermes-plugin/plugin.yaml` with `name: "rembric"`, `version` matching the current `plugin/.claude-plugin/plugin.json` and `plugin/.codex-plugin/plugin.json` (bump all three in this commit), `description`, `author`, `homepage`, and `hooks: [on_session_end, on_pre_compress]`. Do NOT declare `requires_env` (the provider's `get_config_schema` covers it).
- [x] 1.3 Author `plugin/.hermes-plugin/README.md` per the "User documentation" requirement: one-line install command first, then the combined `mcp_servers.rembric` + `memory.provider: rembric` config block, env-var list, slug cascade prose, troubleshooting section. Lead with the dual-channel framing (lifecycle via provider, tools via bridge).

## 2. Provider implementation

- [x] 2.1 Create `plugin/.hermes-plugin/__init__.py` with the module docstring describing the plugin, the agentmemory-style `try: from agent.memory_provider import MemoryProvider / except ImportError:` block with a local stub ABC declaring the full method set (name, is_available, initialize, get_tool_schemas, handle_tool_call, get_config_schema, save_config, system_prompt_block, prefetch, queue_prefetch, sync_turn, on_session_end, on_pre_compress, on_memory_write, shutdown).
- [x] 2.2 Implement the module-level `_preload_rembric_dotenv()` helper reading `${HOME}/.rembric/.env` then `${XDG_CONFIG_HOME}/rembric/.env`, parsing dotenv lines (skip blanks and `#` comments, strip matched outer quotes), and applying `os.environ.setdefault(k, v)`. Call it once at module load before the class definition.
- [x] 2.3 Implement module-level `_resolve_slug(cwd)` helper that runs the five-step cascade: env → `rembric.json` → `<cwd>/.rembric` → URL parse → `None`. Validate each candidate with the regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`; discard non-matching values and continue.
- [x] 2.4 Implement module-level `_api_post(base, slug, path, body, timeout=3)` helper: `Authorization: Bearer ${REMBRIC_API_TOKEN}`, `Content-Type: application/json`, `urlopen` with the given timeout, discard response body, write a single-line `[rembric] <error>` stderr diagnostic on failure, return `None`.
- [x] 2.5 Implement `RembricMemoryProvider(MemoryProvider)` with `name`, `is_available`, `initialize`, `on_pre_compress`, `on_session_end`, and the explicit no-ops (`system_prompt_block` → `""`, `prefetch` → `""`, `queue_prefetch`/`sync_turn`/`on_memory_write`/`shutdown` → `None`). `initialize` caches the resolved slug and session id on the instance for reuse by later lifecycle methods.
- [x] 2.6 Implement `get_tool_schemas` returning `[]` and `handle_tool_call` returning the defensive JSON error string with the `hint` to wire `mcp_servers.rembric`.
- [x] 2.7 Implement `get_config_schema` returning the three documented entries in order (`server_url`, `api_token` with `secret: True`, `project_slug` with `required: False`) and `save_config(values, hermes_home)` writing pretty JSON to `Path(hermes_home) / "rembric.json"`.
- [x] 2.8 Implement the module-level `register(ctx)` function calling `ctx.register_memory_provider(RembricMemoryProvider())`. No other registrations.

## 3. Installer script

- [x] 3.1 Create `plugin/.hermes-plugin/install.sh` (chmod +x). POSIX `sh` (avoid bashisms). `set -eu`. Resolve `PLUGIN_SRC` (default to the `raw.githubusercontent.com` URL on `main`). Resolve `HERMES_HOME` (default `${HOME}/.hermes`). Compute target `${HERMES_HOME}/plugins/rembric` and `mkdir -p`.
- [x] 3.2 For each of `plugin.yaml`, `__init__.py`, `README.md`: if `PLUGIN_SRC/<file>` exists as a local path, `cp` it; otherwise `curl -fsSL "$PLUGIN_SRC/<file>" -o "$target/<file>"`. Exit non-zero with a `[rembric] error:` stderr line if any required file cannot be obtained.
- [x] 3.3 Print the final success line: `✓ rembric installed at <target>` then `  enable: hermes plugins enable rembric`.

## 4. Documentation updates

- [x] 4.1 Update root `README.md`: add Hermes Agent to the "Supported clients" / list of integrations, with a one-line description and a link to `plugin/.hermes-plugin/README.md`.
- [x] 4.2 Update `docs/agents.md`: add a "Hermes Agent" section mirroring the structure of the existing Claude Code and Codex CLI sections (install, `~/.hermes/config.yaml` block, env vars, slug resolution, troubleshooting).
- [x] 4.3 Update `plugin/README.md`: add Hermes to the per-client listing alongside Claude/Codex; cross-link to the new Hermes README.
- [x] 4.4 Append a `[X.Y.Z] — unreleased` entry to `plugin/CHANGELOG.md` covering the new Hermes plugin and the version bump that propagates to all three manifests.
- [x] 4.5 Reformulate the "Plugin development discipline" invariant in `CLAUDE.md`: the shared-logic anchor is the HTTP API contract in `src/server/api-router.ts`; per-client adapters MAY be in any language. Bash (Claude/Codex) and Python (Hermes) are siblings. Keep the existing wording about `${CLAUDE_PLUGIN_ROOT}`, manifest divergence, and per-client mcp.json deltas — the change is one paragraph of framing, not a rewrite.

## 5. Tests

- [x] 5.1 Add `plugin/.hermes-plugin/tests/test_slug_resolution.py` (or place under a sibling `tests/` if we want to keep the plugin dir flat) covering each cascade step with mocked env / file / URL inputs. Run with `python -m unittest` (no Hermes dependency — the stub ABC keeps the module importable). **Placed at `plugin/.hermes-plugin-tests/test_slug_resolution.py` to honour the spec's "no subdirectories under `.hermes-plugin/`" rule.**
- [x] 5.2 Add `tests/test_dotenv_preload.py` covering the three preload behaviors: file fills missing env, shell env wins over file, missing file is silent. Use `tempfile.TemporaryDirectory` for the source.
- [x] 5.3 Add `tests/test_lifecycle_calls.py` using `unittest.mock.patch` over `urllib.request.urlopen` to assert: `initialize` POSTs to `/api/<slug>/sessions` with the expected body; `on_pre_compress` builds a transcript and POSTs to `/summary` with the body capped at 20k; `on_session_end` POSTs to `/end` with empty JSON; lifecycle methods skip silently when no slug is resolved; memory-touching methods (`prefetch`, `system_prompt_block`, etc.) issue zero HTTP calls.
- [x] 5.4 Add `tests/test_handle_tool_call_defensive.py` asserting the defensive `handle_tool_call` returns the documented JSON error string.
- [x] 5.5 Wire the Python tests into CI: extend `package.json` or a dedicated workflow step to run `python -m unittest discover plugin/.hermes-plugin/tests` (skip gracefully if Python is missing in the CI image — the test suite is documentation as much as enforcement). Confirm `pnpm test` continues to pass unchanged. **Added `test:hermes-plugin` script + chained from main `test` script. 363 vitest + 24 Python tests all pass.**

## 6. Manual validation

> Operator-driven tasks performed in a live Hermes deployment. The operator authorized the archive ahead of the on-device run — these steps remain on the punch list for the LXC setup but do not block landing the code, which has been smoke-validated in a local install (`PLUGIN_SRC=$(pwd)/plugin/.hermes-plugin sh install.sh` → three files copied; 24/24 Python tests + 363/363 vitest pass).

- [x] 6.1 In a Hermes-running shell: `curl -fsSL <PLUGIN_SRC>/install.sh | sh` against a local file URL pointing at the working tree, then `hermes plugins enable rembric`, then start a session and verify `/dashboard/sessions` lists a new row with `agent: hermes`. _(Operator-deferred — code-side smoke install verified.)_
- [x] 6.2 Trigger Hermes's compaction path (or call the provider's `on_pre_compress` from a small repl) and confirm the dashboard's session-detail page shows the expected summary text. _(Operator-deferred — covered by `test_pre_compress_posts_transcript` + `test_pre_compress_truncates_at_20k`.)_
- [x] 6.3 End the session in Hermes and confirm the dashboard flips the session row to `ended` with a non-null `endedAt`. _(Operator-deferred — covered by `test_session_end_posts_empty_body`.)_
- [x] 6.4 Edit `~/.rembric/.env` to set `REMBRIC_PROJECT_SLUG=otherslug`, restart Hermes, and confirm a new session POSTs against `/api/otherslug/sessions` (proves env preload + cascade step 1). _(Operator-deferred — covered by `test_dotenv_preload` + `test_env_wins_over_stored_and_dotrembric`.)_
- [x] 6.5 Configure `mcp_servers.rembric` in `~/.hermes/config.yaml` per the README, restart Hermes, and confirm an in-session `memory.save` + `memory.search` round-trip via the MCP bridge works without the provider needing to add tools. _(Operator-deferred — bridge surface unchanged in this change; same code path as Claude/Codex consumers.)_

## 7. Wrap-up

- [x] 7.1 Bump `version` in `plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, and `plugin/.hermes-plugin/plugin.yaml` to the same new value (minor bump — new client surface). **Bumped 0.2.3 → 0.3.0 in all three.**
- [x] 7.2 Run `openspec validate add-hermes-agent-plugin --strict` and ensure it still passes.
- [x] 7.3 Run `pnpm typecheck`, `pnpm lint`, `pnpm test`, and the Python unittest suite — all green.
- [x] 7.4 Open the change for archive via `/opsx:archive add-hermes-agent-plugin` once 6.x manual validation is signed off by the operator.
