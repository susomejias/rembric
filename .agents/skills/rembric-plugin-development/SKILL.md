---
name: rembric-plugin-development
description: Apply when creating, modifying, or reviewing any Rembric agent plugin. Triggers on changes under `plugin/`, on new clients added alongside Claude Code / Codex CLI / Hermes Agent / opencode, on edits to `plugin/bin/rembric-bridge.mjs` or `plugin/bin/rembric-dotenv.mjs`, on per-client manifest changes, or on plugin install/uninstall scripts. End-to-end validation against `pnpm run dev:docker:up` is mandatory whenever local testing is feasible.
---

# Rembric plugin development

Authoritative specs: `openspec/specs/{claude-code-plugin,codex-distribution,hermes-agent-plugin,opencode-plugin,plugin-session-protocol}/`. Archived decisions: `openspec/changes/archive/`.

## Mandatory workflow

1. **OpenSpec change first.** Run `/opsx:propose` (or amend an existing change). Plugin work always touches ≥2 specs and ≥3 files. Skipping the change is the failure mode that produces drift.
2. **Bump versions in lock-step.** A user-visible plugin change bumps ALL FOUR sources in the same commit (`plugin/.claude-plugin/plugin.json`, `plugin/.codex-plugin/plugin.json`, `plugin/.hermes-plugin/plugin.yaml::version`, `plugin/.opencode-plugin/plugin.ts::// @rembric-plugin-version`). `plugin/CHANGELOG.md` gets a `[X.Y.Z]` entry. Invariant test (`src/test/invariants.test.ts::plugin version lock-step`) catches drift.
3. **End-to-end against `pnpm run dev:docker:up`** before reporting done — see [E2E discipline](#end-to-end-validation-discipline) below.
4. **Docs sweep**: `README.md`, `docs/agents.md`, `plugin/README.md`, the in-plugin `README.md`, `plugin/CHANGELOG.md`. New-client checklist in [references/files-checklist.md](./references/files-checklist.md).

## The two single-source-of-truth rules

- **`.rembric` is the only per-repo slug source.** Dotenv file with `PROJECT_SLUG=<lowercase-hyphen>`. Regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`.
- **`plugin/bin/rembric-dotenv.mjs` is the only JS/TS implementation** of `parseDotenv` + `readRembricSlug` + `SLUG_RE`. Bridge imports it. opencode plugin imports it (via path rewritten by `install.sh`). Inlining any of those in another `.mjs`/`.ts` file fails the build (invariant test).

Bash (`plugin/scripts/_api.sh`) and Python (`plugin/.hermes-plugin/__init__.py`) keep their own implementations — cross-language wrappers cost more than the duplication. They MUST agree on the regex value.

## Per-client gotchas (read on touch)

Each client has 3–5 non-obvious behaviors that bit us. **Before modifying that client's files, skim its section in [references/per-client-gotchas.md](./references/per-client-gotchas.md).** Sample of what's there:

- **Claude Code**: `${user_config.*}` works in both `mcp.json::env` AND hook commands; keychain is the SoT for credentials.
- **Codex CLI**: `${user_config.*}` is NOT substituted; subprocess env is **cleared** before MCP spawn → MUST list every needed var in `env_vars: [...]`; `${CLAUDE_PLUGIN_ROOT}` doesn't work in MCP args.
- **Hermes Agent**: `plugin.yaml::hooks: [...]` array **gates lifecycle invocation** — overriding a method without listing the hook is a silent no-op.
- **opencode**: every named export of a plugin file is invoked as a Plugin function — export ONLY `RembricPlugin`. The bridge MUST live outside `~/.config/opencode/plugins/`. Sub-agent filtering (`parentID || title.endsWith(" subagent)")`) is mandatory.

## Shared-vs-divergent discipline

Per memory `01KRNZM2VFCME5HNT8N78HZW18`: shared logic lives in shared paths. Divergence is allowed ONLY when the platform forces it.

- **MUST be shared**: `plugin/bin/rembric-bridge.mjs`, `plugin/bin/rembric-dotenv.mjs`, `plugin/scripts/*.sh` (Claude+Codex hooks).
- **Legitimately divergent today**: `hooks/hooks.json` vs `hooks/hooks.codex.json` (env-substitution rules differ); `.claude-plugin/mcp.json` vs `.codex-plugin/mcp.json` (`${CLAUDE_PLUGIN_ROOT}` works in one, not the other); Python in-process provider for Hermes; JS/TS in-process for opencode.

Sanity check: `git ls-files plugin/` should show ONE copy of each shared resource. Two paths with near-identical content is a sync bug.

## Install / uninstall script invariants

- **Never edit the user's agent config file** (`settings.json`, `config.toml`, `opencode.json`, `~/.hermes/config.yaml`). Print the snippet with `<PLACEHOLDERS>`; the user pastes.
- **Idempotent**: a second run produces an empty diff.
- **`chmod 644` for files invoked as `node <path>`** (the +x bit isn't needed for `node x.mjs`).
- **Fail loudly on missing source files.**

## Don't overcommit the spec to behavior the server doesn't support

Before adding a handler that POSTs to an endpoint, verify the endpoint exists:

```bash
grep -nE "app\\.(post|get)" src/server/api-router.ts
```

If it doesn't exist: either add the endpoint first (separate OpenSpec change) OR drop the handler from this scope (`tasks.md` says DEFERRED, change CHANGELOG documents it). Don't ship a handler that 404s.

This bit us in `add-opencode-plugin` — first iteration speced `chat.message` POSTing to `/prompts/passive`, which didn't exist. Cost: spec rework + scope reduction post-merge.

## Adding a brand-new client

Always start with a Phase 0 spike in `tasks.md` that validates platform assumptions BEFORE any plugin code. Examples of what to spike, plus the cwd/PWD propagation experiment template, live in [references/new-client-spike.md](./references/new-client-spike.md).

The spike's outcome MUST be recorded as a comment in BOTH `tasks.md` (`<!-- spike result: plan-a -->`) and the plugin's source file (`// cwd-spike-result: plan-a`).

## End-to-end validation discipline

**You MUST exercise the change against a real Rembric dev stack before reporting work as done**, unless local e2e is genuinely impossible. Spec validation and unit tests are necessary but not sufficient for plugin work — the multi-process flow (agent → bridge → MCP → HTTP → SQLite → dashboard) breaks in non-obvious places.

Minimum required steps:

1. `pnpm run dev:docker:up`. Wait for `[bootstrap] listening on`. Capture the seeded `demo-writer` token from the seed banner.
2. Install the plugin (`bash plugin/.<X>-plugin/install.sh`), configure the client end-to-end with real URL + real token, drop `.rembric` with `PROJECT_SLUG=demo` in the working directory.
3. Exercise the lifecycle path your change affects. The exact commands per client (opencode `mcp list`, tsx-driven handler invocation, dashboard SQLite verification, etc.) are in [references/e2e-walkthrough.md](./references/e2e-walkthrough.md).
4. Tear down: `docker compose ... down`, uninstall, restore user's config file to its prior state (placeholders if it didn't exist before).

**If you cannot drive the agent TUI** (live LLM cost, or you're testing keychain integration you can't script):

- **Direct handler invocation via `pnpm exec tsx`** covers ~95% of the handler logic. Pattern from `add-opencode-plugin`: import the installed plugin module, set env vars, call handlers with mock inputs that mirror the platform's event shape.
- **Tell the user explicitly** what you DID verify vs what you DID NOT. Don't say "verified e2e" when you only ran unit tests. List the manual smoke steps the user should run.

**If local e2e is genuinely impossible** (Codex `plugin_hooks` feature gate, Claude Code keychain integration, tool you don't have installed): say so out loud. Tell the user:

> "I can't drive `<specific path>` from this environment. Unit tests cover `<list>`. Manual verification needed for `<list>`. Want the steps?"

Honest > glossing-over.

## Self-check before commit

If any answer is "no" or "I don't know", stop and resolve it.

- [ ] OpenSpec change open or amended for this work
- [ ] Four version sources bumped + CHANGELOG entry written
- [ ] No duplication of `parseDotenv` / `SLUG_RE` / endpoint strings without justification
- [ ] `pnpm vitest run` + `pnpm run typecheck` + `pnpm run lint` + `openspec validate <change> --strict` all clean
- [ ] Exercised against `pnpm run dev:docker:up` (or explicitly told the user what isn't verified)
- [ ] Docs sweep done (README, docs/agents.md, plugin/README.md, in-plugin README, CHANGELOG)
- [ ] Install/uninstall idempotent (verified by running twice)
- [ ] User's local state restored (dev stack down, plugin uninstalled, config placeholders)
