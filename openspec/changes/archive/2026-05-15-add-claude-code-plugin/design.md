## Context

Rembric's MCP server is well-developed: ~20 tools, append-only schema with tombstones, scope resolution that combines URL path-slug, MCP `roots/list` discovery, and an in-memory session router. But its adoption pattern is hand-rolled: edit `.mcp.json`, paste a bearer token, hope the agent uses the tools. Engram-style "ALWAYS ACTIVE protocol" injection is the de-facto workaround, but in this repo it's an external dependency reminding Claude to use Rembric — exactly the kind of cross-product entanglement the project was built to avoid.

A Claude Code plugin is the right shape for the next step:

- The plugin manifest format is stable (manifest at `.claude-plugin/plugin.json`, components auto-discovered at conventional paths).
- Plugins ship MCP server config, so installation eliminates the manual `.mcp.json` step.
- Plugins ship hooks, which make lifecycle-driven memory ops possible without depending on agent obedience.
- Plugins ship skills with on-invoke bodies, which let us encode the proactive-save protocol without paying its full token cost on every turn.

### Architecture at a glance

```
┌────────────────────────────────────────────────────────────────────┐
│  Claude Code (CLI / IDE / Web)                                     │
│                                                                    │
│  ┌──────────────────────────────────────────────────────────────┐  │
│  │  rembric plugin (installed via marketplace)                  │  │
│  │                                                              │  │
│  │  manifest (.claude-plugin/plugin.json)                       │  │
│  │  · userConfig: server_url, api_token (sensitive → keychain)  │  │
│  │  · mcpServers: ./mcp.json (type=http, path-less /mcp)        │  │
│  │  · skills: rembric-memory                          (1)       │  │
│  │  · commands: remember, recall, context, summary    (4)       │  │
│  │  · hooks: SessionStart, UserPromptSubmit,                    │  │
│  │           PreCompact, PostCompact                  (4)       │  │
│  └──────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────┬───────────────────────────────┘
                                     │ MCP over HTTPS (Streamable)
                                     │ Authorization: Bearer <api_token>
                                     ▼
                  ┌───────────────────────────────────┐
                  │  Rembric server (self-hosted)     │
                  │  · /mcp + /mcp/<slug>             │
                  │  · /dashboard                     │
                  │  · roots-derived project          │
                  │    activation (fallback path)     │
                  └───────────────────────────────────┘
```

### Distribution and install

The plugin lives in `plugin/` inside this monorepo. A `.claude-plugin/marketplace.json` at the repo root declares one entry whose `source` is `{ type: "git-subdir", path: "plugin" }`. Teammates install with:

```
claude plugin marketplace add git@github.com:susomejias/rembric.git
claude plugin install rembric@rembric
```

The repo can stay private — git auth uses each teammate's own SSH key or PAT, the same credentials they use for `git clone`. No registry, no packaging step.

For iteration, the author installs locally with `claude plugin install --plugin-dir ./plugin`, bypassing the marketplace cache so edits are picked up immediately on `/reload-plugins`.

### Token budget

Always-on (added to every turn while the plugin is enabled, on top of the MCP tool listings the user already pays for):

```
1 skill description (frontmatter)        ≤  35 tok
4 command listings, ~10 tok each         ≤  40 tok
0 agents                                     0 tok
─────────────────────────────────────────────────
                                         ≤  75 tok
```

On-invoke (paid only when a component fires):

```
Skill body (rembric-memory)              ≤ 500 tok   once per session, when invoked
SessionStart hook stdout                 ≤ 200 tok   once per session
UserPromptSubmit hook stdout             ≤ 150 tok   per matched prompt
PreCompact hook                              0 tok   side effect; no stdout
PostCompact hook stdout                  ≤ 150 tok   per compaction
```

Compared to engram-style protocol injection (≥500 tok block injected on every `SessionStart`), this is a strict improvement: the always-on cost is capped at ≤75 tok, the bulk loads only when relevant, and protocol guidance is delivered when the agent actually needs it.

## Key design decisions

### Decision 1 — Stdio bridge that reads `.rembric-slug` and path-scopes the URL

