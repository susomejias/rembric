## Context

Three defects share one root: the per-transport roots-discovery state is a module-level `Set` with no owner and no lifetime.

```
roots-discovery.ts:44   const discoveryRunForTransport = new Set<string>()   // process-global
roots-discovery.ts:50   markDiscoveryRun(tokenId, mcpSessionId)              // add
roots-discovery.ts:54   isDiscoveryRun(tokenId, mcpSessionId)                // read; :96 and :111 short-circuit on it
roots-discovery.ts:59   resetDiscoveryState()                                // clear() — no key, "Test-only helper"
mcp/server.ts:534-535   await import(...); resetDiscoveryState()             // the only production caller
roots-discovery.ts:156  refreshRootsAfterChange(deps, ctx)                   // no caller at all
```

`McpTransportManager.getOrCreate` builds one `McpServer` per transport (`mcp/transport.ts:53`) and drops it from `sessions` on `onclose` (`:69-73`); the sentinel has no such path. `SessionRouter.entries` and `SessionRouter.discoveryInFlight` use the identical `tokenId::mcpSessionId` key (`session-router.ts:44-46`) and are likewise never evicted — so "evict the sentinel on close" would be a lone exception in a module where nothing is evicted, whereas "give the state an owner" is a rule the surrounding code can follow.

What this design must not disturb, both settled and archived this morning in `2026-08-09-route-roots-discovery-over-the-tool-call-stream`: the delivery mechanism (`roots/list` correlated with the in-flight tool call, `projects/spec.md:87-89`) and the slot-consumption rule (an answer consumes, an attempt does not, `:91`).

Measurements this design rests on, all from a real MCP edge with a passing control (see `## Why`): CROSS `roots/list` 1 → 2 on an unrelated transport with its scope and `source` unchanged; EMITTER `suggestedSlugs` `[] → ['probe-d1-new']` with the active project unchanged; GONE-QUIET 5 ms → 2507 ms → 2506 ms per tool call with `roots/list` reaching 3; and ≈120 bytes per leaked sentinel entry (22.9 MB at 200 000 entries).

## Goals / Non-Goals

**Goals:**

- `list_changed` refreshes suggestions on the transport that emitted it, through `refreshRootsAfterChange`, under an in-flight tool call.
- A transport's discovery state is unreachable from any other transport, so the number of `roots/list` requests a client receives does not depend on how many other connections the process serves.
- That state is released with the connection's server instance, without an eviction hook and without plumbing `tokenId` into the transport manager.
- The cost of a `list_changed` to a client that has stopped answering is bounded at one budget expiry.

**Non-Goals:**

- Retuning `ROOTS_LIST_TIMEOUT_MS` (D7).
- Revisiting the delivery mechanism or the slot-consumption rule for _initial_ discovery — both were settled this morning and are inputs here, not questions.
- Evicting `SessionRouter.entries` / `discoveryInFlight`, or the `McpServer` objects that `McpTransportManager.sessions` retains for a client that vanishes without a DELETE. All three leak on the same key shape; all three are out of scope and recorded in Open Questions with what is known about their size.
- Suppressing a suggestion that names the transport's own active project (Open Questions Q2).
- Any change to `mcp/_shared.ts`, `mcp/transport.ts`, or any tool signature.

## Decisions

### D1 — Wire `refreshRootsAfterChange`; do not delete it

It is the only implementation that satisfies both published requirements at once. `projects/spec.md:143-147` requires `list_changed` to move `suggestedSlugs` without switching; `:136-141` forbids re-issuing `roots/list` on an answered transport. `refreshRootsAfterChange` neither reads nor writes the answered sentinel and only ever calls `setSuggestedSlugs` (`roots-discovery.ts:167`, `:172`, `:176`), so it refreshes without spending or discarding the once-only slot. The current substitute — clear the sentinel and let `maybeDiscoverViaRoots` re-run — satisfies `:143-147` by breaking `:136-141` on every live transport.

**Alternatives considered.** _Delete it and keep the reset:_ rejected, it is the defect. _Delete it and let the reset become per-transport:_ satisfies `:143-147` and `:136-141`-for-others, but still discards the emitting transport's definitive answer, which is the measured 2507 ms GONE-QUIET stall; it also lets `list_changed` **activate** a project on a transport with no active one, which `:143-147`'s "SHALL NOT switch" was written to prevent. _Delete it as dead-code cleanup:_ rejected on principle as well as on the merits — the function has never had a test, so deleting it would retire a specified behaviour with no test going red to say so.

### D2 — The notification handler sets a per-transport flag; it resets nothing

The handler has no request context, which is the honest reason the global reset exists (`mcp/server.ts:523-533` says so). It does have the `McpServer` it was registered on, and there is exactly one per transport (`mcp/transport.ts:53`), so per-server state is per-transport state with no identity lookup at all.

