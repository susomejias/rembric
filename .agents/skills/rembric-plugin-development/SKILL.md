---
name: rembric-plugin-development
description: Apply when creating, modifying, or reviewing any Rembric agent plugin. Triggers on changes under `apps/plugin/`, on new clients added alongside Claude Code / Codex CLI / Hermes Agent / opencode / Pi, on edits to `apps/plugin/bin/rembric-bridge.mjs`, `apps/plugin/bin/rembric-dotenv.mjs` or `apps/plugin/bin/rembric-plugin-core.mjs`, on per-client manifest changes, or on plugin install/uninstall scripts. End-to-end validation against `pnpm run dev:docker:up` is mandatory whenever local testing is feasible.
---

# Rembric plugin development

Authoritative specs: `openspec/specs/{claude-code-plugin,codex-distribution,hermes-agent-plugin,opencode-plugin,pi-plugin,plugin-session-protocol}/`. Archived decisions: `openspec/changes/archive/`.

## Mandatory workflow

1. **OpenSpec change first.** Run `/opsx:propose` (or amend an existing change). Plugin work always touches ≥2 specs and ≥3 files. Skipping the change is the failure mode that produces drift.
2. **Two release tracks: `server` + unified `plugin` (no cascade).** release-please runs exactly two components, no `node-workspace`/`linked-versions`/grouping. `server` (`apps/server`, package `@rembric/server`, tag `server-v*`) builds the Docker image. **`plugin`** (`apps/plugin` — the WHOLE tree, no `exclude-paths`, package `@rembric/plugin`, tag `plugin-v*`) carries **one unified version for all five clients**; its `extra-files` update every client carrier in lock-step (`.claude-plugin/{package,plugin}.json`, `.codex-plugin/{package,plugin}.json`, `.hermes-plugin/plugin.yaml`, `.opencode-plugin/plugin.ts` comment, `.pi-plugin/package.json`). A change to ANY plugin file bumps the single `plugin` version — claude/codex/opencode/hermes/pi never diverge; the CHANGELOG (scoped by conventional commit) records what actually changed. A `plugin` release NEVER rebuilds the server image (`publish-docker` gates on `server_release_created`), but it IS what publishes `@rembric/pi` to npm (trusted-publishing OIDC, provenance, no long-lived token). `.pi-plugin/` has to live inside `apps/plugin/` for that: release-please attributes a release by the paths of the commits under the component's `path`, so a client outside it would never _cause_ a release and its carrier would only move when something unrelated did. `release-please.yml` carries a `concurrency` guard (`cancel-in-progress: false`) so a rapid second merge can't cancel tag-minting. The former six-component + `node-workspace` cascade was retired (change `unify-plugin-release-track`) after its anchor-tag fragility produced phantom release PRs. Legacy per-client tags (`claude-code-plugin-v*`, …) stay in history, inert.
3. **End-to-end against `pnpm run dev:docker:up`** before reporting done — see [E2E discipline](#end-to-end-validation-discipline) below.
4. **Docs sweep**: `README.md`, `docs/agents.md`, `apps/plugin/README.md`, the in-plugin `README.md`, `apps/plugin/CHANGELOG.md`. New-client checklist in [references/files-checklist.md](./references/files-checklist.md).

> **No tool watches the per-client manifest dirs for you.** `eslint.config.js` ignores `apps/plugin/*/**`, which matches the dot-directories, and none of them match `pnpm-workspace.yaml::packages` (`apps/*`, `packages/*`) — so `pnpm -r` does not reach them, ESLint does not lint their TypeScript, and any `dependencies` they declare are not installed by the repo's own install (`.claude-plugin/package.json`'s `workspace:*` dep is dead letter today). Their tests run **only** because `apps/server/vitest.config.ts::include` lists a literal glob per client; a new client without its glob leaves a test file written and never executed, and the suite is green on nothing.

## The three single-source-of-truth rules

