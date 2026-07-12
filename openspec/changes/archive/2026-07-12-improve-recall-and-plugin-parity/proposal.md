## Why

A 2026-07-11 opportunity-scan (8 exploration agents: recall pipeline, agent UX, dashboard, ops, plus a per-client API audit of Claude Code/Codex CLI/Hermes/opencode) found a cluster of live bugs, spec-vs-code drift, and unexploited client-API capabilities across the memory/dashboard/plugin surfaces. Several items are conformance bugs against requirements the specs _already_ state (e.g. `include_global`, HTMX, `PAGE_SIZE`); others are genuine new capabilities the current client APIs now support but Rembric doesn't use (Codex's `SessionStart` compact matcher, Hermes's `prefetch`). Bundling them now is cheaper than re-discovering the same evidence in a future scan, and several are small, low-risk, already-diagnosed fixes.

## What Changes

### Bug fixes (restore existing spec-required behavior — no requirement text changes)

- Fix `apps/plugin/commands/recall.md` passing `q:` instead of `query:` to `memory.search` (the flagship recall command currently ignores the user's search keywords); clean up `context.md`'s stray `limit` arg.
- Fix `apps/plugin/scripts/prompt-search.sh` so it self-filters on `stdin.prompt` against the recall-intent keyword regex, since Codex's dispatcher does not consult `UserPromptSubmit` matchers (only Claude Code's does) — today the nudge fires on every single Codex turn.
- Implement `include_global` in `memory.search`'s project-scoped branch (`openspec/specs/memory/spec.md:75-88` already specifies this contract; the dense/lexical branches currently only support project-XOR-global).
- Implement the HTMX progressive-enhancement behavior the dashboard spec already mandates in ~7 places (`openspec/specs/dashboard/spec.md` lines 11, 39-43, 209-235, 246-261, 365-382, 781) — `htmx.min.js` is vendored but never loaded, zero `hx-*` attributes exist, and the `htmx:afterSwap` rebind listeners never fire.
- Raise dashboard `PAGE_SIZE` from 10 to the 50 the spec already requires (`dashboard/spec.md:280,777`).
- Render predecessor content snapshots in the memory detail view, as `dashboard/spec.md:98,110` already requires.
- Fix `apps/server/src/mcp/errors.ts`'s `errToMcp` to return a generic message + error id and log the real error server-side, per `mcp-api/spec.md:281-293`, instead of leaking `err.message` and logging nothing.
- Fix `apps/server/src/dashboard/memories.ts`'s FTS search branch applying scope/status/type filters after the page slice instead of before (under-filled pages).
- Wire the parsed-but-unused `LOG_LEVEL` config knob (`apps/server/src/config.ts`) into an actual leveled logger, and route the `errToMcp` fix above through it.
- Correct `.agents/skills/rembric-plugin-development/references/per-client-gotchas.md`: the `plugin_hooks` feature flag it documents as "under development" was **removed** in `codex-cli` 0.142.3+ (hooks are stable and on by default); the documented `codex plugin update/enable/disable` subcommands don't exist (real verbs: `add`/`list`/`remove`/`marketplace{add,list,upgrade,remove}`).

### New capabilities (genuine requirement changes — see Capabilities below)

- **Ranking quality**: a post-fusion confidence/recency/type boost on top of the existing RRF fusion, and an opt-in one-hop relation expansion so a search hit's `superseded_by` head or `conflicts_with` counterpart can be co-surfaced.
- **Dashboard**: a `needs_review` count badge on the Memories sidebar entry (mirroring the existing Judgments badge — NOT a new Overview stat card, which would violate the deliberately-fixed six-card Overview and the documented rationale for removing the Pending Judgments card), forward "superseded by" navigation on memory detail, `last_seen_at` visibility on memory detail, an on-demand backup/VACUUM action on the Maintenance page (wrapping the existing `diagnostics.vacuumInto`), and a "PAGE X OF Y" indicator on paginated list views.
- **Hermes recall parity**: implement `prefetch`/`queue_prefetch` so Hermes gets per-turn proactive recall injected as an authoritative `<memory-context>` block (something no other client has today), backed by a new lightweight HTTP recall endpoint; implement `sync_turn` as a throttled heartbeat against the _existing_ `/sessions/:id/summary` route; gate session-row creation on `agent_context == "primary"` so subagent/cron invocations stop inflating the dashboard.
- **Codex compact-directive parity**: add a `SessionStart` `matcher:"compact"` hook group (reusing the existing `post-compact.sh`) so Codex gets the same "persist the summary" model directive Claude/opencode already have — and reconcile `codex-distribution/spec.md`'s stale claims (it currently asserts Codex has no `PreCompact`/`PostCompact` events and that its `SessionStart` matcher excludes `"compact"`; both are outdated against current `codex-cli` — `PreCompact`/`PostCompact` are already wired in `hooks.codex.json` and contradict a sibling requirement in the same spec file that correctly lists them).
- **opencode event-registration fix**: `apps/plugin/.opencode-plugin/plugin.ts` registers `'message.updated'` and `'session.idle'` as top-level `Hooks` object keys, matching what `opencode-plugin/spec.md`'s "Event handler set" requirement currently mandates — but neither name is a valid top-level `Hooks` key in opencode 1.15.5 or 1.17.18 (both are `Event` union members dispatched only through the `event` hook). This makes assistant-turn capture and the idle-debounced flush dead code. Fix moves both into the `event` dispatcher's switch statement; the spec's exact-keys enumeration must change to match.
- **Bridge version handshake**: `apps/plugin/bin/rembric-bridge.mjs` (shared by Claude Code, Codex, and opencode) never reads `/healthz` even though it already exposes `{ok, version}` — add a startup check that warns to stderr when the server is below the plugin's declared minimum version.

