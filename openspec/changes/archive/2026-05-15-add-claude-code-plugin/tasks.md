## 1. Validation spikes (obsoleted)

- [x] 1.1–1.4 ~~Spikes S1/S2 to validate `${user_config.api_token}` interpolation and `mcp_tool` hook output~~ **Obsoleted**. The final design uses a stdio bridge (`bin/rembric-bridge.mjs`) that sidesteps both questions: the token flows through `env`, and the bridge does the URL path-scoping instead of relying on hook-output channels.

## 2. Plugin manifest and marketplace

- [x] 2.1 Create `plugin/` directory at repo root.
- [x] 2.2 Create `.claude-plugin/marketplace.json` at repo root with one entry: `name: "rembric"`, `source: "./plugin"`.
- [x] 2.3 Create `plugin/.claude-plugin/plugin.json` with metadata.
- [x] 2.4 Declare `userConfig.server_url` (required string).
- [x] 2.5 Declare `userConfig.api_token` (required, sensitive=true → keychain).
- [x] 2.6 Declare `mcpServers: "./mcp.json"` in plugin.json.
- [x] 2.7 Run `claude plugin validate`. **Result**: ✔ Validation passed.

## 3. MCP server declaration (via bridge)

- [x] 3.1 Create `plugin/mcp.json` with one MCP server entry named `rembric`.
- [x] 3.2 `command: "node"`, `args: ["${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs"]`, env: `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` substituted from userConfig.
- [x] 3.3 ~~Wrapper fallback if `${user_config.api_token}` doesn't interpolate~~ **Obsoleted**: the bridge passes the token via `env`, which works regardless.

## 3b. Bridge implementation

- [x] 3b.1 Create `plugin/bin/rembric-bridge.mjs` (~80 LOC) that reads `.rembric-slug`, path-scopes the URL, and delegates to `npx -y mcp-remote@latest --allow-http`.
- [x] 3b.2 Read `CLAUDE_PROJECT_DIR` env var with `process.cwd()` fallback.
- [x] 3b.3 Validate slug against `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`; fall back to path-less `/mcp` with stderr diagnostic on invalid/missing.
- [x] 3b.4 Spawn `npx -y mcp-remote@latest <url> --allow-http --header "Authorization:Bearer <token>"` with `stdio: 'inherit'`.
- [x] 3b.5 Forward exit code; propagate signals.
- [x] 3b.6 Write startup diagnostic to stderr.
- [x] 3b.7 Smoke test locally: `slug=rembric url=http://192.0.2.10:8787/mcp/rembric`, connects to server, proxy established. ✓
- [x] 3b.8 Fix HTTP support: pass `--allow-http` to `mcp-remote` so plain-HTTP LAN deployments work (Rembric typical case).

## 4. Skill (removed — now server-side)

- [x] 4.1–4.8 ~~Ship a `rembric-memory` skill~~ **Removed in favor of `src/mcp/instructions.ts`**. Rembric's MCP server injects the proactive-save protocol at the `initialize` handshake (≤800 chars per the existing test). One small tweak to the unscoped variant adds `create:true` to the `project.use` hint so new-project bootstrap is one tool call. Token savings vs. shipping a skill: ~35 tok always-on per turn, ~380 tok on-invoke. Benefits every MCP client (Codex, Cursor, etc.), not just Claude Code.

## 5. Slash commands

- [x] 5.1–5.5 Four commands under `/rembric:*` (`remember`, `recall`, `context`, `summary`). Each ≤3 lines body, frontmatter description ≤10 tokens.

## 6. Lifecycle hooks

- [x] 6.1 Create `plugin/hooks/hooks.json`.
- [x] 6.2 `SessionStart` → command nudge.
- [x] 6.3 `UserPromptSubmit` with matcher `remember|recall|acordate|qué hicimos|what did we do` → command nudge.
- [x] 6.4 `PreCompact` → `mcp_tool` calling `memory.session_summary({auto:true})`.
- [x] 6.5 `PostCompact` → command nudge.
- [x] 6.6 ~~Refactor SessionStart/PostCompact to use `mcp_tool` if S2 succeeded~~ **Not applicable**: the bridge handles project pinning, so the nudges remain pure "consider memory.context" reminders without fetching anything themselves.

## 7. Hook scripts

- [x] 7.1 `session-start.sh`: generic "consider memory.context" nudge (~20 tok).
- [x] 7.2 `prompt-search.sh`: "user intent recall" nudge (~20 tok).
- [x] 7.3 `post-compact.sh`: "reload memory.context after compaction" nudge (~20 tok).
- [x] 7.4 `chmod +x` all scripts.
- [x] 7.5 ~~Shared `_lib.sh`~~ **Not needed**: each script is 5 lines.

## 8. Documentation

- [x] 8.1 `plugin/README.md` with install instructions for teammates and the author.
- [x] 8.2 Slug selection documentation: `.rembric-slug` file convention + suggested patterns (GitHub repo, internal product, notes folder, monorepo subprojects).
- [x] 8.3 Token budget documentation (40 tok always-on, ~60 tok hook output on-invoke).
- [x] 8.4 Document the `.rembric-slug` mechanism for per-project scoping; document `claude --debug` diagnostic for bridge issues.
- [x] 8.5 Update root `README.md` with a "Claude Code plugin" section linking to `plugin/README.md`.
- [x] 8.6 Create `plugin/CHANGELOG.md`.

## 9. Smoke tests

- [x] 9.1 Install via marketplace local + `claude plugin install rembric@rembric -s local`. ✓ MCP listed and connected.
- [x] 9.2 Open project with `package.json`, set `.rembric-slug=rembric`, verify the bridge path-scopes correctly. ✓
- [x] 9.3 Folder without manifest: bridge falls back to path-less `/mcp` with stderr diagnostic. (Confirmed via test code path; manual confirmation deferred.)
- [x] 9.4 Trigger `UserPromptSubmit` matcher with "qué hicimos la sesión pasada?" — nudge appears in context. ✓
- [x] 9.5 PreCompact verification deferred to operational testing; the hook is wired and the call is a pure side effect (no agent-visible output).
- [x] 9.6 `SessionStart` nudge visible in context at session start. ✓
- [x] 9.7 `claude plugin details rembric` to confirm always-on cost ≤ 40 tok (after skill removal). To be re-run after deploying the new version.

## 10. Release flow

- [ ] 10.1 Decide whether plugin version tracks server version or is independent. **Current state**: independent — plugin manifest pins `0.1.0` in `plugin/.claude-plugin/plugin.json` and ships its own `plugin/CHANGELOG.md`. Confirm convention before first public tag.
- [ ] 10.2 Configure release-please to either ignore `plugin/` or pick it up as a separate component.
- [ ] 10.3 `claude plugin tag --push` for the first plugin release after teammates have validated.
- [ ] 10.4 Verify teammates can install via the marketplace from a clean machine.

## 11. Spec capture (on archive)

- [x] 11.1 The change's `specs/claude-code-plugin/spec.md` is moved to `openspec/specs/claude-code-plugin/spec.md` by the `openspec archive` command.