**Journey, summarized for posterity.** This decision was made five times during the change. The full back-and-forth is preserved as a record because every reversal was driven by an empirical observation from smoke-testing the plugin against a real Rembric server:

1. **Initially rejected the bridge** in favor of a skill-driven slug derivation algorithm executed by the agent.
2. **Reversed to a Node stdio→HTTP bridge** (`plugin/bin/rembric-bridge.mjs`, ~140 LOC with manifest/git/basename auto-derivation) after smoke testing exposed four failures: hallucinated slugs, sticky `SessionRouter` pins, doubled-URL config typos, and Claude Code not advertising the MCP `roots` capability for plugin-launched servers.
3. **Reversed back to no-bridge with `userConfig.project_slug`** plus per-project override via `.claude/settings.local.json`.
4. **Reversed again** when empirical testing showed that `required: true` plugin user-config values, set globally by the install wizard, are NOT overridable from a project-scoped `.claude/settings.local.json`. The override mechanism does not function for plugin user-config the way it does for ordinary settings keys.
5. **Reversed once more — and this is the final landing** — when even with `.rembric-slug` + `SessionStart` nudge + agent calling `project.use`, smoke testing revealed a server-side bug (separate change `fix-session-scope-resolution`): `memory.context` and four other session-tool handlers ignored the `SessionRouter` pin set by `project.use` and silently returned `scope: "global"`. The bug is real and is fixed in a separate change, but the user observed that the bridge eliminates the need for `project.use` entirely (path-scoping puts the slug in `ctx.project` directly), making the plugin path more robust regardless of whether the server fix is deployed. Going with the bridge here also reduces token cost (no `project.use` round-trip) and matches the same pattern used by the agentmemory project's `@agentmemory/mcp` stdio shim.

**Final design.** The plugin ships a minimal stdio→HTTP bridge (`plugin/bin/rembric-bridge.mjs`, ~80 LOC):

- The bridge reads `.rembric-slug` from `CLAUDE_PROJECT_DIR` (or `process.cwd()` as fallback) and validates it against the Rembric slug regex.
- If valid, the URL is constructed as `${REMBRIC_SERVER_URL}/mcp/<slug>` (path-scoped). The server pins the project on connect via `ctx.project`.
- If `.rembric-slug` is absent or invalid, the bridge writes a stderr diagnostic and falls back to path-less `${REMBRIC_SERVER_URL}/mcp`. The session still works; the agent operates in global scope until something else pins a project.
- All MCP wire-protocol handling is delegated to `npx -y mcp-remote@latest`. The bridge is a thin URL-building entrypoint, not a protocol parser.

```
.rembric-slug (one line, the slug)
       │
       ▼
rembric-bridge.mjs reads it at MCP-session-start →
constructs URL = ${server_url}/mcp/<slug>
       │
       ▼
npx mcp-remote ${URL} --header "Authorization:Bearer ${token}"
       │
       ▼
Rembric server sees path-scoped /mcp/<slug>; auth populates
ctx.project; every tool call uses that project deterministically.
No project.use round-trip from the agent, no router-fallback codepath.
```

**Why the bridge is the right call given everything we learned:**

- **No agent-side `project.use` round-trip** → ~50 tokens saved per session, plus eliminates the obedience risk of nudging the model to call a specific tool first.
- **No dependency on the server-side router-fallback fix.** Even if a Rembric server is running an older build without `fix-session-scope-resolution`, the plugin works correctly because path-scoping puts the project in `ctx.project`, which all handlers already honor.
- **Bounded surface** (~80 LOC + one `npx`-resolved dependency). `mcp-remote` is the same package agents and tools across the MCP ecosystem use to bridge stdio↔HTTP; we are not inventing wire-protocol code.
- **Per-directory file** is the user's chosen mechanism for slug selection — explicit, gitignorable or committable, easy to inspect.
- **Bridge fallback is graceful**: missing `.rembric-slug` → path-less `/mcp`, session still functional.

**Costs accepted:**

