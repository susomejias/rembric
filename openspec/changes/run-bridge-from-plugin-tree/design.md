## Context

`own-the-mcp-bridge` (archived 2026-08-15) replaced `mcp-remote` with our own bridge and distributed it as `@rembric/mcp-bridge`, spawned by `npx -y @rembric/mcp-bridge@<pin>`. Its design accepted the tag-versus-publish window (`design.md:164`). Issue #513 measured that window at about 5.5 minutes. PR #556 closes it by serving plugins from a `plugin-release` branch that CI advances after `publish-npm`. That needs a GitHub App, a ruleset, SHA pinning for Hermes and CDN-staleness handling.

Facts this design relies on, measured on 2026-11-22 with isolated config dirs and a probe plugin:

1. **Claude Code 2.1.330** expands `${CLAUDE_PLUGIN_ROOT}` in plugin `mcp.json` args. `node ${CLAUDE_PLUGIN_ROOT}/mcp-bridge/cli.mjs` reports Connected in `claude mcp list`. The child's cwd and `PWD` are the user's project. The official plugins reference documents this exact form (`"args": ["${CLAUDE_PLUGIN_ROOT}/server.js"]`).
2. **Codex 0.163.0** spawns plugin MCP servers at session start, before authentication. With `cwd: "."` the child's cwd is the installed plugin directory (`~/.codex/plugins/cache/<marketplace>/<plugin>/<version>`), so `node ./mcp-bridge/cli.mjs` resolves. `PWD` (forwarded by `env_vars`) is the user's project, and `PATH` is present.
3. Both clients' installed plugin copies already contain `mcp-bridge/` (observed in `~/.claude/plugins/cache/rembric/rembric/<ver>/` and `~/.codex/plugins/cache/rembric/rembric/<ver>/`).
4. The `@rembric/mcp-bridge@0.45.1` tarball is byte-identical to `apps/plugin/mcp-bridge/*.mjs` at that version. The bridge imports only its own modules and `node:` builtins (`dependencies: {}`).
5. **Hermes** `hermes plugins install owner/repo/<subdir>` does a blobless clone with a sparse checkout of that subdirectory only (`hermes_cli/plugins_cmd_git.py:207-252`). `apps/plugin/mcp-bridge/` is therefore never present in a Hermes install.
6. `ancestorChain` (`rembric-host-binding.mjs:65`) skips `npm`/`npx` launchers and shells, then stops at the first other process. With the npx layer gone, the host is the bridge's direct parent and the lookup is unchanged. _This comes from reading the code; it is not measured end to end._

## Goals / Non-Goals

**Goals:**

- No client can install a plugin version whose bridge is unavailable.
- Every existing installation keeps working with or without updating. That covers marketplace, TUI and hand-written configs.
- No plugin depends on an npm publish, while a hand-written stdio setup stays one `npx` line.

**Non-Goals:**

- Changing what the bridge does: project resolution, host binding, transport and 404 recovery are untouched.
- Removing the bridge. Static native HTTP MCP configs cannot compute the per-directory slug, the repository fingerprint or the host session header.
- Pi. It does not spawn the bridge, and `scripts/pi-package.mjs materialize` already copies the bridge modules into `@rembric/pi`.
- Unpublishing any version from npm.
- Reconciling the pre-existing stale prose in `claude-code-plugin` (`## MCP server declaration` names `bin/rembric-bridge.mjs`) and the contradictory opencode requirement `Install script auto-configures opencode.json`. These are noted as archive-time hand edits in tasks.

## Decisions

### D1. Marketplace clients run the bridge from the installed plugin copy

Claude: `command: "node"`, `args: ["${CLAUDE_PLUGIN_ROOT}/mcp-bridge/cli.mjs"]`, same `env` block. Codex: `command: "node"`, `args: ["./mcp-bridge/cli.mjs"]`, keeping `cwd: "."` and `env_vars` (`PWD` stays essential, fact 2). The bridge and the manifest that launches it now come from the same commit, so the race cannot occur.

