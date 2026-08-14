## Context

Two registries keyed per MCP transport have no removal path (`## Why` in the proposal has the verbatim evidence for each):

```
server/session-router.ts:49    entries = new Map<string, RouterEntry>()          // no delete, ever
server/session-router.ts:110   clearSession() → e.rembricSessionId = null        // docstring says "clear an entire entry"
server/session-router.ts:136   resetAll() → entries.clear()                      // "Test-only helper"
mcp/transport.ts:37            sessions = new Map<string, {server, transport}>() // McpServer + transport per entry
mcp/transport.ts:69-73         onclose → sessions.delete(id)                     // only on DELETE or shutdown
mcp/roots-discovery.ts:144-149 setDiscoveryPromise → finally clearDiscoveryPromise  // bounded; NOT a leak
```

The decision this was blocked on has been made by the repo owner and is an input here, not a question: **reuse `TRANSPORT_STALENESS_MS`** (30 min, `services/agent-sessions.ts:27`) as the shared eviction threshold, evaluated by a periodic sweep against the staleness of the session row behind the transport — the same precedent `findActiveForTransport` already uses to decide when an `active` row stops being a transport-resolution candidate (`db/repositories/agent-sessions-repository.ts:154-174`).

Two facts constrain every mechanism below, both read from current source rather than assumed:

1. **A missing router entry does not fail; it defaults.** `resolveEffectiveScope` ends with `if (!entry || !project) return defaultProjectScope(deps.projects)` (`mcp/_shared.ts:92`). So evicting a router entry that carries a `roots` or `tool-explicit` project pin, while its transport can still serve a tool call, silently redirects that connection's writes to the default project. `sessions.project_id` is immutable and `memory` rows are append-only with no reassignment verb, so those rows are misfiled permanently.
2. **Neither of the two MCP clients whose code is readable from here recovers from a `404` on its own.** The SDK client throws `StreamableHTTPError(response.status, …)` on a non-OK POST (`client/streamableHttp.js:364`) and leaves recovery to the host; Pi's own client throws on any non-2xx (`apps/plugin/.pi-plugin/index.ts:143-146`) and calls `initialize` exactly once, at activation (`:314`). Server-side eviction is therefore only as safe as the client-side recovery path, which is why one is specified here.

Everything this change touches is in-process state that already starts cold on every boot, so there is no migration, no populated-table risk and no derived data to invalidate.

## Goals / Non-Goals

**Goals:**

- Both leaking registries are bounded by the number of transports that are actually live, not by the process's uptime.
- One predicate, one threshold, one code path for both registries — reusing `TRANSPORT_STALENESS_MS`, adding no second policy and no new environment knob.
- Eviction can never change the project a live connection resolves to.
- An evicted client can recover, and the client this repo owns does so without operator action.
- The pass reclaims state on a server whose clients have all vanished, i.e. without depending on new session traffic.

**Non-Goals:**

- Evicting `SessionRouter.discoveryInFlight` (D2 — it does not leak).
- Touching the per-server roots-discovery `WeakMap` (`mcp/roots-discovery.ts`), settled by `fix-the-roots-discovery-lifecycle`.
- A capacity bound / LRU, or making the threshold configurable (D3).
- Changing `findActiveForTransport`'s refusal to guess under ambiguity, or the 24-hour `SESSION_ABANDON_AFTER_MS` retirement window. Both stay exactly as they are.
- Persisting any of this state across restarts.
- Fixing recovery in the four clients whose MCP client belongs to their host (D8 records what is knowable about them).

## Decisions

### D1 — Stale means both clocks, not either

A transport is stale when, for the same `TRANSPORT_STALENESS_MS` window:

- **(a) no live session row** exists for any identity that transport carries — live being `status='active'` **and** `deleted_at IS NULL` **and** `COALESCE(last_activity_at, started_at) >= now − TRANSPORT_STALENESS_MS`; and
- **(b) the transport has handled no MCP request** within that window.

Each half covers the other's blind spot, and the failure modes are asymmetric enough that neither alone is defensible:

- **(a) alone** evicts a live client that has no session row to protect it. A generic MCP client, a read-only connection, an operator's `curl`, or a path-scoped Pi connection between sessions all satisfy (a) permanently, from the first pass onward.
- **(b) alone** is the bare idle timeout the issue warned about. `ensure()` bumps `last_activity_at` on every hook POST (`services/agent-sessions.ts:213-217`), so a Claude Code or Codex session can be demonstrably alive — turn after turn — while the model calls no MCP tool for an hour. Evicting it would drop its pin and, before D5, misscope it.

