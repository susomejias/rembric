# Route `roots/list` over the tool call's own stream instead of the standalone GET

## Why

`roots/list` is a server→client **request** issued with no `relatedRequestId` (`apps/server/src/mcp/roots-discovery.ts:123`, `listRoots(undefined, { timeout: ROOTS_LIST_TIMEOUT_MS })`). The MCP SDK (1.29.0) therefore routes it **only** to the standalone GET SSE stream, and when that stream is not registered the message is dropped on the floor. Verbatim, `@modelcontextprotocol/sdk/dist/esm/server/webStandardStreamableHttp.js:685-689` (the node `StreamableHTTPServerTransport` is a 160-line wrapper delegating to it, `server/streamableHttp.js:52`):

```js
const standaloneSse = this._streamMapping.get(this._standaloneSseStreamId);
if (standaloneSse === undefined) {
  // Stream is disconnected - event is stored for replay, nothing more to do
  return;
}
```

Rembric configures no `eventStore` (`apps/server/src/mcp/transport.ts:56-66`), so the store-for-replay branch never runs. **An `eventStore` would not fix it either**: replay is keyed on a `Last-Event-ID` header, and the client's post-`initialized` GET is deliberately issued without one (`client/streamableHttp.js:375`, _"Start without a lastEventId since this is a fresh connection"_). That option is ruled out, not deferred.

The client opens that GET fire-and-forget — `this._startOrAuthSse({ resumptionToken: undefined }).catch(…)` (`client/streamableHttp.js:370-378`), not awaited by `connect()` — so a tool call arriving before it registers wins the race and the discovery request is discarded. The discard is **genuinely silent**: no `onerror` call falls inside the transport's `send()` (lines 664-749), the file has no logger and no emitter, and Rembric swallows the eventual timeout at `roots-discovery.ts:129-131` (`catch { // Silent on error / timeout }`). Nothing anywhere reports it.

**The lost race is permanent, not a stall.** `markDiscoveryRun` fires at `roots-discovery.ts:117`, **before** the `try` at `:122`, and `ensureRootsDiscoveryRun` short-circuits on that sentinel at `:105`. A connection that loses by ~1 ms is therefore misscoped **for its entire lifetime**. Probed directly: four consecutive `memory.context` calls on one connection all resolved to the default project, and `project.current` returned `suggestedSlugs: []` — so the agent cannot even self-diagnose. `refreshRootsAfterChange` (`:140-164`) can only write suggestions, never activate, so `notifications/roots/list_changed` is not a recovery path. And memories are append-only with no reassignment verb: no `.set({ projectId })` exists in any repository, and `project_id` is contractually immutable on sessions (`db/schema/agent-sessions.ts:17`, "immutable: id, token_id, project_id, agent, started_at"). Every row written under the wrong scope stays there.

Two consequences are confirmed, and the proposal rests on these rather than on a hypothetical:

1. **A published requirement fails 100% of the time.** `openspec/specs/mcp-api/spec.md:1825-1827` requires that an unscoped `/mcp` connection whose project is resolvable via roots discovery return "the discovered PROJECT's context, not the default project's". Its integration test is held green only by `{ retry: 3 }` (`apps/server/src/test/mcp-integration.test.ts:3005`).
2. **A deterministic class of clients is misscoped on every session, permanently.** Any client that advertises `capabilities.roots` but never opens the standalone GET loses every time. That stream is optional by the SDK's own words — `client/streamableHttp.js:80-82`: _"Try to open an initial SSE stream with GET to listen for server messages / This is optional according to the spec - server may not support it"_. Such a client has no window at all, not a 1 ms one.

**Severity, stated honestly.** The timing race needs a client that advertises `roots` **and** issues a tool call within ~1 ms of `notifications/initialized`. Real agents call tools seconds later, so **"production incident" is an assumption, not a fact** — the race is secondary here and is labelled unmeasured against real hosts. One measured negative: Pi cannot hit it at all, because `apps/plugin/.pi-plugin/index.ts:146` sends `capabilities: {}`.

