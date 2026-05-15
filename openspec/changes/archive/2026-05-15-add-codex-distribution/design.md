## Context

Rembric's MCP server is HTTP-only. The Claude Code plugin already solved per-project routing via `plugin/bin/rembric-bridge.mjs` — a stdio↔HTTP shim that reads `PROJECT_SLUG` from `.rembric` in cwd and path-scopes `/mcp/<slug>` at the transport layer. End-users install the plugin via the Claude Code marketplace (`source: "./plugin"`).

Codex CLI exposes the same plugin marketplace primitives, and (per [agentmemory's reference implementation](https://github.com/rohitg00/agentmemory)) honours both:

- `source: "git-subdir"` for marketplace plugins — Codex clones the repo subtree on install, identical to Claude Code's marketplace behaviour.
- `${CLAUDE_PLUGIN_ROOT}` as the plugin-root variable inside hook commands and the shared `mcp.json`.

This change applies the agentmemory pattern: keep one `plugin/` source tree, add a second manifest (`plugin/.codex-plugin/plugin.json`), a Codex-specific hooks file, and a Codex marketplace at the repo root. The Codex install collapses to `codex plugin marketplace add … && codex plugin install rembric` — single-command UX, equivalent to Claude Code.

## Goals / Non-Goals

**Goals:**

- One-command Codex install via the native plugin marketplace, with the same gating (repo SSH/PAT) as the Claude Code plugin.
- Maximum code sharing between Claude Code and Codex distributions: shared `plugin/mcp.json`, shared `plugin/scripts/`, shared `plugin/bin/rembric-bridge.mjs`. The only divergence is the hooks file (different supported event set) and the manifest itself.
- Feature parity in user-perceived behaviour: bridge handles project routing identically, both clients honour `.rembric`, both clients receive a compaction-recovery nudge.
- Preserve the existing Claude Code plugin behaviour unchanged. The Claude Code manifest, hooks file, and scripts remain as-is.

**Non-Goals:**

- Migrating the Claude Code `PreCompact` hook from `type: "mcp_tool"` to `type: "command"` for cross-client parity. Different implementations for the same intent are acceptable; the mcp_tool variant is strictly better when supported.
- Adding a sensitive-flagged `userConfig` for Codex. The plugin manifest schema (per available evidence) does not support it; we document the shell-env fallback instead.
- Publishing a separate `@susomejias/rembric-bridge` npm package. The marketplace install delivers the bundled bridge directly; an extra npm artifact would add release ceremony for no install-time benefit.
- Skills for Codex. Match Claude Code: no skills, protocol via server-side `initialize.instructions`.
- Porting Cursor / Windsurf / Gemini / OpenCode to the marketplace pattern.

## Decisions

### 1. Two manifests, one `plugin/` tree

**Decision.** Sibling `plugin/.claude-plugin/plugin.json` and `plugin/.codex-plugin/plugin.json`. Both reference the same `mcp.json` (shared MCP server config) and the same `scripts/` directory. Hooks differ: `hooks/hooks.json` for Claude Code, `hooks/hooks.codex.json` for Codex.

**Alternatives considered:**

- **Separate plugin trees** (`plugin/claude-code/`, `plugin/codex/`). Rejected: triplicates shared scripts and MCP config, drifts over time. Agentmemory shipped the two-manifest pattern; we follow.
- **One manifest with conditional fields.** Not supported by either marketplace spec.

### 2. Marketplace lives at repo root as `.codex-plugin/marketplace.json`

**Decision.** The Codex marketplace declaration sits at `<repo-root>/.codex-plugin/marketplace.json` (mirroring `<repo-root>/.claude-plugin/marketplace.json`) with `source: "git-subdir"` and `path: "./plugin"`.

**Why git-subdir not local.** `local` requires the user to clone the repo first; `git-subdir` lets Codex clone the subtree on install. Same UX as `claude plugin install`. Earlier we believed `git-subdir` might not be supported — agentmemory's manifest disproves that.

### 3. Codex hooks: four events, command-only

**Decision.** `plugin/hooks/hooks.codex.json` declares four hooks: `SessionStart`, `UserPromptSubmit`, `PreCompact`, `Stop`. All `type: "command"`.

**Why four, not the same as Claude Code's:**

- Claude Code uses `PostCompact` (post-compaction reload nudge). Agentmemory's evidence is that Codex hook engine does not register `PostCompact` for Codex — only the six events `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PreCompact`, `Stop` are honoured. We skip the four `Pre/PostToolUse` events for now (no memory-protocol benefit; reserved for a follow-up if telemetry shows we need them) and skip `PostCompact` (unsupported).
- Claude Code's `PreCompact` uses `type: "mcp_tool"` to call `memory.session_summary` directly. Codex hooks are command-only (no mcp_tool support, per agentmemory's hooks.codex.json which uses only `type: "command"`). We convert `PreCompact` to a stdout nudge script (`pre-compact-codex.sh`).

**Hook scripts:**

- `SessionStart` reuses the existing `plugin/scripts/session-start.sh` (works under Codex because Codex resolves `${CLAUDE_PLUGIN_ROOT}` identically).
- `UserPromptSubmit` reuses `plugin/scripts/prompt-search.sh` with the same matcher pattern.
- `PreCompact` invokes a new `plugin/scripts/pre-compact-codex.sh` — single-line stdout nudge.
- `Stop` invokes a new `plugin/scripts/stop-codex.sh` — single-line session-close reminder.

### 4. Credentials via shell env, not keychain

**Decision.** Codex users export `REMBRIC_SERVER_URL` and `REMBRIC_API_TOKEN` in the shell that launches `codex`. The shared `plugin/mcp.json` carries the existing `${user_config.X}` interpolation — if Codex resolves it, great; if not, the bridge inherits the env vars from the shell.

**Rationale.** Codex's plugin manifest schema does not declare a `userConfig` with `sensitive: true`. We do not introduce a Codex-specific keychain workaround (out of scope). The shell-env path is honest about the asymmetry and is documented in `docs/agents.md`.

**Alternative considered:** writing a `~/.rembric/credentials` config file that the bridge reads if env vars are absent. Adds bridge complexity for one platform asymmetry; deferred unless friction emerges.

### 5. Bridge stays bundled; no separate npm publish

**Decision.** `plugin/bin/rembric-bridge.mjs` is the single source of truth for the bridge. Both Claude Code and Codex plugins reference it via `${CLAUDE_PLUGIN_ROOT}/bin/rembric-bridge.mjs` in the shared `plugin/mcp.json`. No parallel `@susomejias/rembric-bridge` npm package.

**Alternative considered:** publishing the bridge as `@susomejias/rembric-bridge` on GitHub Packages so manual `~/.codex/config.toml` users could `npx -y @susomejias/rembric-bridge@latest`. Rejected — the marketplace install already covers the supported install path, and adding a parallel artifact would have meant multi-package release-please configuration, a separate publish step in CI, and a `~/.npmrc` PAT-setup section in docs. The bridge is ~80 LOC; duplicating its distribution channel for an edge-case fallback is poor leverage.

### 6. `docs/agents.md` keeps a slug-in-URL manual fallback

**Decision.** The Codex section recommends the marketplace plugin install as primary, and documents one manual `config.toml` fallback (raw `transport = "streamable-http"` with slug-in-URL).

**Why only one fallback now.** The npx-based fallback was tied to the abandoned package; removing it leaves only the no-bridge manual flow. Users who want slug auto-resolution use the plugin.

## Risks / Trade-offs

- **[Risk]** `codex plugin marketplace add` and `codex plugin install` are not yet empirically verified in our setup. Agentmemory ships this pattern publicly, so the failure mode is "the command exists but behaves unexpectedly," not "the command doesn't exist." → Mitigation: a manual `codex plugin install` smoke test against a local marketplace pointer is task 4.1 in tasks.md.
- **[Risk]** `${user_config.X}` may not interpolate under Codex's plugin schema (since we don't declare a `userConfig` in the Codex manifest). The bridge would then receive the literal strings as env values and exit-1 with the missing-env message. → Mitigation: the documented env-var fallback works in 100% of cases; we just need clear docs.
- **[Risk]** Codex's hook engine may register hooks for our four events in a way subtly different from Claude Code's. → Mitigation: smoke tests in tasks.md cover SessionStart and PreCompact; UserPromptSubmit/Stop are nudge-only and survive any reasonable engine behaviour.
- **[Risk]** SSH-based `git-subdir` clone may not work as transparently as Claude Code's marketplace clone for private repos. → Mitigation: same SSH key + agent setup that works for `git clone git@github.com:susomejias/rembric.git` should suffice for Codex's marketplace; if not, users can run `git config --global url."git@github.com:".insteadOf "https://github.com/"`.
- **[Trade-off]** Two PreCompact implementations (mcp_tool for Claude, stdout nudge for Codex). Equivalent in intent but not identical in mechanism. → Acceptable: each leverages its platform's strongest primitive. Future change can unify if Codex grows mcp_tool hooks.
- **[Trade-off]** No fallback for users who want slug auto-resolution without the plugin install. → Acceptable: the marketplace install is the supported path; the edge case is uncommon.

## Migration Plan

No data migration. No breaking changes to existing capabilities.

1. Land `plugin/.codex-plugin/plugin.json`, `plugin/hooks/hooks.codex.json`, the two new Codex scripts, and `.codex-plugin/marketplace.json`.
2. Rewrite `docs/agents.md`, `README.md`, `CLAUDE.md`.
3. Validate locally (lint, typecheck, tests, JSON parses).
4. Smoke-test the Codex plugin install path manually.

Rollback: revert the six new files and the doc updates. Claude Code plugin is untouched and unaffected.

## Open Questions

- **Does `${user_config.X}` interpolate in Codex's plugin `mcp.json`?** Resolvable empirically during the smoke test. If yes, no doc tweak needed; if no, docs are already correct (env-var fallback documented).
- **Should we register Codex's `Pre/PostToolUse` hooks?** Agentmemory does (presumably for passive-capture telemetry). Out of scope for v1 — add later if our consolidation worker would benefit from per-tool signal.
- **Should `plugin/scripts/post-compact.sh` get a Codex sibling even though `PostCompact` is unsupported?** No — the script's job (reload context after compaction) is now handled by the PreCompact-nudge instructing the model to call `memory.context` itself.