**Alternatives considered.** _Anchor solely on the pinned `rembricSessionId`:_ this is the literal reading of the decision and it fixes almost nothing, because the router pin is written only by `memory.session_start` / `memory.session_resume`, and the shipped plugins do not call them — the session lifecycle is HTTP (`http-api/spec.md:318`: the server "SHALL NOT eagerly populate the `SessionRouter`"). The dominant real entry is created by roots discovery or `project.use` with `rembricSessionId` null forever, so a pin-only predicate would leave the actual leak intact. _Use `findActiveForTransport` itself for (a):_ rejected, it returns nothing when two rows match, because it must not _choose_ a session; eviction chooses nothing, so importing that rule would evict precisely the busiest transports. An existence read is the correct shape. _Drop (b) and accept the risk:_ rejected under D5's reasoning — (b) is what keeps the sessionless-but-live case out of the eviction set entirely rather than relying on recovery to paper over it.

### D2 — `discoveryInFlight` is out of scope, and the spec says why

`singleFlight` clears the promise in a `finally` on every settled attempt (`roots-discovery.ts:145-149`), and `grep -rn setDiscoveryPromise apps/server/src` finds one production writer (`:144`) plus two test call sites. The map is bounded by concurrent in-flight attempts. The issue's evidence table lists it as a leak; that row is wrong, and the delta records the correction normatively so a future reader does not add an eviction hook for a map that already has one.

**Alternative considered.** _Evict it anyway, "for symmetry":_ rejected. It would race the `finally` and could delete a live single-flight promise, converting a bounded map into a correctness bug — and the identity check in `clearDiscoveryPromise` (`:129-132`) exists precisely because deleting the wrong promise here matters.

### D3 — One threshold, reused, not configurable

The pass reads `TRANSPORT_STALENESS_MS` from `services/agent-sessions.ts` and introduces no constant of its own and no environment variable. The point of reusing it is that the process's in-process view of a transport and the database's view of the session behind it expire on the same clock; a second knob is a second thing that can disagree with the first, and the disagreement would show up as either a leak or a misscope, neither of which an operator could diagnose. This is asserted, not just intended: a grep-style case in `invariants.test.ts` requires the reaper module to contain no millisecond literal (D9).

**Alternatives considered.** _A separate `TRANSPORT_EVICT_AFTER_MS` env var:_ rejected as an operator-visible knob nobody can set correctly without knowing both clocks. _A capacity bound (LRU):_ rejected — it is decidable without a product answer, which is what recommends it, but it makes eviction depend on load rather than on liveness, so under pressure it evicts the transports with pins first and changes what a later call resolves to. _Reuse `SESSION_ABANDON_AFTER_MS` (24 h) instead:_ rejected, that window governs when a row is declared `abandoned`, which is a much later and much weaker statement than "this transport is no longer resolving anything".

### D4 — The pass runs on the existing 30-minute reaper tick, not on the consolidation sweep

The owner's brief named the consolidation sweep as the cadence host; the reaper is chosen instead, and this is a change of host, not of rule. The reasons are mechanical:

- The consolidation sweep is throttled per scope by `DEFAULT_MIN_INTERVAL_MS = 24h` (`consolidation/runner.ts:70,121-124`), so an eviction gated by it would lag the 30-minute threshold it enforces by up to a day.
- It is reached only from a session start (`sweepFor`, `:89-96`, wired at `bootstrap.ts:307-317`), so a server whose clients have all vanished — the exact state that leaks — would never evict anything.
- It is project-scoped; transport state is process-wide and not project-scoped at all.
- The reaper (`bootstrap.ts:274-286`) already ticks every `30 * 60_000` — numerically the same window — and already exists to retire what a dead client left behind. Its comment names `findActiveForTransport` as the reason it exists, i.e. it is already the periodic pass for this concept.

Net effect is what the brief asked for: an existing periodic pass gains work; no new timer, no cron.

**Alternatives considered.** _Consolidation sweep as named:_ rejected on the four points above; recorded as reversible in Open Questions. _A dedicated `setInterval`:_ rejected, a third timer for a 30-minute housekeeping pass when a 30-minute housekeeping pass already exists. _Evict opportunistically on each `/mcp` request:_ rejected — it puts a scan on the hot path and, again, does nothing once traffic stops.

### D5 — Router state and transport state are evicted together, or not at all

