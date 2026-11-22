## Why

A plugin release becomes installable as soon as its release commit lands on `main`. Every client that spawns the bridge fetches it from npm with `npx -y @rembric/mcp-bridge@<exact version>`, and that version reaches npm minutes later (about 5.5 minutes for `plugin-v0.43.0`, issue #513). In that window a client can install a plugin whose MCP server cannot start. The bridge has no runtime dependencies, its source already ships in the plugin tree, and the npm tarball is byte-identical to those files (measured for `0.45.1`). Running the shipped files instead of the published package removes the window at its root: the bridge then arrives in the same commit as the plugin that launches it. That also lets the repository stop publishing a second npm package. PR #556 solved the same race with a CI-moved `plugin-release` branch, a GitHub App and a ruleset; this change supersedes it with less machinery.

## What Changes

- Claude Code's `.claude-plugin/mcp.json` spawns `node ${CLAUDE_PLUGIN_ROOT}/mcp-bridge/cli.mjs` instead of `npx`. Measured on Claude Code 2.1.330: the server reports Connected, and cwd and `PWD` are the user's project.
- Codex's `.codex-plugin/mcp.json` spawns `node ./mcp-bridge/cli.mjs` with its existing `cwd: "."`. Measured on Codex 0.163.0: cwd is the installed plugin cache directory, `PWD` is the user's project, and `PATH` is present.
- The TUI installer downloads the bridge files to `~/.config/rembric/bin/` for opencode and Hermes, from the same ref as the rest of that client's files. opencode already fetches two of the six modules there.
- opencode's config hook points `mcp.rembric.command` at `node ~/.config/rembric/bin/cli.mjs` only when that file exists. If it is missing, an existing command stays untouched.
- Hermes: `hermes plugins install` sparse-checks out only `apps/plugin/.hermes-plugin`, so the plugin never receives `mcp-bridge/`. The TUI update migrates the `mcp_servers.rembric` blocks the installer itself wrote (including today's `npx` form) to `command: node` with the downloaded `cli.mjs`. Blocks it does not recognise are left untouched. The post-install guidance prints the `node` form.
- **BREAKING (distribution):** `@rembric/mcp-bridge` is no longer published. The `publish-npm` job keeps publishing `@rembric/pi` only. The bridge's `package.json` becomes `private: true`, and the two `mcp.json` pin carriers are removed from release-please `extra-files`. Versions already on npm stay installable, so existing hand-written `npx` configs keep working on the version they name.
- After the first plugin release that contains this change has been released and verified, the owner deprecates the package with `npm deprecate @rembric/mcp-bridge "use the Rembric installer"`.
- Docs (`CLAUDE.md`, plugin and client READMEs, `docs/agents.md`, the plugin-development and installer skills) drop the `npx` bridge instructions. The only hand-written `npx` config the docs prescribe is Hermes's `mcp_servers.rembric` block (`docs/agents.md:405`, `apps/plugin/.hermes-plugin/README.md:56`), and it becomes the `node` form.
- The no-plugin HTTP setups (`docs/agents.md` "Claude Code (plain JSON, if not using the plugin)", "Codex CLI (manual config.toml, no plugin)", the HTTP block in "Any other MCP client", ChatGPT) connect directly over Streamable HTTP with a URL and a bearer and are untouched. The one exception is the stdio-only sentence in "Any other MCP client", which prescribed `npx -y @rembric/mcp-bridge@<exact-version>`: it becomes the `node <dir>/cli.mjs` form, and an existing `npx` entry keeps working on the version it names.
- The server surface a released bridge depends on (the `/mcp` endpoints, `POST /api/repositories/resolve`, the `X-Rembric-Repo-Fingerprint` and `X-Rembric-Session` headers, bearer auth) becomes an explicit backward-compatibility contract. A frozen copy of the last published bridge (`0.45.1`) runs against the current server in CI, so a server change that would break installs still on an older bridge fails before merge. The server has no minimum-bridge-version check today, so nothing else would catch it.
- Closes #513. PR #556 and its OpenSpec change `serve-plugins-from-release-ref` are superseded and are not merged.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `mcp-bridge`: the bridge is a zero-dependency set of files shipped in the plugin tree and run with `node`. It is no longer a published package, and the exact-pin rule for spawn sites is removed.
- `claude-code-plugin`: the MCP server declaration spawns the plugin-local bridge. The manifest pin requirement is removed.
- `codex-distribution`: the Codex MCP entry spawns the plugin-local bridge relative to the plugin cache directory.
- `opencode-plugin`: the config hook spawns the downloaded bridge. The install and uninstall scripts download and remove the bridge files.
- `hermes-agent-plugin`: the `mcp_servers.rembric` entry spawns the downloaded bridge. The migration recognises the installer's own `npx` blocks, and the docs drop `npx`.
- `tui-installer`: install and update fetch the bridge files for opencode and Hermes. Uninstall removes them only when no remaining client uses them.
- `open-source-distribution`: the release identity and release-please carriers no longer include a published bridge or the `mcp.json` pins. `publish-npm` publishes `@rembric/pi` only.
- `supply-chain-hygiene`: the published-package estate is one package, `@rembric/pi`. The zero-dependency rule for the bridge moves to `mcp-bridge`.
- `mcp-api`: the server surface used by released bridges is a backward-compatibility contract, enforced by a frozen-bridge test.
- `development-environment`: the lint and coverage paths name the bridge workspace, not a published package.

## Impact

- Client manifests: `apps/plugin/.claude-plugin/mcp.json`, `apps/plugin/.codex-plugin/mcp.json`.
- opencode: `apps/plugin/.opencode-plugin/plugin.ts` (config hook, `MCP_BRIDGE_VERSION`), `apps/plugin/.opencode-plugin/install.sh`, `apps/plugin/.opencode-plugin/uninstall.sh`.
- Hermes and the TUI: `apps/plugin/.hermes-plugin/install.sh` (migration and printed block), `apps/plugin/install.sh` (bridge download and conservative removal).
- Bridge package: `apps/plugin/mcp-bridge/package.json` (`private: true`).
- Release: `release-please-config.json` (`extra-files`), `.github/workflows/release-please.yml` (`publish-npm`), `scripts/mcp-bridge-package.mjs` (deleted), `scripts/release-workflow.test.ts`.
- New test and fixture: `apps/web/src/test/released-bridge-contract.test.ts` and `apps/web/src/test/fixtures/mcp-bridge-0.45.1/` (the six published `.mjs` files plus a checksum manifest).
- Tests: `install.test.ts`, `apps/web/src/test/invariants.test.ts` (pin invariants), `apps/plugin/.hermes-plugin/tests/`, and the opencode plugin tests.
- Docs: `CLAUDE.md`, `apps/plugin/README.md`, `apps/plugin/mcp-bridge/README.md`, `apps/plugin/.opencode-plugin/README.md`, `apps/plugin/.hermes-plugin/README.md`, `docs/agents.md`, `.agents/skills/rembric-plugin-development/`, `.agents/skills/rembric-tui-installer/`.
- npm registry (owner action): `@rembric/mcp-bridge` is deprecated after release. No version is unpublished.
- No server, database or durable memory invariant is touched: append-only memory, scope at the service layer, `topic_key` and judgment freshness are all unaffected.
