# Give per-transport in-process state a lifetime, keyed on the staleness rule that already exists

## Why

Two in-process registries keyed per MCP transport grow for the life of the process and have no removal path. Issue #328 asked for a third; it does not leak, and the number the issue publishes describes neither of the two that do. Both corrections are stated here so nobody re-derives the wrong evidence.

**Leak 1 — `SessionRouter.entries`** (`apps/server/src/server/session-router.ts:49`). The only method that looks like a remover is not one:

```ts
/** Clear an entire transport entry (used by `memory.session_end`). */
clearSession(tokenId: string, mcpSessionId: string): void {
  const e = this.entries.get(entryKey(tokenId, mcpSessionId));
  if (e) e.rembricSessionId = null;          // session-router.ts:110-113
}
```

The docstring says "clear an entire transport entry"; the body nulls one field. `entries.delete` appears nowhere; the only `.delete(` in the file is `discoveryInFlight`'s (`:131`), and the only `entries.clear()` is `resetAll()`, whose own docstring says "Test-only helper" (`:134-138`). So a `RouterEntry` — four fields plus an array — is retained for every distinct `(tokenId, mcp-session-id)` the process has ever served, including every client that disconnected cleanly.

**Leak 2 — `McpTransportManager.sessions`** (`apps/server/src/mcp/transport.ts:37`). This one retains an entire `{ server: McpServer, transport: StreamableHTTPServerTransport }` pair, and it is deleted in exactly one place:

```ts
transport.onclose = () => {
  if (transport.sessionId) {
    this.sessions.delete(transport.sessionId); // transport.ts:69-73
  }
};
```

`onclose` fires on an explicit `DELETE` or on shutdown (`close()`, `:79-85`). A killed agent, a dropped tunnel or a `docker stop` on the client side produces neither, which is the ordinary end of a CLI session. Nothing else in the file removes an entry.

**Correction 1 — `SessionRouter.discoveryInFlight` does NOT leak, and is out of scope.** Its sole production writer is `singleFlight`, which removes the promise in a `finally` on every settled attempt:

```ts
deps.router.setDiscoveryPromise(ctx.tokenId, ctx.mcpSessionId, promise);
try {
  await promise;
} finally {
  deps.router.clearDiscoveryPromise(ctx.tokenId, ctx.mcpSessionId, promise); // roots-discovery.ts:144-149
}
```

`grep -rn setDiscoveryPromise apps/server/src` outside `session-router.ts` returns `roots-discovery.ts:144` and two test call sites. The map is therefore bounded by _concurrently in-flight_ discovery attempts, never by cumulative distinct sessions. The issue's three-registry table is wrong on this row.

**Correction 2 — the `≈120 B/entry, 22.9 MB at 200 000` figure does not characterise either leak.** It was measured against the module-global discovery sentinel `Set<string>` in `archive/2026-08-09-fix-the-roots-discovery-lifecycle` (its `## Why`, point 4), and that `Set` no longer exists: the same change moved the state into a `WeakMap<McpServer, …>` released with the connection. A `Set` of short strings is also the cheapest possible shape — a `RouterEntry` object is several times that, and a retained `McpServer` with its full registered tool surface plus a `StreamableHTTPServerTransport` is orders of magnitude more. **This proposal publishes no size figure**, because none has been measured for the two registries that leak; producing it before and after is task 1, and it is the number the issue should have had.

**Why now, and why it was blocked.** Every candidate fix needed the same undecided answer — when is a silent client gone. That answer now exists and is not invented here: `TRANSPORT_STALENESS_MS` (30 min, `apps/server/src/services/agent-sessions.ts:27`) already decides when an `active` session row stops being a candidate for transport resolution (`findActiveForTransport`, `agent-sessions-repository.ts:154-174`). Reusing it makes the process's in-process view of a transport expire on the same clock as the database's view of the session behind it, instead of adding a second policy that can disagree with the first.

## What Changes