The pass never removes a `SessionRouter` entry while `McpTransportManager` still holds that `mcp-session-id`. Because `resolveEffectiveScope` defaults rather than fails on a missing entry (`_shared.ts:92`), a lone router eviction is a silent scope change on a live connection; because the transport is evicted with it, the connection's next request cannot be served under the old id at all (D6), so it re-initializes and re-derives its scope from the URL path or from a fresh roots discovery on a fresh `McpServer` — the per-server `WeakMap` from `fix-the-roots-discovery-lifecycle` makes the new connection's discovery slot unconsumed by construction.

**Alternative considered.** _Evict only the router half (cheaper, no client-visible effect):_ rejected — it is the one variant that can misfile append-only rows, and it leaves the expensive registry untouched, which is the leak the issue calls out as "the expensive one".

### D6 — An unknown session id earns `404`, before anything is constructed

`http.ts:376-380` hands any `mcp-session-id` straight to `getOrCreate`, which builds a fresh `McpServer` and transport when it does not recognise the id (`transport.ts:48-53`) — the full tool surface, per request, for an id the process does not have. The SDK then refuses the request with `400 -32000 "Bad Request: Server not initialized"` (`webStandardStreamableHttp.js:590-593`), because `_initialized` is false on a pair that has never handled an `initialize`. A `400` is not the protocol's signal for "your session is gone"; `404 -32001 Session not found` is, and the SDK emits exactly that for a _mismatched_ id (`:602-604`). So the fix aligns the entry point with the transport it fronts, and stops constructing a server to answer a refusal.

**Evidence status, stated rather than implied:** the `400` is read from the SDK's source, not executed. Task 1.3 reproduces it at a real edge with a control before anything is built on it.

**Alternatives considered.** _Leave the `400`:_ rejected, it makes eviction indistinguishable from a broken server, and no conformant client has a reason to re-initialize on it. _Recreate a pair transparently under the old id so the client never notices:_ investigated and rejected as unavailable — the SDK sets `_initialized` only when it handles an `initialize` request, so an adopted pair would refuse every request anyway; faking an initialize server-side is not on the table. _Answer `404` but keep constructing the pair:_ pointless allocation on an error path.

### D7 — Pi re-initializes once, on `404` only, and retries the original call

`apps/plugin/.pi-plugin/index.ts` is the only MCP client in this repository (Pi ships none, by its own design — `pi-plugin/spec.md:7`). Its `send()` throws on every non-2xx (`:143-146`), and `initialize` runs once at activation (`:314`), so a single `404` is terminal for the life of the Pi process: every later `tools/call` fails and no code path re-establishes the session. That is a latent non-conformance today; eviction is what makes it reachable, so it is fixed here rather than left for the first operator to hit it.

Scope is deliberately narrow: `404` only — never `401`, `403`, `429` or `5xx`, where a silent re-initialize would mask an auth or capacity failure — and exactly one retry, never a loop. Retrying a **write** is safe for a specific reason, not by optimism: the `404` is produced at the transport boundary before any handler runs (D6), so the refused call cannot have been half-applied. Tools are not re-registered, since the host already holds the registration and the rebuilt connection exposes the same surface.

**Alternatives considered.** _Retry on any non-2xx:_ rejected, it would replay writes after a `5xx` that may have applied. _Re-initialize lazily on the next session start instead of on the failing call:_ rejected, it leaves the current turn broken. _Ship the eviction without the Pi fix and file it separately:_ tempting for review size, and recorded in Open Questions — rejected as the default because the two halves land in one release train and shipping the server half first is knowingly shipping a wedge for one client.

### D8 — What the other four clients do is recorded, not assumed

Claude Code, Codex CLI, Hermes and opencode reach `/mcp` through their host's MCP client, which for the SDK-based ones surfaces a `404` as `StreamableHTTPError` (`client/streamableHttp.js:364`) and delegates recovery to the host. This repository cannot verify a host's reconnection policy from inside itself. So the change does not claim they recover; task 7 measures Claude Code against the real dev stack, and any client left unverified is recorded as unverified in the task notes rather than described as fine.

### D9 — The predicate lives in one module, and the reuse is asserted

One new module (`server/transport-state-reaper.ts`) owns the predicate and the pass for both registries; the registries expose the minimum reads and removals it needs and no policy of their own. Two grep-style cases in `invariants.test.ts`: the reaper module declares no millisecond literal (so the threshold cannot be forked, D3), and neither registry gains its own staleness rule. A behavioural test alone would not catch a forked constant — both copies would agree until someone changed one.

## Risks / Trade-offs

