## Context

This change bundles findings from a 2026-07-11 opportunity-scan (8 agents) into one omnibus proposal, per an explicit owner decision to accept everything found — including speculative client-API improvements — rather than split by theme. During design, several of the originally-scanned "speculative" items turned out to directly reverse decisions already made, and reasoned, in the affected specs (a Claude `Stop` hook removed for a documented semantic bug; opencode's dispose-flush fire-and-forget behavior validated by a recorded spike; Hermes's fresh-pending-judgment exclusion reasoned explicitly in `mcp-api/spec.md`). This design document treats "propose everything" as "evaluate everything honestly" — items that would silently reopen a settled, evidenced decision are called out and deferred rather than implemented, with the reasoning recorded here so a future change can reopen them deliberately if new evidence justifies it.

Four spec-extraction passes (one per spec-file cluster) were run against the _current_ text of `memory`, `dashboard`, `hermes-agent-plugin`, `http-api`, `plugin-session-protocol`, `codex-distribution`, `claude-code-plugin`, and `opencode-plugin` before writing this design, specifically to distinguish "the spec already requires this and the code just doesn't do it" (a conformance bug, no spec delta) from "this genuinely changes what the spec promises" (needs a delta). That distinction drives the proposal's bug-fix/new-capability split.

## Goals / Non-Goals

**Goals:**

- Fix the diagnosed bugs (opencode event-registration, Codex prompt-matcher, `/rembric:recall`, dashboard FTS page-slice order, `errToMcp`) and close the diagnosed spec-vs-code drift (`include_global`, HTMX, `PAGE_SIZE`, predecessor snapshots, `LOG_LEVEL`).
- Ship the new capabilities that have a clear mechanism and don't fight an existing documented decision: ranking boost, relation expansion, dashboard quick-wins, Hermes per-turn recall, Codex compact-directive parity, bridge version handshake.
- Make zero DB schema changes — every item here is either a bug fix, a read-time computation, or additive server/plugin logic over existing tables (`last_seen_at`, `memory_relations`, `agent_sessions` all already carry what's needed).

**Non-Goals:**

- Reopening the Claude `Stop` hook removal, opencode's dispose-await behavior, opencode's title-derivation source, or Hermes's fresh-pending-judgment exclusion — see "Deferred decisions" below.
- Codex `skills`-based command parity — real feature, real single-copy-discipline design problem, deferred to its own change.
- Any change to the RRF fusion algorithm's shape (branches, over-fetch window, degradation behavior) — only a post-fusion multiplier is added; the two-retriever/RRF core is untouched.
- Multi-client reach for the new Hermes recall endpoint beyond what Hermes needs today (Claude/Codex/opencode already get proactive recall through hooks; the endpoint is not wired into their surfaces in this change).

## Decisions

### 1. Ranking: post-fusion multiplicative boost, not a change to RRF itself

`memory/spec.md:170-213` pins the RRF formula and explicitly says fusion "does not filter" results. Rather than touching that formula, the boost is applied **after** RRF produces its ordered candidate pool and **before** the final truncate-to-`limit`: `finalScore(id) = rrfScore(id) * boost(id)`, where `boost` is a bounded multiplier (clamped to roughly `[0.7, 1.4]`) combining:

- a small recency term keyed on `last_seen_at` (older rows decay toward 1.0, not below — this must never let recency alone bury a stronger lexical/semantic match),
- a small confirmation-count term (more confirmations → closer to the multiplier ceiling),
- a small type weight (e.g. `user`/`feedback` slightly favored over `project` noise, still bounded).

This is a **compile-time constant formula**, matching the existing architecture's style (RANK_CONSTANT, window ceilings, BM25 weights are all compile-time — there are no runtime ranking knobs today, and this doesn't introduce the first one). It requires a MODIFIED delta on `memory/spec.md`'s hybrid-retrieval requirement, since the current text is silent on any post-fusion step.

**Alternatives considered:**

- A learned/ML reranker — rejected: the spec's own reasoning for `DEFAULT_SEARCH_LIMIT=8` is explicitly "no reranker is applied" (`memory/spec.md:233-235`); adding one is a much bigger architecture change than this scan's evidence justifies.
- Baking the boost into each branch's own ranking (FTS `ORDER BY`, kNN distance) before fusion — rejected: touches two independent, well-isolated retrievers instead of one fusion step, and would make the "each retriever is independent" property harder to reason about and test.

### 2. Relation expansion is additive, not blended, and capped