- **One eviction rule, one threshold, both registries.** A transport's in-process state is evicted when the transport is stale, and stale means `TRANSPORT_STALENESS_MS` on **two** clocks at once: the transport has handled no MCP request within the window, **and** no live session row (`status='active'`, not soft-deleted, `COALESCE(last_activity_at, started_at)` inside the window) exists for any identity that transport carries. No new constant, no new environment knob.
- **Both halves of the conjunction are load-bearing, and each covers the other's blind spot.** The database clock alone would evict a live client that has no session row at all (a generic MCP client, or a read-only connection); the request clock alone is a bare idle timeout, which would evict a client whose host is actively POSTing session lifecycle over HTTP — `ensure()` bumps `last_activity_at` on every turn (`agent-sessions.ts:213-217`) while the model may not call an MCP tool for an hour.
- **Router state and transport state are evicted together, never separately.** This is the anti-misscope guard, not tidiness: `resolveEffectiveScope` falls back to `defaultProjectScope` when the router entry is missing (`mcp/_shared.ts:90-92`), so dropping a `project.use`/roots pin under a still-live transport would silently redirect that connection's writes into the default project — into append-only rows with no reassignment verb.
- **State whose transport is already gone is evicted unconditionally, with no window.** A router entry whose `mcp-session-id` is absent from `McpTransportManager.sessions` cannot influence any future resolution, because no request can be served under that id. This is the graceful-close case — `onclose` reclaims the transport and leaves the entry behind — and it needs no staleness argument at all.
- **The pass runs on the existing 30-minute stale-session reaper (`bootstrap.ts:274-286`), not on the consolidation sweep.** Same intent as "piggyback on an existing periodic pass", different host, and the reason is mechanical: the consolidation sweep is throttled per scope at `DEFAULT_MIN_INTERVAL_MS = 24h` (`consolidation/runner.ts:70`) and only fires from a session start (`sweepFor`), so eviction would lag the threshold it enforces by up to a day and would never run at all on a server whose clients have all vanished — precisely the state this change exists to clean up. The reaper's period is already exactly `TRANSPORT_STALENESS_MS`, and its purpose is already "retire what a dead client left behind". No new timer is introduced.
- **Eviction is made recoverable, because today it would not be.** A request naming an id the manager does not know currently builds a throwaway `McpServer` (`transport.ts:53`, the full tool surface) and then earns `400 -32000 "Bad Request: Server not initialized"` from the SDK (`webStandardStreamableHttp.js:590-593`) — a code that tells a conformant client nothing about restarting. The `/mcp` entry point will refuse an unknown session id with `404 -32001 Session not found`, the signal the Streamable HTTP transport defines for exactly this, **before** constructing anything.
- **Pi's client learns to honour that 404.** Of the five clients, Pi is the only MCP client this repo owns (`apps/plugin/.pi-plugin/index.ts` — Pi ships no built-in MCP client), and it throws on any non-2xx (`:143-146`) and calls `initialize` once at activation (`:314`). It will discard the session id, re-initialize and retry **once**, on `404` only. Retrying a write after a 404 is safe and the reason is specific: the refusal happens at the transport boundary before any handler runs, so the call cannot have been half-applied.
- **`SessionRouter.discoveryInFlight` is deliberately untouched**, and the delta says so, so that a later reader does not "fix" a map that is already bounded.
- **No LRU, no capacity bound, no eviction-on-close-only.** All three were the issue's alternatives; the first changes which session a later call resolves to under memory pressure (scope resolution is load-bearing), the last fixes only the clients that already clean up after themselves.

## Capabilities

### New Capabilities

- _(none)_

### Modified Capabilities