- **[Risk] A live client that is quiet on both clocks is evicted and must re-initialize.** A user who walks away for 30 minutes with a session that has no live row (or whose row went stale) returns to a connection whose next call is refused. → Mitigation: the conjunction in D1 keeps every client whose host is still working out of the eviction set; D6 makes the refusal the protocol's recoverable one; D7 fixes the one client we own; task 7 must observe an evicted Claude Code connection recovering against `dev:docker:up` before this lands, and if it does not, Open Question 2's fallback applies.
- **[Risk] `lastSeenAt` measures requests, not sockets, so a client holding an open standalone SSE stream and making no request looks idle.** The SDK client opens that stream on connect, so this is the common shape for the four host-driven clients. → Mitigation: half (a) still protects any such client whose session row is live; the residual case is a genuinely idle connection, where the cost is one reconnect — the same cost an idle disconnect would have had. Recorded as Open Question 3 with a cheap upgrade path (count a stream open as activity) if the measurement shows it matters.
- **[Risk] The `404` change alters the response to a request naming a _never-known_ id, not only an evicted one** — for example a client that reconnects with a stale id after a server restart. → Mitigation: this is strictly an improvement in that case too (`404` is what the protocol defines and what a restart should say), but it is a behaviour change on a shared entry point, so it needs its own test arm and its own line in the smoke, not a footnote in the eviction ones.
- **[Trade-off] The pass costs one existence query per stale-candidate transport, every 30 minutes.** → Accepted: it hits `sessions_token_status_idx` (existing, `db/schema/agent-sessions.ts:101`) and the candidate set is exactly the transports that failed the free in-memory half first. The ordering matters and is specified in tasks: evaluate (b) in memory before (a) in SQL, so a busy process pays almost nothing.
- **[Trade-off] Pi's fix widens the change into the plugin tree, bumping the unified `plugin` version for a server-driven reason.** → Accepted: that is exactly how the single-version track is designed to behave, and the CHANGELOG's conventional-commit scope says what actually changed.
- **[Risk] A test that asserts "the registries are empty after the pass" would pass vacuously if the harness never populated them.** → Mitigation: every arm asserts a non-empty live control alongside the evicted count — the registries must end holding exactly the live transports, not zero.
- **[Trade-off] Nothing here is persisted, so a restart still resets every registry.** → Accepted, and unchanged from today: the boot-time `abandonStale` pass (`bootstrap.ts:117-122`) already exists to reconcile the DB with a cold router.

## Migration Plan

No schema change, no data migration, no backfill. On the first boot after upgrade the registries start empty exactly as they do today, and the first reaper tick 30 minutes later finds nothing to evict on a freshly-started process. Rollback is a code revert with no data consequence; the only cross-version consideration is that a rolled-back server stops sending `404` for unknown ids, which the Pi client's D7 path tolerates (it only ever triggers on a `404` it now will not receive).

## Open Questions

1. **Should the pass hang off the consolidation sweep after all, as the brief named?** Default chosen and implemented: the 30-minute reaper (D4). The four reasons are mechanical rather than stylistic, and moving it later is a one-line change of call site with no spec impact — the delta specifies "an existing process-wide periodic pass", not which one. Say so if the consolidation runner is wanted as the host and the tasks move.
2. **What happens to an evicted connection under Claude Code, Codex, opencode and Hermes?** Deliberately unanswered here and required before merge (task 7), because it cannot be answered by reading this repository (D8). Default if a host turns out not to re-initialize: keep the router half plus the unconditional orphan clause (both provably safe), and gate the transport half behind a multiple of the threshold, recorded as a follow-up rather than silently widened.
3. **Should an open standalone SSE stream count as transport activity?** Not decided. It would remove the false-idle case in Risk 2, and the SDK does not expose stream state through a public API, so it needs either an internal read or a wrapper — neither justified until a measurement shows an idle-but-streaming client being evicted while its user is present.
4. **Should `SessionRouter.entries` keep its own `lastSeenAt` too?** No, and the reason is worth recording: the router is written by tool handlers and read by the resolver, which means "entry touched" and "transport alive" would diverge for a transport whose requests never reach a scope-resolving tool. The transport manager is the only place that sees every request, so it is the only honest home for that clock.
5. **Does the empty-session purge interact with (a)?** `purgeEmpty` physically deletes empty session rows (`consolidation/runner.ts:110-112`), which makes half (a) true earlier for a transport whose only row was empty. Believed harmless — an empty row was never protecting anything — but it is the one interaction between this pass and an existing purge, and task 5.6 pins it with a test rather than leaving it to reasoning.