A new optional `include_relations?: boolean` (default `false`) on `memory.search`. When set, after the normal top-`limit` fused result is computed, each result row's `supersedes`/`superseded_by`/`conflicts_with` targets (already present in that row's `relations[]` annotation) that are **not already in the result set** are fetched and appended, tagged `expandedFrom: <originId>`, capped at 5 additional rows total regardless of how many results have annotations. Expansion rows do **not** count against the caller's `limit` and are not re-ranked into the primary ordering — they are a clearly-separate appendix.

**Alternatives considered:**

- Blending expansion rows into the ranked list before truncation — rejected: silently changes "returns the top `limit` results" (`memory/spec.md:172`) into a lie for external callers who don't know about expansion, and makes the feature impossible to reason about size-wise.
- Uncapped expansion — rejected: a relation-annotation cap of 10 per row (`memory/spec.md:380`) times several results could otherwise fan out unboundedly; a flat cap of 5 keeps the response bounded independent of how many results have annotations.

### 3. `include_global`: widen the SQL predicate and the dense branch's scanned partitions, not a second search call

The lexical branch's `WHERE` clause becomes `(scope = 'project' AND project_id = :pid) OR (scope = 'global')` when `include_global = true` (unchanged otherwise). The dense/kNN branch, which today issues one partition-scoped `MATCH` query, issues **two** — one against the project partition, one against the global partition — and unions the candidate ids before the existing RRF step runs exactly as before. This keeps "two independent retrievers, then RRF" intact; only how many rows each retriever is allowed to see changes.

**Alternative considered:** running `memory.search` twice (once per scope) and merging client-side in the MCP tool layer — rejected: doubles round-trips, and re-implements rank fusion a second time outside `hybrid-search.ts` instead of reusing the one already-tested fusion step.

No spec delta needed here — `memory/spec.md:75-88` already specifies this exact contract (`include_global = true` scenario, lines 79-82); this is closing an existing gap, not creating one.

### 4. Hermes recall transport: a new thin HTTP endpoint, not an in-process MCP client

`POST /api/<slug>/memory/recall` — same `authenticate({pathSlug})` gate as the existing three session routes (`http-api/spec.md:9-36`), body `{ query: string, limit?: number }` (limit clamped small, e.g. `[1,5]`, since this feeds a per-turn context injection budget, not an exploratory search), delegating straight to the same `MemoryService.search()` used by `memory.search` (so recall quality — including the ranking boost from Decision 1 — is identical everywhere, not a second, divergent implementation). Response is `{ ok: true, memories: [{id, title, snippet}], formatted: string }`, where `formatted` is a ready-to-inject `<memory-context>...</memory-context>` string — keeping the Python provider thin (no Rembric-specific formatting logic on that side), consistent with the existing principle that the HTTP API is the shared cross-language surface (`CLAUDE.md`: "Shared logic lives in the HTTP API contract... per-client adapters MAY be written in any language").

