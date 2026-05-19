## Context

Rembric ships per-client plugins for three agent clients today: Claude Code (marketplace install), Codex CLI (marketplace install), and Hermes Agent (script install). Each implements the same conceptual contract — session lifecycle POSTs to `/api/<slug>/sessions(*)` and an MCP connection scoped to the project — but the platform-specific manifests, hook syntaxes, and runtime mechanics differ. The shared logic doctrine (`CLAUDE.md::Plugin development discipline`, project memory `01KRNZM2VFCME5HNT8N78HZW18`) keeps duplication minimal by hosting `plugin/bin/rembric-bridge.mjs`, `plugin/scripts/*.sh`, and the HTTP API contract once and letting each per-client manifest reference them via `${CLAUDE_PLUGIN_ROOT}` or copy them via install scripts.

opencode (`https://opencode.ai`, `@opencode-ai/plugin`) is the fourth client. Its plugin model is structurally different from all three predecessors: plugins are JS/TS modules loaded from `~/.config/opencode/plugins/` (or `.opencode/plugins/` for project-level), and hooks are async function properties returned from the plugin module — not shell subprocess commands. MCP servers are declared separately in `opencode.json::mcp`, with two transports supported (`type: "local"` for stdio spawn, `type: "remote"` for HTTP). There is no `opencode plugin install <marketplace>` command analogous to Claude or Codex; the documented install paths are (1) `opencode.json::plugin: ["npm-pkg"]` triggering `bun install`, or (2) dropping a file into `~/.config/opencode/plugins/`.

Constraints inherited from the current repo state:

1. **`package.json` is `private: true`**, npm publishing was sunset 2026-05-17 (`project-npm-publishing-sunset` memory). Path (1) — publish to npm — is off the table without a separate OpenSpec change to reopen the sunset. Path (2) — script install — is the only remaining option.
2. **`.rembric` is the single source of truth for project slug** across all three existing clients. `_api.sh::rembric_read_project_slug` (read by shell hooks) and `rembric-bridge.mjs` (read at MCP spawn time) both read `<cwd>/.rembric` and apply the same `^[a-z0-9]([a-z0-9-]{0,62}[a-z0-9])?$` regex. Diverging from this convention for opencode would break the cross-client coherence we have today.
3. **`@opencode-ai/plugin` is not a dependency of this repo**. It is a peer dependency provided by opencode at runtime. The `plugin.ts` file is shipped to the user's `~/.config/opencode/plugins/`, where opencode (via Bun) loads it with access to the runtime types. We never install `@opencode-ai/plugin` in this repo's `node_modules`.

Reference implementations consulted during explore:

- engram's opencode plugin at `https://github.com/Gentleman-Programming/engram/blob/main/plugin/opencode/engram.ts` — single TS file, script install (`engram setup opencode` or manual `cp`), system-prompt injection via `experimental.chat.system.transform`, sub-agent filtering. Most relevant prior art; we copy patterns but not the specifics (engram auto-starts a Go binary; we don't).

## Goals / Non-Goals

**Goals:**

- Ship an opencode plugin that gives opencode users the same Rembric session-lifecycle behaviour Claude Code and Codex CLI users get today (`session.created` → POST `/sessions`, `experimental.session.compacting` → context injection + synthetic boundary).
- Maximise symmetry with Claude/Codex by reusing `plugin/bin/rembric-bridge.mjs` verbatim. Same bridge, same `.rembric` resolution, same path-scoped `/mcp/<slug>` URL construction, same `Authorization: Bearer` header pattern.
- Keep the install footprint minimal: one TS file + one bridge file copied to the user's machine, plus a printed MCP snippet the user pastes into `opencode.json`.
- Avoid requiring a per-project `./opencode.json`. The user's project switching SHALL work with a single global `~/.config/opencode/opencode.json` plus per-repo `.rembric` files — same UX as Claude/Codex.
- Preserve the `package.json::private: true` invariant. No npm publish, no new bin entry, no CLI re-introduction.

**Non-Goals:**

