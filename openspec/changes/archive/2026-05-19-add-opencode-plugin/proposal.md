## Why

opencode (`https://opencode.ai`) is the next agent client we want Rembric to support. Its plugin system is documented and stable: JavaScript/TypeScript modules dropped into `~/.config/opencode/plugins/` that subscribe to a rich event API (`session.created`, `experimental.session.compacting`, `tool.execute.after`, etc.) plus an `opencode.json::mcp` block that registers MCP servers. We have prior art and a deliberate distribution doctrine to mirror: shared `plugin/bin/rembric-bridge.mjs` (used today by Claude Code and Codex CLI), shared HTTP API contract, single `.rembric` slug source. Without an opencode adapter Rembric users coming from opencode have to write their own MCP wiring and lose the session lifecycle that the other three clients ship by default.

The constraint that shapes the design: `package.json` is `private: true` and npm publishing was sunset on 2026-05-17 (`project-npm-publishing-sunset`). We cannot use opencode's preferred `opencode.json::plugin: ["@scope/pkg"]` npm distribution path. The only viable option is the Hermes-style install script that drops a TypeScript file into the user's `~/.config/opencode/plugins/` directory.

## What Changes

- New per-client plugin tree at `plugin/.opencode-plugin/` containing exactly four files (`plugin.ts`, `install.sh`, `uninstall.sh`, `README.md`). No subdirectories, no manifest (opencode has no manifest format — plugins are JS/TS modules in a known directory).
- The opencode plugin SHALL reuse the existing `plugin/bin/rembric-bridge.mjs` verbatim — same bridge consumed by Claude Code and Codex CLI. Reuse is non-negotiable: it preserves single-source-of-truth path-scoping behaviour (`.rembric` → `/mcp/<slug>`) and avoids divergent slug-resolution code across clients.
- The plugin SHALL NOT use opencode's `type: "remote"` MCP transport, because path-scope-per-project requires dynamic URL rewriting at MCP startup time — only the stdio bridge can do that. (This was the option initially under consideration; rejected in design.md::Decision 1 after weighing the per-project `./opencode.json` cost.)
- The install script SHALL copy two files to two distinct locations on the user's machine: `plugin.ts` → `~/.config/opencode/plugins/rembric.ts`, and `rembric-bridge.mjs` → `~/.config/rembric/bin/rembric-bridge.mjs`. Placing the bridge inside `~/.config/opencode/plugins/` would cause opencode to try loading it as a plugin and crash — the bridge MUST live outside that directory.
- The plugin SHALL register four event subscriptions: `event` (dispatcher for `session.created` and `session.deleted`), `chat.message` (passive prompt capture), `tool.execute.after` (passive tool-count + Task-output capture), and `experimental.session.compacting` (synthetic boundary + context injection at compaction). It SHALL NOT register a `SessionEnd`-equivalent; opencode has no clean "user closed the session" event, and the agent-driven `memory.session_summary` MCP tool is the contract for closing (consistent with how Codex behaves today).
- The plugin SHALL filter sub-agent sessions (Task-spawned, detected via `parentID` or title ending in ` subagent)`) from `session.created` to avoid the session-inflation pathology described in engram's issue #116 (a single conversation producing 170 sessions).
- The plugin SHALL read `.rembric` from `ctx.directory` to determine the project slug for HTTP API lifecycle calls (`/api/<slug>/sessions/...`), matching `_api.sh::rembric_read_project_slug` semantics exactly (same regex `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`, same fail-silent behaviour on miss).
- The plugin SHALL NOT inject a system prompt block. The MCP server's `initialize.instructions` already carries the save/recall protocol for opencode (same as Claude Code and Codex CLI). System-prompt injection via `experimental.chat.system.transform` is left as a follow-up that would require evidence that opencode loses the `initialize.instructions` block during compaction.
- The install script SHALL print (not auto-merge) the MCP block the user needs to paste into `~/.config/opencode/opencode.json`. Placeholders for `<REMBRIC_SERVER_URL>` and `<REMBRIC_API_TOKEN>` SHALL be left in the printed block — the user fills them in. The script SHALL NOT touch `opencode.json`.
- A new gate before any plugin code lands: a manual spike SHALL verify that opencode spawns `type: "local"` MCP subprocesses with the user's repository as `cwd` (or at minimum exports `PWD` so `rembric-bridge.mjs`'s `CLAUDE_PROJECT_DIR > PWD > process.cwd()` chain resolves to the correct directory). If the spike fails, the plugin SHALL inject `REMBRIC_PROJECT_DIR=<ctx.directory>` via opencode's `shell.env` hook and the bridge SHALL prepend `REMBRIC_PROJECT_DIR` to its resolution chain (Plan B). The spike result determines which code path ships in v1.
- All three existing per-client `plugin.json` / `plugin.yaml` files (`plugin/.claude-plugin/`, `plugin/.codex-plugin/`, `plugin/.hermes-plugin/`) AND `plugin/CHANGELOG.md` SHALL receive a coordinated minor version bump in the same commit that lands this change. The opencode plugin SHALL declare the same version in a comment header inside `plugin.ts` (no opencode manifest exists to read it from). Version-lock-step rule documented in `CLAUDE.md::Releasing a new plugin version`.
- `README.md`, `docs/agents.md`, and the dashboard's connection-help text SHALL mention opencode as a supported client alongside Claude Code, Codex CLI, and Hermes Agent.