**Why 100% in the test suite, and this corrects an earlier explanation.** The trigger is not the preceding test; it is **prior HTTP traffic in the same Node process**. Measured with a discriminating experiment run in both directions:

| Arm   | Prior traffic                                        | Failed attempts |
| ----- | ---------------------------------------------------- | --------------- |
| C     | none (target test alone)                             | **0**           |
| B     | the real predecessor test                            | 1               |
| I     | predecessor + 250 ms idle                            | 1, 1, 1, 1      |
| **K** | **read-only warm-up instead of the predecessor**     | **2, 2, 4, 2**  |
| E     | predecessor intact, only undici's dispatcher swapped | 1, 1, 0, 1, 0   |

Removing the predecessor's effects while keeping generic traffic makes it _worse_ (K); removing all prior traffic makes it vanish (C). The loss is decided at HTTP arrival, before `authenticate()`, by roughly **1 ms** — which fetch wins the warm keep-alive socket. The direct consequence for verification: **an isolated `-t` run is a broken probe**, because the cold regime is the only one where the GET wins.

## What Changes

- **(a) Stamp the in-flight tool call's request id on `roots/list`.** `listRoots(params?, options?: RequestOptions)` (`server/index.d.ts:168`) forwards options to `Protocol.request`, which destructures `relatedRequestId` (`shared/protocol.js:613`) and hands it to `transport.send` (`:743`). The POST's request ids are registered in `_requestToStreamMapping` before any handler runs (`webStandardStreamableHttp.js:485`, `:531`), so a stamped request rides a stream that is open **by construction** rather than by luck. **Executed, not argued**: stamping the id made discovery succeed with `standaloneUp = false` — the same race still lost — and dropped the target test from 2529 ms to under 300 ms.
- **Capture the id in the `registerTool` wrapper into an AsyncLocalStorage, rather than threading a parameter.** The SDK already calls `cb(args, extra)` (`server/mcp.js:438`) and Rembric binds `handleContext.bind(null, deps)` (`memory-tools.ts:605`), so `extra` arrives as the third positional argument today and is discarded — `handleContext` declares only `(deps, args)` (`memory-tools.ts:1273-1283`). Chosen over threading `requestId` through the ~20 `resolveEffectiveScope`/`requireScope` call sites across 6 files (`memory-tools.ts`, `session-tools.ts`, `relations-tools.ts`, `prompt-tools.ts`, `observability-tools.ts`, `project-tools.ts`): the wrapper touches 2 files and, being the single registration funnel, cannot be bypassed by a tool added later. Rationale and the rejected alternative in `design.md` D2. `RequestContext` cannot carry it: `runWithContext` wraps the whole POST (`server/http.ts:382-385`) and a POST may be a JSON-RPC batch, so there is no single id at that layer.
- **(c) Move `markDiscoveryRun` so it fires only on a definitive answer.** Today it fires before the `try`, so one dropped message poisons the connection forever. After the move, a residual loss self-heals on the next tool call. Cheap, orthogonal to (a), strictly better than today even alone, and it composes: (a) closes the window, (c) makes surviving it survivable.
- **Spec: close the requirement-shaped hole between two contradicting requirements.** `mcp-api/spec.md:1825-1827` says the discovered project SHALL be returned; `projects/spec.md:106-109` says a `roots/list` that "does not return within 2 seconds" SHALL "silently fall through to the default project". A **discarded** request satisfies both antecedents, and **neither requirement contemplates a request that was never delivered**. This change states the delivery obligation explicitly — the request SHALL ride a stream that is open at send time — which is what makes the two consistent instead of merely coexisting.
- **Address `projects/spec.md:85`'s word "once".** That single word is what turns a lost race into a permanent misscope. It is amended to say that the once-only guarantee attaches to a delivered call that produced an answer, not to an attempt. The same sentence's "after `initialized`" is dropped in the same edit: it has been stale since discovery moved to the lazy tool-call path (`roots-discovery.ts:9-17`), and it is the phrase that made the standalone GET stream look like the natural channel. This is the one published body line this change rewrites — `pnpm run check:delta-freshness` reports it, and it is deliberate.
- **Fold in three documentation drifts touched by this change.** `projects/spec.md:108` says "2 seconds" while `roots-discovery.ts:43` is `2500`. `apps/server/vitest.config.ts:22-26` still describes a "1s budget" and a fallback "to global" — the global scope was retired by `2026-08-05-retire-the-global-scope`. `roots-discovery.ts:81-93` and `_shared.ts:68-71` still document an eager `server.oninitialized` path that no longer exists.
- **Remove `{ retry: 3 }` from both discovery integration tests** (`mcp-integration.test.ts:3005`, `:3049`). While it stands, none of the new assertions is a gate. The second one has 0 failed attempts today, so it is already doing nothing.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `projects`: **MODIFIED** — "Project auto-detection via MCP `roots` MUST be read-only" gains the delivery obligation (the request rides a stream open at send time), scopes the once-only guarantee to a delivered-and-answered call, corrects "2 seconds" to the shipped 2500 ms budget, and adds the self-healing rule for an undelivered attempt.
- `mcp-api`: **MODIFIED** — "Scope-sensitive tools MUST share the single async scope resolver" gains the routing-level scenario (discovery SHALL succeed with the standalone GET stream absent) and the no-retry obligation on the test that guards it, so the requirement stops being satisfiable by winning a race.

