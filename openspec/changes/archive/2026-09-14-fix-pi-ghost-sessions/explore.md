# Explore: fix-pi-ghost-sessions (issue #377)

Read-only exploration before proposal. No implementation. Artifact store: openspec.

## Problem statement

One long-lived Pi conversation accumulates multiple `sessions` rows (issue #377: rows A/B/C, overlapping lifetimes, all ended `abandoned`, different partial titles/summaries of the same workstream; server 0.28.6, plugin 0.30.0). Each extra row is `agent='unknown'` (MCP-minted), while the plugin's own row (Pi host uuid, `agent='pi'`, created via HTTP) carries only its own slice of the titles/summaries. Ghosts outlive the real row after the plugin's shutdown `/end`.

## Validated root cause

Reproduction: `apps/server/src/mcp/ghost-session-repro.test.ts` (temporary, 2 passing tests: control + weeks-long timeline).

Chain, verified in code:

1. `handleSessionStart` reuses the active row only via `findActiveForTransport` (`apps/server/src/mcp/session-tools.ts:184`), which returns the sole `status='active'` row **whose effective last activity is within `TRANSPORT_STALENESS_MS` = 30 min** (`apps/server/src/services/agent-sessions.ts:43`, lookup at `:574-586`; repository `LIMIT 2`, sole-match-or-nothing at `apps/server/src/db/repositories/agent-sessions-repository.ts:150-170`).
2. After any idle gap > 30 min (long agentic turn, user away, no plugin touch in between), the next model-initiated `memory.session_start` finds no fresh row and mints a new ULID row with `agent: args.agent ?? 'unknown'` (`session-tools.ts:196-203`), while the plugin row is still `active` → overlapping lifetimes.
3. With ≥ 2 live rows the fresh lookup is ambiguous → refuse → mint on every subsequent call (repro: 5 calls → 5 extra rows). This is spec-mandated (see quotes below).
4. The Pi plugin's shutdown `/end` covers only `quit|new|resume|fork` on its own host-uuid row (`apps/plugin/.pi-plugin/index.ts:89` `CLOSING_SHUTDOWN_REASONS`; `openspec/specs/plugin-session-protocol/spec.md:313-314`) → ghosts stay `active` until the 24 h `abandonStale` sweep (startup `apps/server/src/server/bootstrap.ts:121-123`, periodic `:278-283`, window `config.ts:254-256` `SESSION_ABANDON_AFTER_MS`) flips them to `abandoned`.
5. `memory.save`/`memory.confirm`/`capture_passive` auto-attach via `resolveActiveSessionId` (`apps/server/src/mcp/memory-tools.ts:667-695`) and `resolveSessionId` (`apps/server/src/mcp/_shared.ts:308-334`) — same `findActiveForTransport` family → titles/summaries fragment across rows once several are live.

**Repro modeling note (matters for evaluating fixes):** the repro's `makeContext()` sets `mcpSessionId: null` (`ghost-session-repro.test.ts:41-49`), so `routerKey()` returns null and the repro exercises the **binding-less** path only. On a real Streamable HTTP transport (all five clients) `ctx.mcpSessionId` exists, `handleSessionStart` binds the row via `setActiveSession` (`session-tools.ts`, `deps.router.setActiveSession` after the mint/reuse branch), and `resolveSessionId` reads that binding FIRST for every later write. The diagnosis stands (the issue's three rows prove mints happened), but the snowball phase is partially self-healing on a bound transport — any candidate fix must be evaluated in BOTH context shapes.

## Spec text this fix touches (verbatim quotes)

`openspec/specs/sessions/spec.md:832`:

> ### Requirement: `findActiveForTransport` MUST NOT guess under concurrent ambiguity

… rules 1–3: return the sole match; return `null` on zero; and on ≥ 2:

