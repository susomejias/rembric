## Why

Rembric exposes ~20 MCP tools today, but adoption depends on each user remembering to call them. The current contract is:

- Edit `.mcp.json` by hand with URL + bearer token in plaintext.
- Rely on the agent to "remember the protocol" — call `memory.save` proactively, `memory.search` on recall keywords, `memory.session_summary` before closing, etc.
- The "protocol-injection" trick today is piped through engram's `SessionStart` hook (an external memory system reminding Claude to use Rembric).

A Claude Code plugin turns Rembric from "MCP server the user activates manually" into "memory layer that lives inside Claude Code":

- **Single-command install** replaces hand-editing `.mcp.json` and supplying a bearer token in plaintext.
- **`SessionStart`, `PreCompact`, `PostCompact`, `UserPromptSubmit` hooks** make memory ops happen without the model needing to remember them — and survive context compaction, which today silently loses session state.
- **A single, token-efficient skill** documents the protocol so Rembric replaces (not coexists with) engram/agentmemory.
- **Automatic project-identity resolution** at the first turn of a session, without relying solely on collision-prone basename derivation.

The plugin is the productization of Rembric's vision: a self-hosted, self-sufficient memory layer the author controls end-to-end, without depending on external memory systems.

## What Changes

This change introduces the Claude Code plugin distribution for Rembric, packaged in this monorepo and installable via private git-subdir marketplace.

- **New `plugin/` subdirectory** containing the plugin manifest, MCP server declaration, single skill, four commands, four hooks, and supporting scripts. Self-contained — does not import from `src/`.
- **New `.claude-plugin/marketplace.json` at the repo root** declaring one plugin entry with a `git-subdir` source. Teammates with repo access install via `claude plugin marketplace add git@github.com:susomejias/rembric.git` followed by `claude plugin install rembric@rembric`.
- **User-config at install time**: `server_url` (required string), `api_token` (required string, `sensitive: true` so it goes to keychain). No project slug field — derivation happens automatically.
- **One skill `rembric-memory`**: protocol guidance + first-turn project resolution (manifest files first, git optional, basename fallback). Tight token budget: ≤35 tok always-on description, ≤500 tok on-invoke body.
- **Four commands** under `/rembric:*` namespace — `remember`, `recall`, `context`, `summary`. Bodies are 1–3 lines, ≤10 tok each in the listing.
- **Four hooks** with disciplined output: `SessionStart` (preload context, ≤200 tok cap), `UserPromptSubmit` (matcher on recall keywords, ≤150 tok cap), `PreCompact` (calls `memory.session_summary` as side effect, no stdout), `PostCompact` (preload, ≤150 tok cap).
- **Total always-on budget**: ≤75 tokens of plugin overhead added to each turn, in addition to the MCP tool listings the user already pays for today.

## Out of scope

- **Stdio→HTTP bridge for slug resolution.** Considered and rejected: the on-invoke cost of doing slug resolution in the skill body (~80 tok once per session) is below the maintenance cost of bundling a transport-layer proxy with cross-platform concerns. Re-evaluable as opt-in v2 if collision rates demand it.
- **Bundling Rembric server (stdio mode) inside the plugin.** Path-traversal limits in the plugin cache make this awkward, and the multi-client design (Codex, Hermes, etc. share the same self-hosted server) is more valuable than zero-setup install.
- **Coexistence with engram/agentmemory.** Rembric is the single memory layer in the author's setup; the plugin replaces these systems, not integrates with them. No "prefer Rembric over X" disclaimers in any prompt content.
- **A public plugin marketplace.** Audience for v1 is the author + close teammates with repo access. Open-sourcing the plugin via `git subtree split` is a future option, not a constraint on this change.
- **Additional agents, themes, output styles, or monitors.** The 1-skill + 4-command + 4-hook catalog is the design target; expansion is a future change.
- **Server-side changes to `deriveSlugFromUri`.** A smarter server-side slug derivation is a possible future improvement but explicitly out of scope here. The plugin is purely client-side configuration + prompt content.

## Capabilities

### New Capabilities

- `claude-code-plugin`: a Claude Code plugin distribution that bundles Rembric's MCP server config, memory-usage skill, slash commands, and lifecycle hooks. Defines the manifest contract, the slug resolution algorithm executed by the agent at first turn, and the hook output discipline.

### Modified Capabilities

None. The plugin is a new external surface; `mcp-api`, `memory`, `projects`, `sessions`, `auth`, `consolidation`, `dashboard`, and `persistence` remain unchanged.

## Impact

- **New directory tree** under `plugin/` and `.claude-plugin/marketplace.json` at the repo root. Nothing under `src/`, `dist/`, or existing capability specs is modified.
- **Token cost to plugin users**: ≤75 tokens always-on per turn, plus disciplined hook output capped at ≤150–200 tok per fire. Net win vs. current setup where the protocol is injected as a ≥500 tok `SessionStart` block from an external memory system.
- **No changes to `src/`**. The server, dashboard, CLI, and consolidation pipeline are untouched.
- **New release lane**: the plugin is versioned independently of the npm package via git tags (`claude plugin tag --push`). Release-please continues to manage the npm publish; plugin updates are tag-driven and decoupled.
- **Validation gaps before implementation**: two contract details need short spikes (≤30 min total) — (1) does the `mcp_tool` hook type return its tool result to the model, or only fire as a side effect; (2) is `${user_config.api_token}` interpolable inside `headers.Authorization` in a plugin-supplied `.mcp.json`. Both have low-cost fallbacks (`command` + curl wrappers, or env-based token passing) but resolving them up front avoids rework.