- **`.rembric` is the only per-repo slug source.** Dotenv file with `PROJECT_SLUG=<lowercase-hyphen>`. Regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`.
- **`apps/plugin/bin/rembric-dotenv.mjs` is the only JS/TS implementation** of `parseDotenv` + `readRembricSlug` + `SLUG_RE`. Bridge imports it. opencode plugin imports it (via path rewritten by `install.sh`). Pi extension imports it. Inlining any of those in another `.mjs`/`.ts` file fails the build (invariant test).
- **`apps/plugin/bin/rembric-plugin-core.mjs` is the only JS/TS implementation** of the nudge strings, `stripPrivateTags`, `truncate`, `diag`, the session HTTP client, the transcript accumulator and the flush helpers. Both JS/TS clients (opencode, Pi) import it, which is what makes the nudge strings byte-identical and the `<private>` redaction identical **by construction** rather than by review. Its `agent` parameter is required with no default: `sessions.agent` is written once per session into append-only rows with no repair verb, so a default misfiles sessions permanently. `rembric-plugin-core.d.mts` is hand-written (`apps/plugin` has no build step and no typecheck) and is the only thing that makes the omission a compile error.

Bash (`apps/plugin/scripts/_api.sh`) and Python (`apps/plugin/.hermes-plugin/__init__.py`) keep their own implementations — cross-language wrappers cost more than the duplication. They MUST agree on the regex value.

## Per-client gotchas (read on touch)

Each client has 3–5 non-obvious behaviors that bit us. **Before modifying that client's files, skim its section in [references/per-client-gotchas.md](./references/per-client-gotchas.md).** Sample of what's there:

- **Claude Code**: `${user_config.*}` works in both `mcp.json::env` AND hook commands; keychain is the SoT for credentials.
- **Codex CLI**: `${user_config.*}` is NOT substituted; subprocess env is **cleared** before MCP spawn → MUST list every needed var in `env_vars: [...]`; `${CLAUDE_PLUGIN_ROOT}` doesn't work in MCP args.
- **Hermes Agent**: `plugin.yaml::hooks: [...]` array **gates lifecycle invocation** — overriding a method without listing the hook is a silent no-op.
- **opencode**: every named export of a plugin file is invoked as a Plugin function — export ONLY `RembricPlugin`. The bridge MUST live outside `~/.config/opencode/plugins/`. Sub-agent filtering (`parentID || title.endsWith(" subagent)")`) is mandatory.
- **Pi**: no built-in MCP (its own docs say so, deliberately) → this is the one client whose plugin holds the MCP client, discovering tools with `tools/list`; tools register under provider-safe names (`.`→`_`) because a real provider rejects the whole payload on a dot; shutdown is awaited and **two Ctrl-C presses within 500 ms fire it in the interactive TUI** (a single press does not, and print mode registers no SIGINT); nothing is injected from its settings file, so credentials come from the shell.

## Shared-vs-divergent discipline

Per memory `01KRNZM2VFCME5HNT8N78HZW18`: shared logic lives in shared paths. Divergence is allowed ONLY when the platform forces it.

- **MUST be shared**: `apps/plugin/bin/rembric-bridge.mjs`, `apps/plugin/bin/rembric-dotenv.mjs`, `apps/plugin/bin/rembric-plugin-core.mjs`, `apps/plugin/scripts/*.sh` (Claude+Codex hooks), `apps/plugin/commands/*.md` (Pi consumes them verbatim as prompt templates — reference them, never copy).
- **Legitimately divergent today**: `hooks/hooks.json` vs `hooks/hooks.codex.json` (env-substitution rules differ); `.claude-plugin/mcp.json` vs `.codex-plugin/mcp.json` (`${CLAUDE_PLUGIN_ROOT}` works in one, not the other); Python in-process provider for Hermes; JS/TS in-process for opencode; the MCP transport in `.pi-plugin/index.ts`, because that host has no MCP client for the bridge to plug into.

Sanity check: `git ls-files apps/plugin/` should show ONE copy of each shared resource. Two paths with near-identical content is a sync bug.

## Install / uninstall script invariants

- **Never edit the user's agent config file** (`settings.json`, `config.toml`, `opencode.json`, `~/.hermes/config.yaml`). Print the snippet with `<PLACEHOLDERS>`; the user pastes.
- **Idempotent**: a second run produces an empty diff.
- **`chmod 644` for files invoked as `node <path>`** (the +x bit isn't needed for `node x.mjs`).
- **Fail loudly on missing source files.**

## Don't overcommit the spec to behavior the server doesn't support

Before adding a handler that POSTs to an endpoint, verify the endpoint exists:

```bash
grep -nE "app\\.(post|get)" apps/server/src/server/api-router.ts
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
2. Install the plugin (`bash apps/plugin/.<X>-plugin/install.sh`), configure the client end-to-end with real URL + real token, drop `.rembric` with `PROJECT_SLUG=demo` in the working directory.
3. Exercise the lifecycle path your change affects. The exact commands per client (opencode `mcp list`, tsx-driven handler invocation, dashboard SQLite verification, etc.) are in [references/e2e-walkthrough.md](./references/e2e-walkthrough.md).
4. Tear down: `docker compose ... down`, uninstall, restore user's config file to its prior state (placeholders if it didn't exist before).

**Prefer the isolated variant of steps 2-4 when the client's CLI supports it** — scratch `HOME`, per-run extension load instead of install, deliberately invalid API key. It touches none of the operator's config, so there is nothing to restore and no half-restored state to leave behind, and it costs no LLM calls. Six rails plus the paired-control method: [references/e2e-walkthrough.md § 5b](./references/e2e-walkthrough.md).

**If you still cannot drive the agent TUI** (a client with no per-run load, or keychain integration you can't script):

- **Direct handler invocation via `pnpm exec tsx`** covers ~95% of the handler logic. Pattern from `add-opencode-plugin`: import the installed plugin module, set env vars, call handlers with mock inputs that mirror the platform's event shape.
- **Tell the user explicitly** what you DID verify vs what you DID NOT. Don't say "verified e2e" when you only ran unit tests. List the manual smoke steps the user should run.

**If local e2e is genuinely impossible** (Codex `/hooks` interactive trust gate, Claude Code keychain integration, tool you don't have installed): say so out loud. Tell the user:

> "I can't drive `<specific path>` from this environment. Unit tests cover `<list>`. Manual verification needed for `<list>`. Want the steps?"

Honest > glossing-over.

## Self-check before commit

If any answer is "no" or "I don't know", stop and resolve it.

- [ ] OpenSpec change open or amended for this work
- [ ] Two-track release respected (`server` + unified `plugin`; no node-workspace/cascade; all five clients share the one `plugin` version via `extra-files`; plugin release never rebuilds Docker)
- [ ] No duplication of `parseDotenv` / `SLUG_RE` / the `rembric-plugin-core` helpers / endpoint strings without justification
- [ ] `pnpm vitest run` + `pnpm run typecheck` + `pnpm run lint` + `openspec validate <change> --strict` all clean
- [ ] Exercised against `pnpm run dev:docker:up` (or explicitly told the user what isn't verified)
- [ ] Docs sweep done (README, docs/agents.md, apps/plugin/README.md, in-plugin README, CHANGELOG)
- [ ] Install/uninstall idempotent (verified by running twice)
- [ ] User's local state restored (dev stack down, plugin uninstalled, config placeholders)