## Capabilities

### New Capabilities

- `opencode-plugin`: distribution, configuration, and runtime behaviour of Rembric's opencode plugin. Covers the `plugin/.opencode-plugin/` source layout, the install/uninstall script contract, the event handler set, the bridge reuse contract, the slug resolution cascade (which extends the existing `.rembric` convention to a fourth client), the MCP block snippet printed by the install script, and the cwd-spike fallback (`shell.env` hook injecting `REMBRIC_PROJECT_DIR`).

### Modified Capabilities

- `plugin-session-protocol`: the convergence-on-summary requirement currently enumerates four origin scenarios (Claude Code cooperating, Claude Code transcript-fallback, Codex per-turn Stop, Hermes `on_session_end`). It SHALL be extended with a fifth scenario covering opencode's behaviour: opencode has no `SessionEnd`-equivalent event, so summary convergence relies on the agent voluntarily calling `memory.session_summary` (cooperating-agent path only). The non-cooperating-agent path SHALL be documented as "opencode sessions stay in `status='active'` until `abandonStale` flips them to `'abandoned'`" — same steady state as Codex.

## Impact

Affected paths:

- `plugin/.opencode-plugin/plugin.ts` — new file, ~400-500 lines TS (event handlers + HTTP client + dotenv parser + slug regex).
- `plugin/.opencode-plugin/install.sh` — new file. Two `cp` commands + creates `~/.config/rembric/bin/` if missing + prints MCP snippet to stdout.
- `plugin/.opencode-plugin/uninstall.sh` — new file. Removes the two installed files.
- `plugin/.opencode-plugin/README.md` — new file. Two-step install (script + MCP paste) documented.
- `plugin/CHANGELOG.md` — minor version bump entry.
- `plugin/.claude-plugin/plugin.json::version`, `plugin/.codex-plugin/plugin.json::version`, `plugin/.hermes-plugin/plugin.yaml::version` — minor version bump (lock-step rule).
- `plugin/bin/rembric-bridge.mjs` — possibly extended to read `REMBRIC_PROJECT_DIR` as the highest-precedence step of its resolution chain (only if cwd spike fails). No behaviour change for existing clients (they don't set this env var).
- `README.md`, `docs/agents.md`, `src/dashboard/help.ts` (or equivalent token-creation page copy) — mention opencode as supported client.
- `openspec/specs/opencode-plugin/spec.md` — new capability spec.
- `openspec/specs/plugin-session-protocol/spec.md` — extended with the opencode scenario.

Affected invariants:

- `Shared plugin logic MUST live in shared paths` (project-level feedback memory `01KRNZM2VFCME5HNT8N78HZW18`) is honoured: the opencode plugin shares `plugin/bin/rembric-bridge.mjs` with Claude Code and Codex CLI. Per-client divergence is limited to the JS hook file and install scripts, justified because opencode plugin hooks are in-process JS modules (not shell subprocesses) and the platform has no marketplace install path we can use.
- The `private: true` / npm-publishing-sunset invariant (`project-npm-publishing-sunset`) is honoured: the script-install path is exactly the Hermes pattern, no npm package created.
- Append-only memory, scope-at-service-layer, topic_key convergence, fresh-context judgment: not touched by this change.

Affected dependencies: none. The plugin uses only `@opencode-ai/plugin` types (peer-provided by the opencode runtime, never installed in this repo) and Node/Bun standard library (`Bun.file`, `Bun.spawnSync`, native `fetch`). No new `package.json` entries.
