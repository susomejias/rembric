## Why

A plugin release becomes installable as soon as its release commit lands on `main`. Every client that spawns the bridge fetches it from npm with `npx -y @rembric/mcp-bridge@<exact version>`, and that version reaches npm minutes later (about 5.5 minutes for `plugin-v0.43.0`, issue #513). In that window a client can install a plugin whose MCP server cannot start. The bridge has no runtime dependencies, its source already ships in the plugin tree, and the npm tarball is byte-identical to those files (measured for `0.45.1`). Running the shipped files instead of the published package removes the window at its root: the bridge then arrives in the same commit as the plugin that launches it, and the publish time stops mattering to any plugin. The package keeps being published, for configurations written by hand. PR #556 solved the same race with a CI-moved `plugin-release` branch, a GitHub App and a ruleset; this change supersedes it with less machinery.

## What Changes

- Claude Code's `.claude-plugin/mcp.json` spawns `node ${CLAUDE_PLUGIN_ROOT}/mcp-bridge/cli.mjs` instead of `npx`. Measured on Claude Code 2.1.330: the server reports Connected, and cwd and `PWD` are the user's project.
- Codex's `.codex-plugin/mcp.json` spawns `node ./mcp-bridge/cli.mjs` with its existing `cwd: "."`. Measured on Codex 0.163.0: cwd is the installed plugin cache directory, `PWD` is the user's project, and `PATH` is present.
- The TUI installer downloads the bridge files to `~/.config/rembric/bin/` for opencode and Hermes, from the same ref as the rest of that client's files. opencode already fetches two of the six modules there.
- opencode's config hook points `mcp.rembric.command` at `node ~/.config/rembric/bin/cli.mjs` only when that file exists. If it is missing, an existing command stays untouched.
- Hermes: `hermes plugins install` sparse-checks out only `apps/plugin/.hermes-plugin`, so the plugin never receives `mcp-bridge/`. The TUI update migrates the `mcp_servers.rembric` blocks the installer itself wrote (including today's `npx` form) to `command: node` with the downloaded `cli.mjs`. Blocks it does not recognise are left untouched. The post-install guidance prints the `node` form.
- `@rembric/mcp-bridge` keeps being published to npm on every plugin release, from the same files the plugins ship, with the same provenance, pack assertion and version carrier as today. No plugin depends on it any more: it exists for hand-written configs, the stdio-only clients and Hermes configured without the TUI, which use `npx -y @rembric/mcp-bridge@<version>`. It is not deprecated.
- The two `mcp.json` pin carriers are removed from release-please `extra-files`, because neither manifest names a bridge version any more. `mcp-bridge/package.json` stays a carrier.
- Docs (`CLAUDE.md`, plugin and client READMEs, `docs/agents.md`, the plugin-development and installer skills) describe the plugins running their shipped bridge. Hermes's `mcp_servers.rembric` block (`docs/agents.md`, `apps/plugin/.hermes-plugin/README.md`) shows the `node` form the TUI writes, and the `npx -y @rembric/mcp-bridge@<version>` form as the alternative for Hermes configured by hand without the TUI.
- The no-plugin HTTP setups (`docs/agents.md` "Claude Code (plain JSON, if not using the plugin)", "Codex CLI (manual config.toml, no plugin)", the HTTP block in "Any other MCP client", ChatGPT) connect directly over Streamable HTTP with a URL and a bearer and are untouched. The stdio-only sentence in "Any other MCP client" keeps prescribing `npx -y @rembric/mcp-bridge@<exact-version>`.
- The server surface a released bridge depends on (the `/mcp` endpoints, `POST /api/repositories/resolve`, the `X-Rembric-Repo-Fingerprint` and `X-Rembric-Session` headers, bearer auth) becomes an explicit backward-compatibility contract. A frozen copy of `@rembric/mcp-bridge@0.45.1`, the last version published before the plugins stopped spawning the package, runs against the current server in CI, so a server change that would break installs still on an older bridge fails before merge. The server has no minimum-bridge-version check today, so nothing else would catch it.
- Closes #513. PR #556 and its OpenSpec change `serve-plugins-from-release-ref` are superseded and are not merged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-bridge`: the plugins and the installer run the zero-dependency bridge files shipped in the plugin tree with `node`, and never through `npx`. The bridge is still published, for hand-written configs. The exact-pin rule for spawn sites is removed; documented hand-written `npx` configs keep naming an exact version.
- `claude-code-plugin`: the MCP server declaration spawns the plugin-local bridge. The manifest pin requirement is removed.
- `codex-distribution`: the Codex MCP entry spawns the plugin-local bridge relative to the plugin cache directory.
- `opencode-plugin`: the config hook spawns the downloaded bridge. The install and uninstall scripts download and remove the bridge files. The shared dotenv module is also among the files the installer downloads.
- `hermes-agent-plugin`: the `mcp_servers.rembric` entry the TUI writes spawns the downloaded bridge, and the migration recognises the installer's own `npx` blocks. The docs show the `node` form, and the `npx` form only for a hand-written setup without the TUI.
- `tui-installer`: install and update fetch the bridge files for opencode and Hermes. Uninstall removes them only when no remaining client uses them.
- `open-source-distribution`: the release identity and release-please carriers no longer include the two `mcp.json` pins. `publish-npm` still publishes `@rembric/pi` and `@rembric/mcp-bridge`.
- `mcp-api`: the server surface used by released bridges is a backward-compatibility contract, enforced by a frozen-bridge test.

## Impact

- Client manifests: `apps/plugin/.claude-plugin/mcp.json`, `apps/plugin/.codex-plugin/mcp.json`.
- opencode: `apps/plugin/.opencode-plugin/plugin.ts` (config hook, `MCP_BRIDGE_VERSION`), `apps/plugin/.opencode-plugin/install.sh`, `apps/plugin/.opencode-plugin/uninstall.sh`.
- Hermes and the TUI: `apps/plugin/.hermes-plugin/install.sh` (migration and printed block), `apps/plugin/install.sh` (bridge download and conservative removal).
- Release: `release-please-config.json` (the two `mcp.json` `extra-files` entries removed, with `scripts/release-please-jsonpath.test.ts`). `.github/workflows/release-please.yml`, `scripts/mcp-bridge-package.mjs` and `apps/plugin/mcp-bridge/package.json` keep publishing the bridge unchanged.
- New test and fixture: `apps/web/src/test/released-bridge-contract.test.ts` and `apps/web/src/test/fixtures/mcp-bridge-0.45.1/` (the six published `.mjs` files plus a checksum manifest).
- Tests: `install.test.ts`, `apps/web/src/test/invariants.test.ts` (pin invariants), `apps/plugin/.hermes-plugin/tests/`, and the opencode plugin tests.
- Docs: `CLAUDE.md`, `apps/plugin/README.md`, `apps/plugin/mcp-bridge/README.md`, `apps/plugin/.opencode-plugin/README.md`, `apps/plugin/.hermes-plugin/README.md`, `docs/agents.md`, `.agents/skills/rembric-plugin-development/`, `.agents/skills/rembric-tui-installer/`.
- No server, database or durable memory invariant is touched: append-only memory, scope at the service layer, `topic_key` and judgment freshness are all unaffected.