Alternatives considered: the `plugin-release` branch (PR #556), rejected for its operational cost (GitHub App, ruleset, owner prerequisites, global-only rollback). Reordering publish steps, rejected because it narrows the window without closing it. A fallback to an older bridge, rejected because it defeats exact versioning. An `npm`-type marketplace source, rejected because Claude reports version `unknown` for it and it does not cover Codex.

### D2. The TUI places the bridge in `~/.config/rembric/bin/` for opencode and Hermes

That directory is already the documented second install destination for opencode, and it already holds `rembric-project.mjs` and `rembric-dotenv.mjs`. The installer adds `cli.mjs`, `bridge.mjs`, `slug.mjs` and `rembric-host-binding.mjs`, fetched from the same ref as the client's other files. The bridge's relative imports then resolve inside one directory. Files are written to a temporary name and renamed, so an interrupted download never leaves a half-written `cli.mjs`.

Alternative considered: a separate `~/.config/rembric/mcp-bridge/`. Rejected because it would duplicate two modules opencode already fetches, for no isolation benefit.

### D3. opencode's hook switches only when the bridge is present

The hook sets `mcp.rembric.command = ['node', '<home>/.config/rembric/bin/cli.mjs']` only when that file exists. When it does not exist, the hook leaves an existing `command` untouched, does not create an entry, and logs a one-line hint to re-run the installer. `MCP_BRIDGE_VERSION` and its release carrier are deleted.

Alternative considered: keep the unconditional overwrite. Rejected because a partially failed install would replace a working `npx` command with a missing file.

### D4. Hermes migrates only blocks the installer wrote

`migrate_legacy_mcp_config` already rewrites two recognised shapes (the `mcp-remote` block and the incomplete pinned block). It gains a third: the complete block it writes today (`command: npx`, `args: ['-y', '@rembric/mcp-bridge@<x.y.z>']`, the three `env` mappings and `enabled: true`, with no other keys). All three now migrate to `command: node`, `args: ['<home>/.config/rembric/bin/cli.mjs']` with the same `env` and `enabled`. The usual one-time backup is taken. Any other shape is left byte-identical and a hint is printed. The migration runs only after the bridge files are in place.

Alternative considered: rewrite any `mcp_servers.rembric` block. Rejected because it would overwrite user customisations, which `Native ownership and conservative state preservation` forbids.

### D5. Uninstall removes the bridge only when no remaining client uses it

The bridge needs all six modules: `bridge.mjs` imports `rembric-project.mjs`, which imports `rembric-dotenv.mjs`, so those two are not opencode-only files. One rule covers both uninstalls: the bridge files are removed only when opencode's plugin file is absent and Hermes's `config.yaml` does not reference `~/.config/rembric/bin/cli.mjs`. Hermes's uninstall preserves the `mcp_servers.rembric` block as an operator setting, so the files stay while that block names them and the block keeps working, as a leftover `npx` block does today. The uninstall report names what was kept.

Alternative considered: remove the files with the last client and leave the block. Rejected because it would leave an MCP entry pointing at a deleted file.

### D6. Keep publishing the bridge for hand-written configs

`@rembric/mcp-bridge` keeps being published on every plugin release, exactly as before: the `publish-npm` job, `scripts/mcp-bridge-package.mjs assert-pack`, the `files` allowlist and the `mcp-bridge/package.json` version carrier all stay. The two `mcp.json` JSONPath carriers go away with the pins, because neither manifest names a version any more. No plugin spawns the published package, so its publish time no longer matters to any plugin. It exists for configurations written by hand: stdio-only clients and Hermes configured without the TUI use `npx -y @rembric/mcp-bridge@<version>`. The docs show that form with an exact-version placeholder, never a floating tag.

Alternative considered: stop publishing and deprecate the package once a release with this change is verified. Rejected by the owner: a manual stdio setup would need six downloaded files instead of one `npx` line, and existing `npx` installs would freeze at the last published version. Keeping it costs one publish step and one pack assertion that already exist.

### D7. A frozen copy of the 0.45.1 bridge guards the server contract

Installs that never update keep an old bridge while the server moves on. The bridge forwards JSON-RPC verbatim, so tool changes do not affect it; it depends only on the `/mcp` endpoints and protocol version, `POST /api/repositories/resolve`, the two `X-Rembric-*` request headers and bearer auth. The server has no minimum-bridge-version check, so a breaking change there would surface as an unexplained connection or project error. The six `.mjs` files of `@rembric/mcp-bridge@0.45.1` (the last version published before the plugins stopped spawning the package, so the version installs that never update keep running) are committed under `apps/web/src/test/fixtures/mcp-bridge-0.45.1/` with a checksum manifest taken from the npm tarball. A test spawns that fixture as a subprocess against a server started from the current tree and drives `initialize`, `tools/list`, a `tools/call`, and a fingerprint-resolved connection. The fixture directory is excluded from ESLint and Prettier (the invariant scans pass with it present), and a checksum assertion keeps it from being edited.

Alternatives considered: fetch the tarball from npm in CI, rejected because tests must run offline and the repository denies install-time network by default. A server-side minimum-version refusal, rejected because it makes the break explicit without preventing it. Testing only the current bridge, rejected because the current bridge changes together with the server and so proves nothing about old installs.

### D8. No user is required to migrate

Every switch to the `node` form rides on an update the user already performs, and never on a separate step:

- Claude Code and Codex: the plugin update replaces `mcp.json` and the bridge files together.
- opencode: the installer that replaces `rembric.ts` is the one that places the bridge. `rembric.ts` already cannot load without the libraries that installer puts in `~/.config/rembric/bin/`, so the plugin never had a mode that works without it. The installer writes `rembric.ts` last, after every bridge file is in place.
- Hermes: the TUI update that already rewrites the MCP block is the one that places the bridge and migrates it.

An install that skips the update, or updates by a path that does not touch the MCP entry (`hermes plugins update`, a hand-written config), keeps its `npx` entry. That entry keeps resolving from npm, where the package is still published, and keeps working against newer servers under D7. No code path removes or disables a working `npx` entry without a working replacement in place, and nothing in the server refuses an old bridge.

Alternative considered: have new plugin versions refuse to start until the user migrates. Rejected because users who do not migrate would lose memory for no benefit to them.

## Risks / Trade-offs

- [Trade-off] The server's bridge-facing surface can only grow. → Accepted; it is small, and a deliberate break stays possible through an OpenSpec change that names the versions it breaks.

- [Risk] Hand-written `npx -y @rembric/mcp-bridge@<version>` configs track npm as before: they run the exact version they name until their owner bumps it, and a future server change could stop supporting an old one. → Mitigation: D7 keeps the server compatible with released bridges, and the bridge's existing advisory version check still runs.
- [Risk] A hand-written Hermes block identical to the one the installer used to write cannot be told apart from it, so a TUI update migrates it to the `node` form. → Accepted: the result is equivalent, a backup is taken, and any other shape is left untouched.
- [Risk] A Codex release could stop setting the MCP child's cwd to the plugin directory. → Mitigation: the e2e real-client layer probes Codex on every installer or distribution change. The bridge also fails loudly ("Cannot find module"), not silently.
- [Risk] The Hermes or opencode bridge download fails half-way. → Mitigation: D2's write-then-rename, D3's presence check, and a Hermes migration that runs only after a complete download.
- [Trade-off] Hermes and opencode now depend on the TUI (or the per-client script) to refresh the bridge. → Accepted because the TUI is already the single install and update path, and it already writes Hermes's MCP pin today.

## Migration Plan

1. Merge. Claude and Codex users get the `node` entry on their next plugin update. Until then their old `npx` pin keeps resolving from npm.
2. TUI update for opencode and Hermes: download the bridge, then switch the hook or migrate the config block.
3. Verify the released plugin end to end (tasks section 7), and confirm after the release that each client's MCP server connects at once (task 8.1).
4. Rollback: revert the commit and ship a new plugin release. The restored `npx` pins name versions that keep being published, so they resolve as before.

## Open Questions

None.