### Explicitly evaluated and deferred (not in this change — reverses a documented, reasoned decision)

- A Claude Code `Stop` hook nudge: `claude-code-plugin/spec.md:59-65` explicitly removed `Stop` as "a semantic bug" (fires once per turn, not once per session) and the requirement text is unconditional ("SHALL NOT be wired in this version"). Reversing this for a different (non-blocking nudge) purpose needs its own dedicated proposal with explicit sign-off, not a drive-by add here.
- Codex `skills`-based command parity: `codex-distribution/spec.md` has an explicit scenario forbidding a `skills` field ("protocol guidance is delivered server-side via `initialize.instructions`"). This is a bigger feature with a real single-copy-discipline design problem (colliding with `commands/*.md`) — deferred to its own change.
- opencode `client.session.messages()` as the transcript source, and moving the dispose flush to the (awaited) `dispose` finalizer: the current fire-and-forget `server.instance.disposed` approach was empirically validated by a recorded spike (`opencode-plugin/spec.md:500-514`, "verified by spike, design.md::Decision 4 resolved") specifically because awaiting at dispose time doesn't reliably work. No new evidence justifies reopening either decision here.
- opencode `session.updated`-derived titles instead of first-user-message derivation: current behavior is a considered design (explicit omit-vs-null discipline matching the `cwd` handling elsewhere), not a bug. Deferred as a low-value swap not worth the risk in this batch.
- Surfacing fresh (<24h) `pendingJudgments` in `memory.context`: `mcp-api/spec.md:442-446` explicitly and deliberately excludes them ("fresh pendings belong to the session that created them"). No new evidence contradicts that reasoning.

## Capabilities

### New Capabilities

(none — everything below extends an existing capability)

### Modified Capabilities

- `memory`: add a post-fusion ranking boost (confidence/recency/type) as an amendment to the pinned RRF formula, and an opt-in one-hop relation-expansion parameter on `memory.search`.
- `dashboard`: add a `needs_review` badge on the Memories sidebar nav entry, forward superseded-by navigation and `last_seen_at` display on memory detail, an on-demand backup/VACUUM action on Maintenance, and a page-count indicator on paginated views.
- `hermes-agent-plugin`: replace the `prefetch`/`queue_prefetch`/`sync_turn` no-op requirements with real per-turn recall and heartbeat behavior, and add `agent_context`-based session-creation gating to `initialize()`.
- `http-api`: add a new bearer-gated, path-scoped recall endpoint backing Hermes's `prefetch`.
- `codex-distribution`: add a `SessionStart` `compact` matcher group and reconcile the stale `PreCompact`/`PostCompact`/`plugin_hooks`-flag claims with current `codex-cli` capabilities.
- `opencode-plugin`: move `message.updated`/`session.idle` handling from top-level `Hooks` keys into the `event` dispatcher; update the "Event handler set" requirement's exact-keys enumeration accordingly.
- `claude-code-plugin`: extend the existing MCP bridge-contract requirement with a server version-compatibility check at bridge startup.

## Impact

- **Plugin (shared across clients)**: `apps/plugin/commands/{recall,context}.md`, `apps/plugin/scripts/prompt-search.sh`, `apps/plugin/hooks/hooks.codex.json`, `apps/plugin/.opencode-plugin/plugin.ts`, `apps/plugin/.hermes-plugin/__init__.py` (`plugin.yaml` hooks list unchanged — `prefetch`/`queue_prefetch`/`sync_turn` are already-declared ABC methods, not manifest-gated), `apps/plugin/bin/rembric-bridge.mjs`, `.agents/skills/rembric-plugin-development/references/per-client-gotchas.md`.
- **Server**: `apps/server/src/services/hybrid-search.ts`, `apps/server/src/services/memory.ts` (scope blending + ranking boost + relation expansion), `apps/server/src/mcp/errors.ts`, `apps/server/src/config.ts` + a new small logger module, `apps/server/src/server/api-router.ts` (new recall route), `apps/server/src/dashboard/{memories,components,maintenance}.ts`, `apps/server/src/dashboard/templates.ts` (HTMX asset load), `apps/server/src/db/repositories/memory-repository.ts` (`findSuccessorId` reuse, `last_seen_at` projection).
- **Specs**: `openspec/specs/{memory,dashboard,hermes-agent-plugin,http-api,codex-distribution,opencode-plugin,claude-code-plugin}/spec.md`.
- **Docs**: `.agents/skills/rembric-plugin-development/references/per-client-gotchas.md`.
- No load-bearing invariant (append-only, scope-at-service-layer, `topic_key` convergence, fresh-context judgment) is violated; the `include_global` and relation-expansion work is explicitly bounded by the existing "under no circumstances a different `project_id`" scope-isolation rule.