- One bridge process per MCP session (~30 MB residence; spawned once, dies with the session).
- First-launch latency of 5–15 s on a fresh machine while `npx` downloads `mcp-remote`. Subsequent launches are instant from the npx cache.
- Node 18+ on PATH (already a Claude Code requirement).
- A `bin/` directory inside the plugin that did not exist in earlier iterations.

**What the bridge does NOT do:**

- It does not auto-derive a slug from `package.json`, `git`, or filesystem inspection. The user is explicit via `.rembric-slug`.
- It does not parse or modify MCP frames. Bytes flow through `mcp-remote` unchanged.
- It does not handle authentication beyond injecting the `Authorization: Bearer <token>` header.

**The server-side `scopeFromContext` fix** (separate change `fix-session-scope-resolution`) is still valid and shipped. It corrects a genuine invariant violation that affects any client doing path-less `/mcp` + `project.use`. The bridge sidesteps the bug for the plugin path but the fix benefits any other MCP client (Codex, Cursor, custom integrations) that uses path-less connections.

### Decision 2 — Slug is user-chosen, written to `.rembric-slug`

Users place a single-line `.rembric-slug` file in each project's root containing the slug they want Rembric to scope memory to for that directory. There is no auto-derivation, no userConfig form field, no manifest inspection.

**Format requirements (enforced on the server side already):**

- Must match `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$`.
- Lowercase letters, digits, hyphens only. Maximum 64 characters.

**File-level conventions:**

- One line, just the slug. Trailing whitespace and `\r\n` line endings are stripped by the hook.
- Lives at `${CLAUDE_PROJECT_DIR}/.rembric-slug` (or `${PWD}/.rembric-slug` for non-Claude clients).
- Treated as project-local config. Commit it for team-shared scope or gitignore it for personal scope.
- Absence is allowed: the plugin still works, but the agent has no specific slug to pin and operations may fall back to global scope.

**Recommended patterns** (in plugin docs, not enforced):

- GitHub repo `acme/foo` → `acme-foo` (disambiguates from other `foo` repos).
- Internal single-name product → `my-app`.
- Generic-looking project → add a qualifier (`notes-personal`, `docs-team`).
- Monorepo subprojects → one slug per subproject (`acme-foo-frontend`, `acme-foo-api`).

**Bootstrap for new slugs.** If the slug in `.rembric-slug` points to a Rembric project that does not yet exist, the agent — guided by the `SessionStart` nudge that explicitly includes `create: true` — creates the project on the first `project.use` call. One round-trip on first use, then steady-state operation.

### Decision 3 — Hook event selection and types

| Event              | Hook type                                                                        | Output discipline                                   |
| ------------------ | -------------------------------------------------------------------------------- | --------------------------------------------------- |
| `SessionStart`     | `command` (`plugin/scripts/session-start.sh`)                                    | stdout: ~20 tok one-line nudge prefixed `[rembric]` |
| `UserPromptSubmit` | `command` with matcher `remember\|recall\|acordate\|qué hicimos\|what did we do` | stdout: ~20 tok one-line nudge                      |
| `PreCompact`       | `mcp_tool` (`memory.session_summary` with `auto: true`)                          | side effect; no stdout to model                     |
| `PostCompact`      | `command` (`plugin/scripts/post-compact.sh`)                                     | stdout: ~20 tok one-line nudge                      |

**Implementation refinement — nudges, not fetchers.** The original proposal sketched `command` hooks that would `curl` Rembric and return formatted memory results (capped ≤150–200 tok). During implementation this was simplified: the MCP wire protocol (Streamable HTTP with handshake and `mcp-session-id` headers) is awkward to invoke from a bash + curl script, and the auto-fetched results would have cost 7× more tokens than a one-line nudge that tells the agent which tool to call. The skill already documents the protocol; the hooks just provide the contextual reminder at exactly the right moment.

This trade-off:

- 7× cheaper per fire (~20 tok vs ~150 tok).
- Zero MCP client code inside the plugin → no version coupling with the SDK.
- Cost: one extra `memory.context` / `memory.search` tool call from the agent in the same turn. Acceptable.