`queue_prefetch(query, **kwargs)` calls this endpoint in the background and caches the result on the provider instance keyed by session id; `prefetch(query, **kwargs)` returns the cache instantly (per Hermes's own contract, `prefetch` must never make a network call inline). `initialize()` does NOT attempt to warm the cache — Hermes calls `prefetch` with the real first user message before `queue_prefetch` ever runs for that turn (`queue_prefetch` only warms the _next_ turn), so there is no meaningful query available at `initialize` time; turn 1's `prefetch` returns `""` by construction, an accepted at-most-one-turn-behind tradeoff. `sync_turn` posts a heartbeat to the _existing_ `/sessions/:id/summary` route every 5th call (a simple instance counter inside `sync_turn` itself — no new `on_turn_start` hook needed), not every turn, to stay within Hermes's serialized-background-worker budget.

`initialize(**kwargs)` additionally checks `kwargs.get("agent_context", "primary")`; when it's an explicit non-primary value (`"subagent"`, `"cron"`, `"flush"`), the session-creation POST is skipped (same pattern the requirement already uses for "no slug resolved" — silently skip HTTP work, still register the provider). Absent kwarg defaults to today's behavior.

**Alternative considered:** a Python-side MCP client hitting `/mcp/<slug>` directly for recall — rejected: a full MCP client (init handshake, tool-call framing) in Python is much heavier than one REST call for a read-only, latency-sensitive per-turn path, and diverges from the established HTTP-API-as-shared-surface pattern.

Requires a MODIFIED delta on `hermes-agent-plugin/spec.md` (the `prefetch`/`queue_prefetch`/`sync_turn` no-op bullets, and the `system_prompt_block` requirement's now-false claim that Hermes "exposes no per-turn hook") and an ADDED delta on `http-api/spec.md` (the new route).

### 5. Codex compact-matcher parity + drift reconciliation

Add a `SessionStart` matcher group `"compact"` to `hooks.codex.json` invoking the existing `post-compact.sh` (the same script Claude Code's `SessionStart(compact)` uses) — Codex's `SessionStart` stdin now carries a `source` field (`startup|resume|clear|compact`) and the dispatcher matches `SessionStart` matchers against it (confirmed against `codex-rs` `schema.rs`/`dispatcher.rs` at `codex-cli` 0.142.3+), so the same stdout-directive mechanism Claude uses now works unmodified on Codex.

This surfaced a **pre-existing internal contradiction** in `codex-distribution/spec.md`, unrelated to anything this proposal introduces: the "Codex hook configuration" requirement (lines 48-68) asserts "Codex has no `PreCompact` or `PostCompact` event" and that `hooks.codex.json` "SHALL NOT contain `PreCompact`, `PostCompact`" — but the file already declares both, and a sibling requirement in the _same spec file_ ("`docs/agents.md` recommends the plugin install as primary", lines 198-214) correctly enumerates "the FIVE hooks (`SessionStart`, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`)". The first requirement is stale (written when Codex genuinely lacked these events); the second was updated when Codex gained them and nobody reconciled the first. This design folds that reconciliation in: the "Codex hook configuration" requirement is rewritten to match current `codex-cli` capability (6 wired hook entries after this change: `SessionStart`×2 groups, `UserPromptSubmit`, `Stop`, `PreCompact`, `PostCompact`), and the `plugin_hooks`-feature-flag guidance in the docs requirement (lines 210-213) is removed since that flag was removed upstream in `codex-cli` 0.142.3+ (hooks are stable, on by default; per-hook `/hooks` trust review still applies and stays documented).

### 6. opencode: move `message.updated`/`session.idle` into the `event` dispatcher

`opencode-plugin/spec.md`'s "Event handler set" requirement (lines 181-203) currently mandates these as **top-level** `Hooks` object keys (`"message.updated": async (input, output) => ...`, `"session.idle": async (input) => ...`), matching what `apps/plugin/.opencode-plugin/plugin.ts` does today. Neither name is a valid top-level `Hooks` key in opencode 1.15.5 or 1.17.18 — both are members of the `Event` union, dispatched only through the `event` hook's `switch (event.type)`. This makes assistant-turn capture and the idle-debounced flush dead code today. Fix: add `case "message.updated":` and `case "session.idle":` branches to the existing `event` dispatcher (which already handles `session.created`/`session.deleted`/`server.instance.disposed` this way), removing the two top-level keys. The spec's exact-enumerable-keys scenario shrinks from 5 keys to 3 (`event`, `chat.message`, `experimental.session.compacting`).

This is presented as a bug fix (restoring intended behavior), but it changes normative spec text (the exact-keys list), so it needs a MODIFIED delta, not just a task.

### 7. Bridge version handshake: warn, don't block

`apps/plugin/bin/rembric-bridge.mjs` (shared by Claude Code, Codex, and opencode's stdio-bridge reuse) adds one `GET /healthz` call at startup, using the token it already holds, comparing the returned `version` against a `MIN_SERVER_VERSION` constant bumped alongside the plugin's own version. On mismatch, print exactly one stderr line (non-blocking — the bridge still connects) naming the versions and pointing at the dashboard self-update / `docs/updates.md`. This lands as a MODIFIED delta on `claude-code-plugin/spec.md`'s existing bridge-contract requirement (which already governs `mcp-remote` pinning) since that's the current canonical home for shared-bridge behavior text; Codex and opencode inherit it by consuming the same file, with no separate spec text needed in their own capability files.

**Alternative considered:** blocking the connection on version mismatch — rejected: version skew is expected and transient during a rolling self-update; a hard block would turn a brief, self-healing window into a hard outage for the agent.

### Deferred decisions (evaluated, not implemented here)

| Item                                                      | Why deferred                                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Claude Code `Stop` hook nudge                             | `claude-code-plugin/spec.md:59-65` removed `Stop` unconditionally as "a semantic bug" (fires per-turn, not per-session) with a documented incident (premature `/end` transitions). A different, non-HTTP-side-effecting use (nudge-only) is plausible but reverses an unconditional "SHALL NOT be wired" — needs its own proposal with explicit sign-off, not a drive-by inclusion here. |
| Codex `skills`-based command parity                       | `codex-distribution/spec.md` has an explicit scenario forbidding a `skills` field. Real feature, but the single-copy-discipline collision with `commands/*.md` (CLAUDE.md's plugin-development rule) needs its own design, not a bundled add.                                                                                                                                            |
| opencode `client.session.messages()` as transcript source | Not a bug — no requirement is violated today. A genuinely better data source, but replacing the transcript-accumulator architecture (which the spec describes in detail) is a bigger, independent change.                                                                                                                                                                                |
| opencode dispose flush → awaited `dispose` finalizer      | `opencode-plugin/spec.md:500-514` explicitly documents this as **empirically validated by a recorded spike** ("Awaiting would block opencode's exit... verified by spike, design.md::Decision 4 resolved"). No new evidence contradicts that spike's result; reopening it needs a new spike, not a hunch.                                                                                |
| opencode `session.updated`-derived titles                 | Current first-user-message derivation is a considered design (explicit omit-vs-null discipline mirroring `cwd` handling), not a bug. Low value, non-zero risk; not worth bundling.                                                                                                                                                                                                       |
| Fresh (<24h) `pendingJudgments` in `memory.context`       | `mcp-api/spec.md:442-446` explicitly and by name excludes these ("fresh pendings belong to the session that created them"), with a scenario titled "exposes only aged pendings, never fresh ones." No new evidence in this scan contradicts that reasoning.                                                                                                                              |

## Risks / Trade-offs

- **[Risk]** The opencode event-registration fix (Decision 6) is based on static reading of opencode's published TypeScript types and dev-branch source, not a live run against an installed opencode instance → **Mitigation**: `tasks.md` makes the `rembric-plugin-development` skill's mandatory e2e walkthrough (`pnpm run dev:docker:up` + a real opencode session) a hard gate before this fix is considered done, specifically exercising an idle flush and an assistant-turn capture.
- **[Risk]** The ranking boost (Decision 1) changes result ordering for every existing `memory.search` caller, not just new opt-in callers → **Mitigation**: the multiplier is tightly bounded (`[0.7, 1.4]`) so it nudges within the existing fused ordering rather than overriding lexical/semantic relevance; existing search tests get updated fixtures as part of the task, and the bound itself is a task-level tunable to revisit if real usage shows it's too aggressive or too weak.
- **[Trade-off]** The Hermes recall endpoint (Decision 4) is scoped narrowly to what Hermes needs today (small `limit`, `formatted` string tailored to `<memory-context>` injection) rather than a general-purpose recall API → **Accepted because** widening it to a public recall surface for the other three clients is explicitly out of scope (Non-Goals) and would need its own design around rate limiting and response shape stability.
- **[Trade-off]** Reconciling the Codex spec's internal PreCompact/PostCompact contradiction (Decision 5) touches a requirement neither this scan nor the user asked about directly → **Accepted because** leaving a self-contradictory spec in place while adding a new compact-matcher requirement next to it would make the file harder to trust than before this change, and the reconciliation is a pure documentation catch-up (the code already does the PreCompact/PostCompact part correctly).
- **[Risk]** `include_global`'s two-partition kNN scan (Decision 3) roughly doubles dense-branch query cost for project-scoped searches that opt in → **Mitigation**: it's opt-in (`include_global` defaults to `false`, unchanged existing behavior when omitted), and each partition scan is still bounded by the existing rank-window ceiling, so worst case is 2× a bounded query, not an unbounded scan.

## Migration Plan

No database schema changes anywhere in this batch — every capability is a read-time computation (ranking boost, relation expansion, `last_seen_at` display, needs-review badge count) or additive plugin/server logic over existing tables and endpoints. Deploys as a normal release:

1. Land the bug fixes first (independently revertable per-file if any single fix regresses something in CI or the e2e playbook).
2. Land `include_global`, HTMX, `PAGE_SIZE`, predecessor snapshots, `LOG_LEVEL` wiring (closing existing spec gaps — no new surface area to review beyond "does it now match the spec").
3. Land the ranking boost + relation expansion together (both touch `hybrid-search.ts`).
4. Land the dashboard quick-wins (badge, forward-nav, `last_seen_at`, backup button, pager) — independent of the server-side items above.
5. Land the new Hermes recall endpoint + provider changes together (endpoint before provider, so the provider's first real call has somewhere to land).
6. Land the Codex compact-matcher + spec reconciliation, the opencode event-dispatcher fix, and the bridge version handshake — each independently revertable, each gated by its client's e2e validation.

Rollback is a standard revert of the offending commit/release; there is no data to roll back since nothing here mutates persisted rows beyond what the existing append-only/status-flip machinery already allows.

## Open Questions

- Exact boost weights (recency half-life, confirmation-count weight, type weight) in Decision 1 are starting values to be tuned against real search fixtures during implementation, not final.
- Whether `include_relations` expansion's flat cap of 5 is right, or should scale with `limit` — start flat, revisit if implementation/testing shows it's too tight or too loose for larger `limit` values.
- Whether the new Hermes recall endpoint's `limit` ceiling (proposed `[1,5]`) is enough headroom for `queue_prefetch`'s background warm — start conservative, widen if the injected `<memory-context>` proves too thin in practice.