- `sessions`: **ADDED** — "Per-transport in-process state MUST be evicted once its transport is stale". Chosen over `projects` after reading both: `sessions` already owns transport-and-session lifetime (its "Server restart MUST mark in-flight sessions as abandoned" requirement opens by describing the in-process routing state, `sessions/spec.md:268`, and "Session rows MUST record last activity, and stale-active retirement MUST be periodic", `:852-874`, owns the periodic pass and the staleness window this rule reuses). `projects` owns only what a transport's state _means_ for scope resolution (roots discovery, `list_changed`), not how long it lives. **No delta for `projects`** — checked, not assumed: its per-transport discovery state was given an owner and a lifetime by `fix-the-roots-discovery-lifecycle` (archived 2026-08-09) and needs no eviction hook.
- `mcp-api`: **ADDED** — "A request naming an unknown MCP session MUST be refused with `404` and MUST NOT construct a server". This is the recovery half of the eviction rule; without it an evicted client cannot tell "start a new session" from "this server is broken", and any request naming a stale id costs a full server construction.
- `pi-plugin`: **ADDED** — "The extension MUST recover from a terminated MCP session by re-initializing once". Extends the existing "MCP transport is Streamable HTTP …" requirement's wire surface rule rather than contradicting it: the recovery path uses `initialize` and the initialized notification, both already in that list.

## Impact

**Server.**

- `apps/server/src/mcp/transport.ts` — per-session `lastSeenAt` (stamped on `onsessioninitialized`, bumped on every `getOrCreate` hit), `has(id)`, an iteration read, and an `evict(id)` that closes the pair; `close()` and the `onclose` handler keep their current behaviour.
- `apps/server/src/server/session-router.ts` — a real per-transport removal, plus a fix to `clearSession`'s docstring, which currently describes a behaviour the body does not have.
- `apps/server/src/server/transport-state-reaper.ts` (new) — the single implementation of the predicate and the pass, for both registries.
- `apps/server/src/server/bootstrap.ts:274-286` — the existing reaper tick also runs the pass. No new timer, no cron.
- `apps/server/src/db/repositories/agent-sessions-repository.ts` — an existence read beside `findActiveForTransport`, reusing `EFFECTIVE_LAST_ACTIVITY` and the existing `sessions_token_status_idx`. It is deliberately **not** `findActiveForTransport` itself: that method returns nothing under two-or-more matches because it must not _choose_ a session, and eviction chooses nothing, so inheriting its ambiguity rule would evict a transport with two live sessions.
- `apps/server/src/services/agent-sessions.ts` — the service wrapper that applies `TRANSPORT_STALENESS_MS`, so the constant stays in the file that owns it and no SQL leaves `db/`.
- `apps/server/src/server/http.ts:376-380` — the unknown-session `404`, evaluated before `getOrCreate`.

**Plugin.** `apps/plugin/.pi-plugin/index.ts` only — one client's own MCP client, no shared module touched, so the "one implementation per shared resource" rule is not engaged. It bumps the single unified `plugin` version like any other plugin-tree change.

**Load-bearing invariants.** None relaxed. No SQL outside `db/`; scope still resolved only at the service layer; no memory row read or written, so append-only, `topic_key` convergence, judgment freshness and derived review state are all untouched. The one invariant this change gets close to is scope resolution, and it is protected explicitly: router state may never be evicted while its transport can still serve a request.

**Existing installations.** No migration, no schema change, no new column, no index. Every registry this change bounds is in-process and already starts cold on every boot, so an installation with hundreds of memories behaves identically to an empty one on the first boot after upgrade; there is nothing to backfill and no derived data (`memory_fts`, `memory_vec`, the three entity tables) to invalidate. Rollback is a code revert with no data consequence.

**Behaviour change on the wire, deliberately.** A client that goes silent for longer than the window on both clocks will be asked to re-initialize instead of resuming. Four of the five clients reach the server through their host's own SDK-based MCP client, which surfaces a `404` as a transport error (`client/streamableHttp.js:364`) and leaves recovery to the host — behaviour this repo cannot verify from inside itself. That is the change's main risk, it is named in `design.md`, and tasks 1 and 7 require it measured at a real edge before this lands.