The `PreCompact` hook still uses `mcp_tool` because the agent never sees the result anyway — it's a pure side-effect call to persist the session summary before context is dropped. If a future Claude Code version drops `mcp_tool` semantics, the fallback is a `command` hook that nudges the agent to call `memory.session_summary` itself.

**Why these four, not more:** They cover the lifecycle moments where state is most at risk (compaction, session boundaries) or where the user has signaled intent (recall keywords). `Stop`, `TaskCompleted`, `SubagentStop`, and `CwdChanged` were considered and dropped for v1 to keep the plugin tight; they may return as opt-in if the catalog proves too sparse.

**Failure mode discipline:** Every `command`-type hook script must `exit 0` with empty stdout on any error. A plugin-side failure must never break a Claude Code session. With the nudge approach the only realistic failure is a missing/non-executable script, which the trap on `ERR` plus `exit 0` handle.

### Decision 4 — Token budget enforcement

The always-on cap of ~75 tok is verifiable post-install via `claude plugin details rembric`, which renders the listing-text cost computed by the harness's `count_tokens` API. If a future change pushes the cap up, the validation step in `tasks.md` will fail and force a deliberate reckoning.

On-invoke caps are enforced by the hook scripts themselves (truncating output, capping `limit` parameters) and by the skill author keeping the body under 500 tokens. There is no runtime enforcement, but the smoke test in `tasks.md` records observed costs as a regression baseline.

### Decision 5 — Coexistence is not a goal

The author's setup will remove engram and agentmemory after the plugin ships. The plugin's prompts and commands assume Rembric is the only memory system. No "prefer Rembric over X" disclaimer in the skill, no fallback logic for other systems. This matches the project's positioning: Rembric is the memory layer the author built precisely to avoid depending on external systems.

### Decision 6 — Slug collision is recoverable, not preventable

For projects without manifest files and without git (folders of scripts, notes, legacy non-versioned sites), `basename` collisions can route memories of distinct projects to the same Rembric project. Mitigation:

- The skill includes a guard: if the derived slug feels overly generic (`api`, `notes`, `scripts`), the agent confirms with the user before `create: true`.
- Manual recovery is always available: `project.use({slug: 'foo-personal', create: true})`.
- The dashboard surfaces all projects, making accidental collisions visible.

A server-side fix (smarter `deriveSlugFromUri` using more of the URI than basename, or a stable path hash) is a possible future change but explicitly out of scope here. The plugin sits purely on the client side.

### Decision 7 — `.mcp.json` is path-less, not slug-bound

The plugin declares `url: "${user_config.server_url}/mcp"`, not `/mcp/<slug>`. Path-scoping the URL would require the slug at config-load time, which is impossible without either a bridge (rejected) or a userConfig field per project (unwieldy).

Path-less `/mcp` plus skill-driven `project.use` gives the same end-state (the server's `SessionRouter` pins the project for the connection) without sacrificing config simplicity. The trade-off is that the first turn of a session pays the slug-resolution cost; subsequent turns are free.

## Validation spikes

Two contract details to confirm before implementation. Both are small (~10 min each) and have known fallbacks if they fail:

1. **`mcp_tool` hook output behavior.** Does the result of a tool call from this hook type reach the model as context, or is it consumed silently as a side effect? Test with a stub hook calling `memory.context`; observe whether results land in the next turn's context. Outcome:
   - If preserved → `SessionStart` and `PostCompact` could use `mcp_tool` directly, eliminating the curl scripts.
   - If discarded → keep the current plan (use `command` + curl for context-returning hooks; reserve `mcp_tool` for side-effect-only `PreCompact`).

2. **`${user_config.api_token}` substitution inside `.mcp.json` headers.** The plugin doc states user-config values substitute into MCP server configs; verify this applies to nested `headers.Authorization` strings. Outcome:
   - If supported → ship as designed.
   - If not → pass the token via `env` and read it in a wrapper script that constructs the URL/headers and execs.

Neither outcome blocks the proposal; they affect at most a handful of lines in `mcp.json` and the hook scripts.