## Impact

**Source (apply phase, not this change):**

- `apps/server/src/mcp/roots-discovery.ts` — pass `relatedRequestId` to both `listRoots` call sites (`:123`, `:148`); move `markDiscoveryRun` out of the pre-`try` position (`:117`); refresh the stale `oninitialized` docstrings (`:9-17`, `:81-93`) and the `ROOTS_LIST_TIMEOUT_MS` comment (`:35-43`).
- `apps/server/src/mcp/server.ts` — capture `extra.requestId` in the `registerTool` wrapper (`:180-195`).
- One new small module beside `apps/server/src/server/request-context.ts` holding the tool-call AsyncLocalStorage.
- `apps/server/src/mcp/_shared.ts` — read the captured id when calling `ensureRootsDiscoveryRun` (`:80-83`); correct the resolver docstring (`:68-71`).
- `apps/server/src/mcp/roots-discovery.test.ts` — today it covers only `deriveSlugFromUri` (9 cases). Everything else in the file is **unguarded by default**, so the new tests are the first coverage of the discovery path itself.
- `apps/server/src/test/mcp-integration.test.ts` — drop both `{ retry: 3 }`; add cold and warm arms plus the routing assertion.
- `apps/server/vitest.config.ts` — correct the "1s budget" / "falls back to global" comment.

**Invariants touched:** the path-scoping contract (`resolveEffectiveScope`, `apps/server/src/mcp/_shared.ts`) — this change makes it hold in a case where it currently silently does not. No change to append-only memory, `topic_key` convergence, fresh-context judgment, derived-never-stored review state, or SQL confinement to `db/`.

**Existing installations:** no migration, no schema change, no new column, no new MCP tool, no dashboard token change. Nothing under `apps/plugin/` changes, so no client version moves. Derived data (`memory_fts`, `memory_vec`, the three entity tables) is untouched and needs no invalidation. First boot after upgrade behaves as before except that a `roots`-advertising client on `/mcp` now resolves to its discovered project instead of the default one — **which is a visible behaviour change for anyone who has been unknowingly writing to the default project**, and is deliberate: it is what `mcp-api/spec.md:1825-1827` already promises. Rows already misfiled stay misfiled; there is no reassignment verb and this change does not add one. Rollback is a pure code revert with no data consequence.

**Deliberately out of scope** (recorded so it is not lost): `refreshRootsAfterChange` has no production caller and is dead code; `resetDiscoveryState`, whose docstring says "Test-only helper" (`roots-discovery.ts:63`), is nevertheless called from the `RootsListChangedNotificationSchema` handler (`mcp/server.ts:531-532`) and clears the sentinel Set **globally**, so one client's `list_changed` re-arms discovery for every other transport in the process. Separate concern, its own evidence, its own change.
