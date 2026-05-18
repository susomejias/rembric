## 1. Manifest + Python code

- [ ] 1.1 Add `requires_env` to `plugin/.hermes-plugin/plugin.yaml` with the three vars (`REMBRIC_SERVER_URL`, `REMBRIC_API_TOKEN` (secret), `REMBRIC_PROJECT_SLUG`) using the rich list-of-dicts form (`name`, `description`, optional `secret: true`).
- [ ] 1.2 Bump `version` to `0.4.0` in `plugin/.hermes-plugin/plugin.yaml`.
- [ ] 1.3 Remove `RembricMemoryProvider.get_config_schema()` from `plugin/.hermes-plugin/__init__.py`. Let the default (returns `[]`) inherit from the stub ABC and from Hermes's real `MemoryProvider`.
- [ ] 1.4 Remove `RembricMemoryProvider.save_config()` from `plugin/.hermes-plugin/__init__.py`. Same — let the default no-op inherit.
- [ ] 1.5 Remove the `_preload_rembric_dotenv()` helper from `plugin/.hermes-plugin/__init__.py` and its module-level invocation. Remove the related comment block ("Dotenv preload (issue #250 parity with agentmemory)").
- [ ] 1.6 Remove the `_slug_from_stored_config()` helper from `plugin/.hermes-plugin/__init__.py` and drop it from the `_resolve_slug` cascade. The cascade becomes: `_slug_from_env`, `_slug_from_dotrembric`, `_slug_from_url`.
- [ ] 1.7 Update the module docstring at the top of `plugin/.hermes-plugin/__init__.py` to reflect the simplified resolution cascade and the fact that env now comes from Hermes via `requires_env:`, not from a plugin-private dotenv.

## 2. Other client manifests

- [ ] 2.1 Bump `version` to `0.4.0` in `plugin/.claude-plugin/plugin.json` and `plugin/.codex-plugin/plugin.json` (lock-step rule).

## 3. Tests

- [ ] 3.1 Delete `plugin/.hermes-plugin-tests/test_dotenv_preload.py` — `_preload_rembric_dotenv` no longer exists.
- [ ] 3.2 Remove the `test_config_schema_shape` case from `plugin/.hermes-plugin-tests/test_handle_tool_call_defensive.py`. Keep the other three cases (`test_returns_documented_json_error`, `test_get_tool_schemas_is_empty`, `test_name_is_rembric`).
- [ ] 3.3 Update `plugin/.hermes-plugin-tests/test_slug_resolution.py` to drop the `test_stored_config_wins_over_dotrembric` case and the `~/.hermes/hermes/rembric.json` setup lines from the other cases. Adjust the remaining cases so they cover the new four-step cascade (env → `.rembric` → URL → None).
- [ ] 3.4 Run `pnpm run test:hermes-plugin` — confirm all surviving tests still pass.

## 4. Documentation

- [ ] 4.1 Rewrite `plugin/.hermes-plugin/README.md`:
  - **Install** section: still leads with `curl … | sh`, then `hermes plugins install rembric` to trigger the `requires_env` prompts (or pre-export the three vars to skip them).
  - **Configure** section: keep the `~/.hermes/config.yaml` block pairing `mcp_servers.rembric` and `memory.provider: rembric`.
  - **Where to put the values** section: rewrite to describe Hermes's `requires_env` flow as the canonical and only path. Mention that values land in `~/.hermes/.env` and that re-running `hermes plugins install` re-prompts.
  - **Project slug resolution**: shrink to a four-step cascade.
  - **Troubleshooting** table: remove the row about `~/.rembric/.env`. Keep / add: env values not picked up (run `hermes plugins install` again), `[rembric] no project slug` diagnostic, `HTTPError 404` for path-scoped `REMBRIC_SERVER_URL`.
  - Remove ALL references to `~/.rembric/.env`, `${XDG_CONFIG_HOME}/rembric/.env`, `get_config_schema`, `save_config`, `~/.hermes/rembric.json`.
- [ ] 4.2 Rewrite the Hermes section in `docs/agents.md` to mirror the new README. Drop the `~/.rembric/.env` callout that was added in 0.3.1.
- [ ] 4.3 Update `plugin/CHANGELOG.md` with a `[0.4.0]` entry covering: the manifest field addition (`requires_env`), the removed Python methods, the dropped dotenv preload, the simplified slug cascade, and an explicit **Migration** subsection for 0.3.x users.
- [ ] 4.4 No changes needed to the root `README.md` or `plugin/README.md` — the install command shape is the same; only the underlying credential mechanism changed.

## 5. Validation

- [ ] 5.1 Run `python3 -m py_compile plugin/.hermes-plugin/__init__.py` — module compiles.
- [ ] 5.2 Run `pnpm run test:hermes-plugin` — tests pass.
- [ ] 5.3 Run `pnpm typecheck`, `pnpm lint`, `pnpm test` — all green.
- [ ] 5.4 Smoke-test `install.sh` with local `PLUGIN_SRC` to confirm the new `plugin.yaml` and `__init__.py` land correctly.
- [ ] 5.5 Run `openspec validate --type change simplify-hermes-plugin-env-handling --strict` — passes.
- [ ] 5.6 Archive via `openspec archive simplify-hermes-plugin-env-handling -y` so the main spec at `openspec/specs/hermes-agent-plugin/spec.md` reflects the new contract.

## 6. Operator handoff

- [ ] 6.1 Manual validation in the LXC: `curl … | sh && hermes plugins install rembric` (answer the three prompts) → restart Hermes → confirm a session row appears in `/dashboard/sessions` with `agent=hermes`, WITHOUT a `~/.rembric/.env` file present. _(Operator-deferred — covered by the test_lifecycle_calls suite + the manifest smoke test.)_
- [ ] 6.2 Delete `~/.rembric/.env` and `~/.hermes/rembric.json` on the operator's machine; re-run the install if needed. _(Operator-driven cleanup.)_