> Return `null` — never an arbitrary pick — when two or more rows match. Two or more concurrently active sessions under the same token+project is genuinely ambiguous; the method SHALL NOT use recency (`started_at`) or any other heuristic to break the tie, since doing so risks attaching to the wrong session, which is a worse outcome than no attachment.

`openspec/specs/sessions/spec.md:868`:

> #### Scenario: memory.session_start mints a fresh session instead of reusing an ambiguous one

`openspec/specs/sessions/spec.md:874` ("Session rows MUST record last activity…"), :878:

> Transport-based resolution SHALL exclude rows whose effective last activity is older than a short staleness window, so a zombie row stops creating ambiguity **without** introducing a recency tiebreak among genuinely-concurrent sessions.

Deliberate re-attach semantics of the reuse branch, `apps/server/src/mcp/session-tools.ts:175-183` (comment states intent **without** a freshness qualifier):

> Idempotency on (token, project): if a session is already active for this scope (typically because the plugin's SessionStart hook created one via the HTTP /api/.../sessions path), return that one instead of minting a new ULID-based row.

Staleness rationale, `apps/server/src/services/agent-sessions.ts:35-41`: a killed session "stops creating false ambiguity for a fresh session on the same transport once stale" — i.e. the window protects a **fresh** session's resolution from **stale** competitors; it does not by itself say what `session_start` must do when there are zero fresh rows and one stale-but-live row.

## Candidate approaches

### A) Router-binding-first in `handleSessionStart`

Before `findActiveForTransport`, consult `deps.router.get(key.tokenId, key.mcpSessionId)?.rembricSessionId`; when the bound row exists, is `status='active'`, not soft-deleted, and matches `(ctx.token.id, resolved projectId)`, reuse + `touchActivity` it; otherwise fall through (do NOT clear the binding — `clearSession` is session_end-only by design; clearing would drop auto-attach to NULL).

- **When does the binding exist?** Only after a `memory.session_start` or `memory.session_resume` on THAT transport (the only two `setActiveSession` call sites; per archived `2026-08-09-resume-closed-sessions` design D4, "the only site in the codebase that writes that binding"). The HTTP plugin path (`POST /api/<slug>/sessions`) binds NOTHING — hook calls carry no `mcpSessionId`, and the router is keyed by `(tokenId, mcpSessionId)` (`apps/server/src/server/session-router.ts:1-30`). The binding is in-memory: lost on server restart, and a new Pi process (`pi -r`) gets a new MCP session id → no binding.
- **Prevents the FIRST ghost?** **No.** At the first model `session_start` after a >30-min idle there is no binding (unless the model called it earlier in the same process while fresh), so A falls through to the same stale-lookup → mint.
- **Prevents the snowball?** **Yes, on a bound transport** — every later call reuses the bound row regardless of staleness or a second live row, which is an id, not a guess (no no-guess conflict).
- **Keeps:** `resolveSessionId` already reads the binding first for end/summary/save; start becomes consistent with the rest of the surface. Multi-client mint-under-ambiguity untouched.
- **Spec impact:** mcp-api session-lifecycle requirement gains the binding-precedence clause. No delta to the no-guess requirement.
- **Blast radius:** MCP surface only; benefits all five clients' defensive `session_start` calls within one process.

### B) Unique-active-any-staleness reuse

When the fresh lookup returns null but **exactly one** `status='active'`, non-deleted row exists for `(tokenId, projectId)`, reuse + touch it instead of minting.

- **Prevents the FIRST ghost?** **Yes** — R1 is unique while stale → reuse.
- **Prevents the snowball?** **No** — once ≥ 2 rows are live, uniqueness fails → ambiguity → spec-mandated mint continues.
- **Evaluation of the staleness design tension:** B does not reintroduce a recency tiebreak and does not touch the fresh path; it changes only the zero-fresh-rows outcome from mint to adopt-the-sole-live-row. That matches the reuse branch's documented intent (quote above) — "already active for this scope → return that one" — read without the freshness accident. The residual misfire: a killed client's zombie row can be adopted by a NEW conversation whose own plugin ensure/resume failed (rare; cost is a mislabeled lineage, no data corruption; the alternative is the defect being fixed). Two live rows still refuse — the killed-client-competes-with-fresh case (`sessions/spec.md:874` scenario "A killed client no longer blocks auto-attach") is unaffected because a fresh plugin row wins the fresh lookup before B is consulted.
- **Test impact:** `session-tools.test.ts:89-98` "mints a fresh session instead of adopting one of two ambiguous active sessions" stays GREEN (two rows → still ambiguous). Fresh-reuse test `:80-87` stays green.
- **Spec impact:** DELTA required on both quoted requirements: the `session_start` reuse precondition becomes "unambiguous **active** candidate" (staleness not applied to the sole-candidate reuse path), and `:878`'s exclusion sentence is scoped to auto-attach with the session_start carve-out named.
- **Implementation shape:** narrow — a new service lookup (e.g. `findSoleActiveForReuse`) used ONLY by `handleSessionStart`, leaving `findActiveForTransport` and every auto-attach caller untouched — vs wide — fold into `findActiveForTransport` itself (also fixes auto-attach fragmentation in one stroke, but changes rule 2's contract for every caller and widens the zombie-attach surface to `memory.save`). Narrow = smaller spec delta; recommend narrow.

### C) Combination A + B

- Binding-first → sole-active-any-staleness → fresh-unique (already first in practice) → ambiguity mint.
- Repro-fix simulation over the weeks-long timeline **with** an `mcpSessionId`: no ghost #1/#2 (B), no snowball (A binds), one post-sweep mint after the weekend (zero active rows — legitimate), and at the post-resume ambiguity onset (plugin resumes R1 + G3 live, new transport = no binding) exactly ONE mint, then A binds and stops the rest. Net: one logical conversation → at most 2 live rows (plugin row + one bound MCP row), zero `agent='unknown'` ghosts in the common path, vs. unbounded today.
- **Residual that no combination fixes without touching the no-guess rule:** the first call under genuine ≥2-row ambiguity still mints (spec `:868`).

### D) Complementary hardening

- **D1 auto-attach fragmentation** (`resolveActiveSessionId`): mostly fixed for free by C (no second row → no ambiguity → attach healthy). B-wide would additionally make saves attach to the sole stale row instead of `session_id = NULL`. Recommend OUT of scope unless the owner opts in (separate delta on the same requirement).
- **D2 end/summary on rows other than the caller's:** today they resolve router-first, then fresh-unique; under ghosts with no binding they refuse with `session_not_found` (safe but useless). C routes them to the bound row. No change needed beyond C.
- **D3 tool-description nudge:** `apps/server/src/mcp/server.ts:310-313` already says "In normal operation you do NOT need to call this". Add one clause: once a session is active on this connection, do not call `session_start` again — writes attach automatically. IN scope (cheap; ~1082 chars headroom, description measured at 818/1900 by `expose-session-start-agent` task 3.3).
- **D4 plugin-side complement:** the Pi extension could call `memory.session_start` once per process right after MCP discovery (plugin rows are fresh at that moment), establishing the binding early and making A fully cover Pi even when the model never calls early. Only worth it if B is rejected; plugin releases are decoupled. Default OUT.

### E) Optional, spec-changing: provenance-based ambiguity adopt

When ≥ 2 rows are live and exactly one was created out-of-band (HTTP `ensure`, real `agent`) while the rest are MCP-minted `agent='unknown'`, adopt the out-of-band row instead of minting. Directly kills the post-resume mint and the issue's exact shape, but it IS a tiebreak — currently forbidden by `sessions/spec.md:868` — and needs the strongest delta plus an owner decision. Default OUT.

## Interactions

- **24 h sweep + `purgeEmpty`:** C does not change abandonment (`abandonStale`, `bootstrap.ts:121-123`/`:278-283`) — the post-weekend mint remains and is defensible. Ghosts are usually empty → physically purged by the consolidation-runner piggyback (`apps/server/src/consolidation/runner.ts:110-112`) or the maintenance button (`apps/server/src/dashboard/maintenance.ts:509`); ghosts that captured a summary persist (append-only). No migration/repair for existing ghost rows is proposed (`agent` is immutable; operators can `markAbandoned`/soft-delete from the dashboard). Out of scope.
- **`resume()`:** the plugin's `POST /sessions/<id>/resume` (mandated once per process by `plugin-session-protocol/spec.md:317`) revives the row and makes it fresh, so it wins the fresh lookup; C's binding keeps later model calls off the ambiguity path.

## Overlap check with active changes

- **`expose-session-start-agent`** — touches the SAME handler: adds `agent` to `sessionStartOutput` + response and the `session_start` description; ALL tasks `[x]` (implemented, not archived). **Collision:** D3 edits the same description; this fix's proposal must rebase on its pins (`mcp-integration.test.ts:746` length = 818, `:811-825` required-field list). Its adoption semantics (report, never refuse/re-key on `agent`) are compatible with A/B.
- **`expose-session-write-verdict`** — same file (`session-tools.ts` outputs for summary/end) and same `mcp-integration` pins; no behavioral overlap with A/B. Coordinate archive order to avoid pin churn.
- **`proactive-entity-recall`** — new recall-hints endpoint + `memory.search` description wording; `recallHints` already landed in `agent-sessions.ts` (merge-conflict-only risk). No collision.

## Multi-client blast radius

The same MCP surface serves Claude Code, Codex, Hermes, opencode, Pi. Who relies on mint-on-ambiguity today: any transport with ≥ 2 concurrent live rows and no binding — e.g. two genuinely concurrent agent processes on one token+project (the issue #337 case) — and the archived `resume-closed-sessions` design D8 cites the no-guess rule as the reason resume is id-targeted. A/B/C preserve that: two live rows still mint (once per transport under A). Claude/Codex/Hermes/opencode models' defensive `session_start` calls get the same benefits; their lifecycle stays HTTP. Pi-specific rows arrive via `before_agent_start` ensure + resume (`plugin-session-protocol/spec.md:310`) and shutdown `/end` only for closing reasons (`:313-314`) — matching the issue's "all abandoned".

## Recommendation

**C (A + B-narrow + D3)**. A is three guarded lines and stops the snowball on every real transport; B-narrow is one narrow service lookup that removes the first-ghost mint without touching auto-attach or the no-guess rule's fresh path; D3 costs one description clause. Both need a delta spec on the two quoted `sessions` requirements — unavoidable for any behavior change here. E and B-wide stay out unless the owner opts in.

## Open product decisions for the pre-proposal gate

1. **Adopt the sole stale-but-active row (B)?** The edge: a killed client's zombie row can be adopted by a new conversation whose plugin ensure failed. Accept, or ship A-only (+ D4 plugin-side) and keep minting on zero-fresh-rows?
2. **Residual mint under genuine ambiguity:** keep the spec-mandated mint (one extra row per ambiguity onset per transport), or delta-spec provenance-based adoption (E)?
3. **B-wide or B-narrow:** should auto-attach (`memory.save`) also adopt a sole stale row (fixes `session_id = NULL` fragmentation), or is that a separate change?
4. **Post-sweep mint:** accept the weekend-idle mint (24 h abandonment is by design), or treat "idle < abandon window should reuse" as in-scope?
5. **Sequencing:** `expose-session-start-agent` is implemented but unarchived and owns the same description/pins — stack this fix after its archive, or rebase now?

## Proposed change name

`fix-pi-ghost-sessions` — confirmed. The mechanism is client-agnostic (any model calling `memory.session_start` after an idle gap), but the name anchors the issue (#377) and the repro; the proposal should state the client-agnostic scope explicitly.