- System-prompt injection via `experimental.chat.system.transform`. The MCP server's `initialize.instructions` already delivers the save/recall protocol to opencode the same way it does to Claude/Codex; injecting again would duplicate the protocol and create drift risk. Re-evaluate ONLY if a follow-up bug report shows opencode losing the `initialize.instructions` block post-compaction.
- Tool-execute-before guards analogous to the OpenClaw `tool-guards.mjs` (blocking writes to `MEMORY.md`). The OpenClaw guard exists because OpenClaw has a competing builtin memory backend; opencode has none. Skipping the guard reduces v1 surface area.
- Auto-merging the MCP snippet into the user's `~/.config/opencode/opencode.json` via `jq`. The install script SHALL print the snippet and stop. The user pastes it, fills in URL+token, restarts opencode. Conservative path, mirrors the Hermes pattern.
- A marketplace.json for opencode. opencode has no marketplace concept; nothing to declare. (`.claude-plugin/marketplace.json` and `.codex-plugin/marketplace.json` continue to exist for their respective clients.)
- Auto-detecting the project slug from git remote (engram's approach). We keep the `.rembric` convention — it is the contract the rest of the codebase reads.

## Decisions

### Decision 1: MCP transport is the existing stdio bridge, not opencode's `type: "remote"`

opencode supports two MCP transports:

- `type: "local"`: opencode spawns a stdio subprocess (`command: ["node", "..."]`) and speaks MCP over stdin/stdout. Equivalent to Claude Code's and Codex CLI's stdio MCP shape.
- `type: "remote"`: opencode opens an HTTP connection to the MCP server URL (`url: "https://..."`), reading `headers` for auth. Native MCP-over-HTTP/SSE.

`type: "remote"` is the simpler option on paper. We have a working `/mcp/<slug>` endpoint; opencode would just connect to it. No bridge needed.

**Why we reject `type: "remote"` for opencode v1:**

The URL in `opencode.json::mcp.rembric.url` is parsed once at opencode startup and used for the lifetime of the opencode process. opencode does not support `${env.*}` substitution in `url`. To path-scope per project we would need either:

- (a) The user maintains a per-project `./opencode.json` whose `mcp.rembric.url` ends in `/mcp/<this-project-slug>`. This adds a second per-repo config file alongside `.rembric` — the user has to keep both in sync, and forgetting one produces silent miscoping.
- (b) A single global `opencode.json` whose `url` is `http://.../mcp` (unscoped), forcing the agent to call `project.use({slug})` per session. The agent doing so reliably is not guaranteed; cross-project leakage becomes possible if the agent forgets.

The stdio bridge sidesteps both problems: `opencode.json::mcp.rembric.command` is fixed, the bridge subprocess reads `.rembric` from its cwd at spawn time, and the path-scoping happens inside the bridge's URL construction. The user maintains one global `opencode.json` and per-repo `.rembric` files — identical UX to Claude Code and Codex CLI.

Trade-off accepted: opencode users pay one extra subprocess spawn per session (the bridge running `npx -y mcp-remote@latest`). Same overhead Claude/Codex users already pay. No new code; we reuse `plugin/bin/rembric-bridge.mjs` literally.

Alternatives considered:

- **Hybrid (Decision A + plugin-managed `project.use`)**: ship `type: "remote"` unscoped, and have the plugin's `session.created` handler programmatically invoke `project.use` via the opencode SDK client. Rejected: the opencode SDK's `client` exposes app-level methods (`client.app.log`, etc.), not MCP-tool invocation against arbitrary MCP servers. A plugin cannot call `project.use` on the agent's behalf; only the LLM can call MCP tools.
- **Two opencode.json profiles, one per project**: instruct users to maintain a per-project `./opencode.json`. Rejected — user pushback in explore mode was explicit: avoid the per-project file if possible.

### Decision 2: Verify `cwd` of the spawned bridge with a spike BEFORE writing plugin code

The bridge's slug resolution depends on `process.cwd() === <user's project repo>` (or one of the higher-priority env vars `CLAUDE_PROJECT_DIR` / `PWD` being set to that directory). Claude Code spawns its MCP subprocesses with the project root as cwd (it sets `CLAUDE_PROJECT_DIR` explicitly). Codex propagates the user's shell `PWD` via `env_vars: [..., "PWD"]`. opencode's behaviour is not documented and not verified.

We will run a manual spike:

1. Build the v1 candidate `plugin.ts` (event handlers, no bridge invocation) plus the candidate `opencode.json::mcp` snippet pointing at `~/.config/rembric/bin/rembric-bridge.mjs`.
2. Place the bridge at the expected path, but temporarily replace its body with a debug line: `console.error('[spike] cwd=', process.cwd(), 'PWD=', process.env.PWD, 'argv=', process.argv);` then `process.exit(0)`.
3. Launch opencode from inside a test repo containing a valid `.rembric`. Trigger an MCP-tool call.
4. Inspect the bridge's stderr (visible in opencode's logs / debug output). Confirm `cwd` or `PWD` resolves to the test repo, not to opencode's binary directory.

**If the spike succeeds** (cwd or PWD is the user's repo): no bridge changes needed. Plan A ships.

**If the spike fails** (cwd is opencode's binary dir, PWD is unset): Plan B kicks in. The plugin SHALL register opencode's `shell.env` hook to inject `REMBRIC_PROJECT_DIR=<ctx.directory>` into every subprocess opencode spawns (including the MCP bridge). The bridge SHALL be extended with one new step at the top of its resolution chain: `REMBRIC_PROJECT_DIR > CLAUDE_PROJECT_DIR > PWD > process.cwd()`. Existing clients (Claude, Codex) never set `REMBRIC_PROJECT_DIR`, so the change is a no-op for them. Documented in spec.md.

This spike is gating: nothing else (proposal-level docs, README updates, plugin.ts beyond the event handler skeleton, install script) ships until the spike result is known. `tasks.md` lists the spike as task 1 of phase 1.

Alternatives considered:

- **Ship Plan A optimistically, fix in v2 if it breaks**: rejected. The bridge silently no-ops if it can't resolve the slug (falls back to `/mcp` unscoped), so a Plan A failure would manifest as "Rembric works in global scope but never sees the project" — silent and confusing. Better to gate on the spike.
- **Always ship Plan B (always inject `REMBRIC_PROJECT_DIR`)**: rejected on simplicity grounds. If opencode already gives us the right cwd, the extra plugin code and bridge code is unnecessary noise.

### Decision 3: Reuse the bridge verbatim; the only optional bridge change is the env-var precedence step

The existing `plugin/bin/rembric-bridge.mjs` has a documented contract (`claude-code-plugin` spec, `MCP bridge contract` section): resolve project dir from `CLAUDE_PROJECT_DIR > PWD > process.cwd()`, read `.rembric`, construct `/mcp/<slug>`, delegate to `npx -y mcp-remote@latest`. Changing this contract would touch all three existing clients.

The only candidate change is Decision 2's Plan B: prepend a `REMBRIC_PROJECT_DIR` step to the precedence chain. This is purely additive — no existing client sets `REMBRIC_PROJECT_DIR`, so they retain their current behaviour. If Plan A succeeds in the spike, no bridge change ships at all.

Alternatives considered:

- **Fork the bridge into `plugin/.opencode-plugin/rembric-bridge-opencode.mjs`**: rejected. Violates the shared-plugin-logic doctrine (`01KRNZM2VFCME5HNT8N78HZW18`). Per-client divergence is only acceptable when the platform forces it; an extra env-var precedence step is not platform divergence — it's additive shared code.

### Decision 3b: Extract dotenv parser + slug regex to a shared module

The first iteration of this change inlined `parseDotenv` and `SLUG_RE` in three places: `plugin/bin/rembric-bridge.mjs` (JS), `plugin/.opencode-plugin/plugin.ts` (TS), and a `plugin/.opencode-plugin/helpers.ts` test mirror (also TS). Three copies of ~30 lines each, kept in lock-step by an invariant test comparing function bodies byte-for-byte.

This is replaced by a single shared module `plugin/bin/rembric-dotenv.mjs` exporting `parseDotenv`, `readRembricSlug`, and `SLUG_RE`. The bridge imports it via the relative path `./rembric-dotenv.mjs` (resolves at runtime against the bridge's installed directory). The opencode plugin imports it via `../bin/rembric-dotenv.mjs` at source time (resolves for `tsc --noEmit` and `pnpm vitest` against the monorepo layout); `install.sh` rewrites that path to the absolute installed location (`$HOME/.config/rembric/bin/rembric-dotenv.mjs`) before copying `plugin.ts` to the user's machine. Bun's ESM resolver in opencode 1.15.x accepts absolute paths — confirmed during the same cwd spike that validated Plan A.

The test mirror (`helpers.ts`) is deleted. `plugin.test.ts` imports the helpers directly from the shared lib. The byte-by-byte invariant test is replaced by a static-grep invariant that fails the build if either `plugin.ts` or `rembric-bridge.mjs` declares a local `parseDotenv` function or `SLUG_RE = /` literal.

Bash (`plugin/scripts/_api.sh`) and Python (`plugin/.hermes-plugin/__init__.py`) keep their own implementations because cross-language wrapping a 20-line parser pays a per-call subprocess spawn that the duplication cost doesn't justify. Those implementations are required to agree on the slug regex value — documented in the new `Shared dotenv lib SHALL be the single source of truth` requirement in `opencode-plugin/spec.md`.

Alternatives considered:

- **Inline at install time** (concatenate helpers.ts + plugin.ts into a single deployed file): rejected. Bridge would still duplicate (only consolidates TS↔TS, leaves JS↔TS divergence). Install.sh becomes more complex (build-step semantics). Debug experience worse ("the file you're editing isn't quite what runs").
- **Keep three copies + byte-by-byte parity invariant** (status quo of first iteration): rejected. 90 lines of duplicated code that mutate together is a perpetual maintenance tax; the lock-step test catches drift but doesn't prevent the developer from having to read three near-identical files when debugging.

### Decision 4: Bridge installation location is `~/.config/rembric/bin/`, NOT `~/.config/opencode/plugins/`

opencode auto-loads every JS/TS file in `~/.config/opencode/plugins/` as a plugin. If we put `rembric-bridge.mjs` in that directory, opencode tries to load it as a plugin too, sees no `Plugin`-compatible export, and either crashes or logs an error. We need a location outside opencode's plugin discovery.

The chosen location is `~/.config/rembric/bin/rembric-bridge.mjs`. Properties:

- Per-user, no sudo needed.
- Outside `~/.config/opencode/`, so opencode never auto-loads it.
- The `~/.config/rembric/` directory is Rembric's first foothold on the user's machine — future Rembric-specific config or assets (e.g., a `~/.config/rembric/install.log`) can live alongside.
- The MCP snippet in the install script's output uses `$HOME/.config/rembric/bin/rembric-bridge.mjs` so the user only edits URL and token, never the bridge path.

Alternatives considered:

- **`/usr/local/lib/rembric/bin/`**: rejected. Requires `sudo`. Friction in install.
- **Adjacent to the plugin file, but with a different extension opencode ignores (e.g. `.mjs.tmpl`)**: rejected. Cryptic; relies on opencode never widening its glob.
- **Inside the plugin file itself (single-file plugin that includes the bridge code inline)**: rejected. The bridge currently delegates to `npx -y mcp-remote@latest` and is invoked as a Node entrypoint by Claude/Codex via `node <path>`. Inlining it into a TS file loaded by Bun would require either calling `Bun.spawn(['node', '-e', '<inlined-source>'])` or rewriting the bridge for in-process MCP transport — both bigger surface than copying one extra file.

### Decision 5: No `SessionEnd` equivalent. Session closure is agent-driven via `memory.session_summary`.

opencode has no event that fires reliably when the user quits or the session is closed. `session.deleted` fires only on explicit user delete from the UI; `session.idle` may fire multiple times during a session whenever the agent is waiting. There is no `Stop` or `SessionEnd` analogue.

The plugin SHALL NOT attempt to call `POST /api/<slug>/sessions/<id>/end` from any opencode event. Session closure relies on:

- The agent voluntarily calling `memory.session_summary({summary, title})` before declaring work done. This is enforced by the MCP server's `initialize.instructions` block, same as Claude/Codex/Hermes.
- The server-side `abandonStale` periodic task flipping sessions stuck in `status='active'` to `'abandoned'` after the inactivity threshold. Same fallback Codex already relies on (per `plugin-session-protocol` spec).

This means opencode sessions where the agent fails to call `memory.session_summary` AND the user doesn't manually compact will stay in `status='active'` until they're stale-flipped. That's an acceptable degenerate state; the dashboard already handles it.

Alternatives considered:

- **Use `session.idle` with a debounce + timeout**: rejected. Idle-based heuristics produce false positives (long thinking turns) and false negatives (user immediately resumes after idle fired). The agent-driven contract is simpler and consistent across clients.
- **Add a "close session" command (`/rembric close` or similar)**: rejected for v1. opencode plugin commands have weak UX (no slash-command equivalent that we've verified), and the agent-driven path covers the common case.

### Decision 6: Sub-agent session filtering is mandatory at v1

opencode's `session.created` event fires for sub-agent sessions (sessions spawned by `Task()`-like tool calls in the parent session) as well as top-level sessions. Without filtering, a single user conversation that spawns multiple sub-agents creates one Rembric session row per sub-agent — engram observed 170 sessions per conversation before they shipped the filter (engram issue #116).

Filter heuristics (copied from engram's working implementation, both required):

- `event.properties.info.parentID` is set → this is a sub-agent session.
- `event.properties.info.title` ends with ` subagent)` → secondary heuristic for sessions that may lose `parentID` in some opencode versions.

Filtered sessions SHALL be tracked in an in-memory `Set<string>` so subsequent `tool.execute.after` events for the same session ID also skip session-registration.

Alternatives considered:

- **Accept the inflation as a v1 limitation, fix in v2**: rejected. The inflation is severe enough (engram saw 170:1) that v1 would be unusable for any non-trivial conversation.
- **Filter server-side instead**: rejected. The server has no notion of "sub-agent" — opencode's `parentID` is a client-side concept. The filter belongs in the plugin.

### Decision 7: Passive prompt and tool-execute capture in v1

The plugin SHALL POST to `/api/<slug>/prompts/passive` (or equivalent — see spec.md for the exact endpoint shape) on `chat.message` events with prompts ≥10 characters, and SHALL POST to a passive-capture endpoint on `tool.execute.after` events for Task tool outputs. Same surface engram captures.

Rationale: opencode users get value from passive capture even before the agent learns to call `memory.save` proactively. The data fits our existing `prompts` table (via `passive_prompt_capture` schema) and feeds the dashboard's session timeline.

Alternatives considered:

- **Skip passive capture in v1, ship lifecycle only**: rejected. Lifecycle without passive capture leaves opencode users with empty session timelines until the agent saves voluntarily — worse UX than Claude/Codex where the bash scripts capture prompts via the keyword matcher.
- **Only `chat.message`, skip `tool.execute.after`**: deferred. We'll ship both initially; if `tool.execute.after` produces too much noise (Task outputs can be large), v2 can narrow it.

### Decision 8: System-prompt injection is OUT of v1, with documented criteria for re-opening

Engram injects a multi-paragraph memory protocol via `experimental.chat.system.transform`. We do not, in v1. The MCP server's `initialize.instructions` delivers the equivalent protocol to opencode the same way it does to Claude/Codex.

Re-evaluate iff: a follow-up bug report shows that opencode loses the `initialize.instructions` block during compaction OR a local-model user reports Qwen/Mistral incompatibility. Until then, no injection.

Alternatives considered:

- **Mirror engram and ship injection from day one**: rejected. Adds ~30 lines of hard-coded protocol text to the plugin that drifts from the server's `initialize.instructions` source of truth. Single-source-of-truth wins.
- **Read `initialize.instructions` from the MCP server at plugin startup and inject that**: deferred. Cleaner than hard-coding but adds an HTTP call at plugin load. If we ever ship injection, this is the right shape.

## Risks / Trade-offs

- **[Risk]** opencode does not give the spawned bridge subprocess the user's repo as cwd → bridge falls back to `/mcp` unscoped, plugin lifecycle works but MCP path-scoping is silently lost. **Mitigation**: Decision 2's spike-before-code gate. Plan B (the `shell.env` `REMBRIC_PROJECT_DIR` injection) is ready to ship if needed.
- **[Risk]** opencode's `experimental.session.compacting` event API changes shape (it's experimental). The hook breaks; compaction context injection silently fails. **Mitigation**: defensive coding inside the handler — typed access guarded by runtime checks; failure path is a silent stderr diagnostic, never an exception. The session lifecycle continues to work even if compaction-time enrichment breaks.
- **[Risk]** Sub-agent detection heuristics (parentID || title.endsWith(" subagent)")) drift in future opencode releases — new sub-agent shape we don't recognise → session inflation recurs. **Mitigation**: in the `session.created` handler, log a one-line stderr diagnostic on every session creation including `parentID`, `title`, `id`, so divergence is visible in opencode's debug logs. Update heuristics in a follow-up patch.
- **[Risk]** Users who install the opencode plugin and then later install (or already have) the Claude Code plugin face two installation paths in two different docs. **Mitigation**: `docs/agents.md` SHALL gain an "opencode" section parallel to the existing Claude / Codex / Hermes sections, with the same "Install · Configure · Verify" three-step shape.
- **[Trade-off]** The install script does not auto-merge the MCP block into `opencode.json`. Users have to paste the snippet themselves. **Accepted because**: opencode.json is the user's config, often hand-edited, sometimes JSONC with comments. A `jq` merge risks clobbering comments or formatting. Conservative wins. Same path Hermes uses for `~/.hermes/config.yaml`.
- **[Trade-off]** No system-prompt injection in v1 means opencode users with local models (Qwen, Mistral) that only accept a single system message will get the protocol via `initialize.instructions` — which may or may not survive their chat template. **Accepted because**: we don't have evidence the problem exists in opencode yet; engram's injection was a fix for a specific bug they observed. Wait for a real report.
- **[Trade-off]** opencode session closure relies on the agent voluntarily calling `memory.session_summary`. Non-cooperating agents leave sessions in `active` forever (until `abandonStale`). **Accepted because**: this is exactly Codex's steady state today and the dashboard already handles it gracefully. Worth pursuing a stronger close signal only if user feedback demands it.

## Migration Plan

No migration required — net-new capability. Existing Claude, Codex, and Hermes plugin installs are unaffected.

Rollout sequence:

1. Land the OpenSpec change (proposal/design/specs/tasks merged to `main`).
2. Cwd spike runs against `opencode-cli` at the version pinned in tasks.md. Outcome decides whether bridge gets the `REMBRIC_PROJECT_DIR` precedence step.
3. Implementation PR ships `plugin/.opencode-plugin/{plugin.ts, install.sh, uninstall.sh, README.md}`, the optional bridge change (if Plan B), plugin version bumps in all three sibling manifest files + `plugin/CHANGELOG.md`, and the README / docs / dashboard help-copy mentions.
4. No new tests in `src/test/` are required — opencode-specific behaviour is encapsulated in the plugin file which is shipped to user machines, not run inside this repo's vitest suite. Plugin file SHALL be unit-testable via co-located `plugin/.opencode-plugin/plugin.test.ts` covering: dotenv parser, slug regex, sub-agent filter, HTTP client error handling.
5. Manual verification on a real opencode install (steps documented in tasks.md).

Rollback: revert the merge commit. The bridge change (if any) is additive and harmless to existing clients, so reverting is safe.

## Open Questions

- **opencode version pinning**: which opencode-cli version do we target for the cwd spike? `latest` at landing time is good enough for v1, but the docs and README should name a minimum version. Recorded as task 0.2 in tasks.md.
- **`chat.message` vs `message.updated`**: engram uses `chat.message`. opencode docs list both `message.updated` and `chat.message`-like events. The spike SHALL also surface which event fires once per user message and is the correct hook to subscribe to. Recorded as task 0.3.
- **Auto-import for git-synced memories**: engram auto-runs `engram sync --import` on plugin load if `.engram/manifest.json` exists. Rembric has no equivalent git-synced memory format yet. Skip for v1; revisit if/when we ship one.