**Alternatives considered.** _Read `getRequestContext()` / `routerKey()` inside the handler:_ plausible — `http.ts:384` wraps `transport.handleRequest` in `runWithContext`, and AsyncLocalStorage survives the SDK's synchronous notification dispatch — but **unverified**, and it buys nothing here, because D3 removes the need for the identity. Left unmeasured deliberately rather than claimed. _Issue the refresh from the handler directly:_ rejected under D3 of the archived change — with no in-flight tool call there is no request id to correlate, so the `roots/list` would be routed only to the optional standalone GET stream and "discarded by the transport with no error, no `onerror` callback and no log at any layer" (`projects/spec.md:89`). That is the failure the archived change removed; re-introducing it on a second path would be a regression dressed as a fix.

### D3 — All per-transport discovery state lives in one record owned by the connection's `McpServer`

Replace the module-global `Set` with a per-server record — `{ answered: Set<string>; refreshPending: boolean }` — reached through a `WeakMap<McpServer, DiscoveryState>` inside `roots-discovery.ts`. Every discovery entry point already receives the server (`RootsDiscoveryDeps.server`, built in `_shared.ts:80-88` from `deps.getServer()`), so no signature changes anywhere and no threading through tool deps.

This is the single mechanism that closes defect 2 (there is no global left to reset; a transport cannot name another's record) and defect 4 (the record is unreachable once its server is, so it needs no eviction hook and no `tokenId` in the transport manager).

The inner keying by `(tokenId, mcpSessionId)` is **kept unchanged**. Nothing binds a transport to the token that initialised it, so one transport can legitimately carry entries for two tokens; collapsing the key to the server would change _who gets asked_, and this change is about lifetime and blast radius, not about that.

**Alternatives considered.** _Keep the global `Set`, scope the reset by key, add eviction on `transport.onclose`:_ rejected on three counts — it depends on D2's unverified AsyncLocalStorage reading; `McpTransportManager` does not know the token (`getOrCreate` receives only `requestedSlug`), so eviction would need it plumbed from `http.ts`; and even then it could not evict entries a _second_ token created on the same `mcp-session-id`. It is also strictly weaker: `onclose` fires on an explicit DELETE or shutdown, so a client that simply vanishes would still leak. _Thread an explicit `DiscoveryState` through every tool deps object beside `getServer`:_ more explicit than a `WeakMap` and was the runner-up, rejected because it widens six deps interfaces and every construction site for no behavioural gain, and an optional field silently reverts to "no state" for a deps object that forgets it — the same "absent from the list of call sites" failure mode `mcp-api/spec.md:1823` already forbids for the tool-call identity. _A `Symbol`-keyed property on the server instance:_ same ownership, worse types.

### D4 — The refresh slot is consumed by the attempt, not by the answer

Deliberately the inverse of the initial-discovery rule (archived D3, `projects/spec.md:91`), and the asymmetry in consequence is the whole reason. A lost _initial_ discovery misscopes the connection permanently and every append-only row it writes with it. A lost _refresh_ leaves a stale advisory string in `pendingSuggestedSlugs`, whose sole consumer is `project-tools.ts:236` (`project.current`), which activates nothing. Retry-until-answered on the refresh path is exactly what the GONE-QUIET arm measured: 2507 ms on every scope-resolving tool call, for the life of the connection. Consuming on attempt bounds a notification's cost to one budget expiry.

The flag is therefore cleared _before_ the `roots/list` is awaited, not after, so a rejection or a timeout cannot leave it set.

**Alternative considered.** _Mirror the initial-discovery rule for symmetry:_ rejected — symmetry here buys a permanent stall in exchange for eventually-correct advisory text.

### D5 — The refresh never touches the answered sentinel and never activates

`refreshRootsAfterChange` stays suggestion-only. Consequences, all load-bearing: `list_changed` can no longer discard a definitive outcome (kills the GONE-QUIET regression at its source); it can never move a connection's project, so no path introduced here can change a resolved scope; and a transport whose client answered once is still asked at most once for _discovery_ purposes, satisfying `:136-141` as qualified by the delta.

### D6 — A `list_changed` on a transport with no answered discovery runs ordinary discovery, not a refresh

If the slot is unconsumed there is no suggestion to refresh, and the `roots/list` that ordinary discovery is about to issue already reflects the new roots. So `ensureRootsDiscoveryRun` checks in this order: path slug → in-flight promise → _unanswered slot_ (ordinary discovery, clearing `refreshPending` as it goes) → _`refreshPending`_ (refresh) → return. Both branches share the existing single-flight promise so two concurrent tool calls cannot both issue a `roots/list`.

### D7 — `ROOTS_LIST_TIMEOUT_MS` stays 2500

Explicitly deferred, with the reason on the record. The value's original justification was the diagnosis the archived change refuted, so there is no evidence for 2500 and none against it; and retuning is blocked on a question nobody has answered — which of the five shipped clients actually advertise `capabilities.roots` (`archive/2026-08-09-…/design.md:140`, still open, still unanswerable from the bridge). The GONE-QUIET measurement makes the budget visible but does not argue for moving it: under D4 the whole exposure per notification is one expiry.

### D8 — `resetDiscoveryState` is deleted

Under D3 each test fixture builds its own fake server, so the per-server record is fresh by construction and the `beforeEach` reset in `roots-discovery.test.ts:120` has nothing to clear. Grep confirms that file is its only caller. This deletion is the opposite case to D1: it removes a helper that existed only to paper over module-global state, and there is no requirement anywhere that describes it.

### D9 — The invariant is asserted, not just intended

A future contributor can re-introduce a module-level `Set` in `roots-discovery.ts` and nothing behavioural fails fast, because the isolation only breaks when two transports are live. So the change adds a grep-style assertion in `apps/server/src/test/invariants.test.ts` (where the repo's other confinement gates live) that the discovery module declares no module-level mutable registry, alongside the two-transport behavioural arm. Belt and braces, on the reasoning that this exact defect survived two recordings.

## Risks / Trade-offs

- **[Trade-off] `WeakMap<McpServer, …>` ownership is implicit where a threaded field would be explicit.** → Accepted because the alternative widens six deps interfaces and introduces an optional field that fails silently when omitted; the implicitness is one line of code in one module, and D9 asserts the property that matters.
- **[Risk] A unit test that reuses one fake `server` object across what it intends to be two transports would now share state, silently changing what it asserts.** → Mitigation: the two-transport arms construct two distinct server objects, and the real-edge arms in `mcp-integration.test.ts` use two real connections, where the 1:1 server-per-transport mapping is the production one. Every existing `roots-discovery.test.ts` arm already builds a fresh fake per `harness()` call, so per-server state strengthens their isolation rather than weakening it.
- **[Risk] Deleting `resetDiscoveryState` could strand a test outside the module.** → Mitigation: `grep -rn resetDiscoveryState apps/server/src` before and after; it must find only `roots-discovery.test.ts` before and nothing after.
- **[Trade-off] The refresh still costs one `roots/list` on the emitting transport, so a client that emits `list_changed` in a tight loop can still generate one round trip per notification.** → Accepted: that is a client-driven cost proportional to a client-driven event, unlike today's cost, which is proportional to how many _other_ connections the process serves. Not rate-limited here, because no measurement shows a client doing it.
- **[Risk] The refresh path is the only way `refreshRootsAfterChange` can now be reached, and it has never had a test.** → Mitigation: tasks require a test that fails without the wiring (`mutate.mjs` against the flag check), plus an arm asserting the empty-roots branch clears suggestions (`roots-discovery.ts:167`), which no test covers today.
- **[Trade-off] The residual leak.** → Accepted: after D3 the sentinel's lifetime is the server instance's, so it is subsumed by `McpTransportManager.sessions` retaining `{server, transport}` for a client that vanishes without a DELETE — a pre-existing leak of a whole `McpServer`, orders of magnitude larger than the ≈120 bytes measured here. Fixing that is a different change with a different risk profile (deciding when a silent client is gone).

## Open Questions

1. **Should the identical leak in `SessionRouter.entries` and `discoveryInFlight` be closed, and by what signal?** Not decided here. Both use the same `tokenId::mcpSessionId` key (`session-router.ts:44-46`) and have no removal path; `RouterEntry` carries four fields plus an array, so per entry it is several times the ≈120 bytes measured for the sentinel — still small in absolute terms at 200 sessions/day. The blocking sub-question is the signal: `transport.onclose` fires on an explicit DELETE or shutdown, and clients that simply vanish never produce one, so eviction on close would fix the well-behaved case only. Default if nobody objects: leave it, and pair it with the `McpTransportManager.sessions` retention it is dwarfed by, since both need the same "when is a silent client gone" answer.
2. **Should a suggestion naming the transport's own active project be suppressed?** Deliberately not decided. Measured today (CROSS arm): a transport scoped to `probe-d2-b` was told `suggestedSlugs: ['probe-d2-b']`. After D3 that specific route is closed, but the emitting transport can still reach it when a client emits `list_changed` whose roots did not actually change. It is cosmetic — `project.use` with the already-active slug is idempotent (`project-tools.ts:143-151`) — and suppressing it means modifying `mcp-api/spec.md:1122`, which defines `suggestedSlugs` as "the most recent `roots/list` derivation that did NOT auto-activate", i.e. a wider conversation about what that list means. Default: leave it, and let a change that owns `project.current`'s contract decide.
3. **Is `getRequestContext()` live inside an SDK notification handler?** Recorded unanswered on purpose. It would settle whether a scoped-reset design was ever available, and it is one instrumented `list_changed` away — but D3 needs no answer, so measuring it would be work whose result changes nothing here. If a future change does need per-transport identity in a notification handler (a `sampling` or `elicitation` callback would), this is the first thing to measure, and it needs a control: a tool handler in the same server asserting the store _is_ visible.
