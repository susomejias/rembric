## Context

Roots discovery is one server→client request per transport, issued lazily from the scope resolver:

```
tool call (POST /mcp)
  → resolveEffectiveScope            _shared.ts:73
  → ensureRootsDiscoveryRun          roots-discovery.ts:95   (single-flight via SessionRouter)
  → maybeDiscoverViaRoots            roots-discovery.ts:111
      markDiscoveryRun(...)          :117   ← fires BEFORE the try
      server.listRoots(undefined, …) :123   ← no relatedRequestId
```

With `relatedRequestId` absent, the SDK's `send()` treats the message as standalone-stream traffic (`webStandardStreamableHttp.js:664-749`): it looks up `_streamMapping.get(this._standaloneSseStreamId)` and, on `undefined`, returns. No throw, no `onerror`, no log — the file has neither a logger nor an emitter. The client's `listRoots` promise then simply never settles until `ROOTS_LIST_TIMEOUT_MS` (2500) elapses, and `maybeDiscoverViaRoots` swallows that at `:129-131`.

Three properties of the current shape combine into the defect:

1. **The channel is not guaranteed to exist.** The client opens the standalone GET fire-and-forget after `notifications/initialized` (`client/streamableHttp.js:370-378`), and the SDK's own comment calls that stream optional (`:80-82`).
2. **The failure is unobservable.** Nothing reports the discard, at any layer.
3. **The failure is permanent.** `markDiscoveryRun` precedes the `try`, and `ensureRootsDiscoveryRun` short-circuits on the sentinel (`:105`), so one dropped message means the connection resolves to the default project for its whole life. `refreshRootsAfterChange` can only write suggestions (`:151`, `:157`, `:160`), never activate.

There is a second, non-racy population: any client that advertises `capabilities.roots` and never opens the GET at all. For them there is no window to lose — every session is misscoped, deterministically.

**Measured** (details and the full arm table in `proposal.md`): in the suite the trigger is prior HTTP traffic in the same Node process, not the preceding test — a read-only warm-up substituted for the real predecessor made it _worse_ (2, 2, 4, 2 failed attempts), while removing all prior traffic made it vanish (0). The decision happens at HTTP arrival, before `authenticate()`, on roughly a 1 ms margin: which fetch wins the warm keep-alive socket. Stamping the in-flight tool call's id was executed and made discovery succeed **with `standaloneUp = false`** — the same race still lost — and took the target test from 2529 ms to under 300 ms.

**A prior decision this change corrects.** Commit `d62d254` (_fix(mcp): stabilize roots-discovery flake on slow CI_) states verbatim "Two layers, **both honest to the actual cause**", and diagnosed the flake as the `listRoots` round trip having "occasionally exceeded the 1s discovery budget" because async scrypt bearer auth slowed the client's **response**. Measured, it never exceeded any budget: the request was discarded and never reached the client at all. Widening 1 s → 2.5 s could not help by construction and made the user-facing stall 1.5 s longer; the `{ retry: 3 }` added by the same commit is what has kept the defect invisible since. The transferable lesson, worth stating plainly because it generalises past this file: **a timeout that always fires exactly at the bound is evidence the message never arrived, not that it was slow.** A distribution of latencies has a spread; a delivery failure does not.

**A convention this change also repairs.** The lazy-discovery design's rationale exists only as a code comment (`roots-discovery.ts:9-17`) with nothing in `openspec/changes/archive/` — contrary to this repo's rule that rationale belongs in specs. Read it and the team clearly knew about this channel: it says the client "doesn't open its server→client SSE channel until AFTER `notifications/initialized` has been processed, so a `roots/list` issued from `oninitialized` **always** times out and poisons the discovery slot". The diagnosis was right; the word "always" was the error. Moving discovery later shrank the window to ~1 ms instead of closing it, and left the poisoning intact for whoever lands inside the residue.

## Goals / Non-Goals

**Goals:**

- `roots/list` is sent on a stream that is registered at send time, so delivery does not depend on timing or on the client having opened an optional stream.
- A discovery attempt that produces no answer does not consume the once-only slot: the next tool call retries.
- The spec states the delivery obligation, so a discarded request is no longer simultaneously permitted by `projects` and forbidden by `mcp-api`.
- The regression test asserts the **routing** (discovery succeeds with the standalone GET absent), not merely the resolved scope, and runs with `retry: 0` in both a cold and a warm process regime.

**Non-Goals:**

- Making the standalone GET stream reliable, or requiring clients to open it. The point is to stop depending on it.
- Configuring an `eventStore`. Ruled out on evidence, not deferred — see D1.
- Reassigning already-misfiled memories or sessions. There is no such verb and this change does not add one; `project_id` is contractually immutable (`db/schema/agent-sessions.ts:17`).
- Fixing `refreshRootsAfterChange` (dead code) or the global `resetDiscoveryState` reset (`mcp/server.ts:531-532`). Recorded in the proposal's out-of-scope list; separate change.
- Changing `ROOTS_LIST_TIMEOUT_MS`'s value. Once delivery is guaranteed the budget stops being load-bearing; re-tuning it on a guessed number would repeat `d62d254`'s mistake.
- Any change under `apps/plugin/`.

## Decisions

### D1 — Stamp the in-flight tool call's request id; do not configure an `eventStore`

Pass `relatedRequestId` in the `RequestOptions` already accepted by `listRoots(params?, options?)` (`server/index.d.ts:168`). This is a **parameter, not an API change**: `Protocol.request` destructures `relatedRequestId` (`shared/protocol.js:613`) and forwards it to `transport.send` (`:743`), and the transport registers every POSTed request id in `_requestToStreamMapping` before invoking any handler (`webStandardStreamableHttp.js:485` for the JSON path, `:531` for the SSE path). The stream therefore exists whenever a tool handler is running — by construction, not by luck.

_Alternative rejected — configure an `eventStore` so the discarded message is replayed._ Ruled out on the code, not on preference: replay requires a `Last-Event-ID` header, and the client's post-`initialized` GET is issued deliberately without one (`client/streamableHttp.js:375`, "Start without a lastEventId since this is a fresh connection"). The store would accumulate events nobody ever asks for. It also adds state to a transport that currently has none.

_Alternative rejected — await the standalone stream before sending._ The server has no signal for "the client's GET has arrived" other than the GET itself, and the SDK documents the stream as optional (`client/streamableHttp.js:80-82`). Waiting on something a compliant client may never send converts a 1 ms race into a guaranteed timeout for that client class.

_Alternative rejected — move discovery back to `oninitialized` and add retries._ That is the direction commit `1379c93` took and `roots-discovery.ts:9-17` records the failure. Retrying a message that is dropped without a signal cannot converge.

### D2 — Capture `extra.requestId` in the `registerTool` wrapper into an AsyncLocalStorage

Two shapes reach the id to `roots-discovery`. This change picks the wrapper capture:

1. **Wrapper + ALS (chosen).** `createMcpServer`'s local `registerTool` (`mcp/server.ts:180-195`) is the single funnel through which every tool is registered. Wrap the callback there, read `extra.requestId`, and run the handler inside an AsyncLocalStorage store held in a small module beside `server/request-context.ts`. `_shared.ts` reads it when building the `ensureRootsDiscoveryRun` context. **Two files touched**, and a tool registered next year inherits the behaviour without knowing it exists.
2. **Thread a parameter.** `resolveEffectiveScope` and `requireScope` are called from ~20 sites across 6 files (`memory-tools.ts` ×8, `session-tools.ts` ×4, `relations-tools.ts` ×3, `observability-tools.ts` ×3, `prompt-tools.ts` ×2, `project-tools.ts` ×1). Every one would take a new argument, every handler signature would grow, and a new tool that forgets it silently reverts to today's broken behaviour — the exact "absent from the list of call sites" failure mode that `mcp-api/spec.md:1817` already records as how a scope defect reached three separate write paths.

The wrapper wins on both counts that matter here: blast radius and non-bypassability. Its cost is one more AsyncLocalStorage in a process that already runs one, and an indirection a reader must follow from `_shared.ts` back to the wrapper — mitigated by keeping the module next to `request-context.ts` so the pattern is recognisable, and by stating the invariant in the `projects` spec so the "why" is not a code comment.

No threading is needed to _get_ `extra`: the SDK calls `cb(args, extra)` (`server/mcp.js:438`) and Rembric binds `handleContext.bind(null, deps)` (`memory-tools.ts:605`), so `extra` already arrives as the third positional argument and is discarded — `handleContext` declares only `(deps, args)` (`memory-tools.ts:1273-1283`).

_Rejected — carry it on `RequestContext`._ `runWithContext` wraps the entire POST (`server/http.ts:382-385`), and a POST may be a JSON-RPC batch (`webStandardStreamableHttp.js:483-486` iterates `messages`), so at that layer there is no single request id to record. Putting one there would be correct only for the single-message case and quietly wrong for a batch.

_Rejected — read the id off the transport's internals._ `_requestToStreamMapping` is private and undocumented; depending on it makes an SDK patch release a breaking change for Rembric.

### D3 — `markDiscoveryRun` fires only on a definitive answer

Today (`roots-discovery.ts:115-131`) the sentinel is set before the `try`, so the first attempt consumes the slot whatever happens. After the move it is set when discovery reached a conclusion: a `roots/list` that answered (with roots, or with an empty list), a client that advertises no `roots` capability, or a JSON-RPC error from the client. An attempt that produced **no answer** — timeout, undelivered, transport failure — leaves the slot unconsumed, so the next tool call retries.

This is deliberately kept as a separate half. It is orthogonal to D1 and strictly better than today even if D1 were reverted: the worst case becomes "one slow tool call per attempt until an answer arrives", instead of "wrong project forever". It is also the property that survives an SDK change: if a future SDK version routes stamped requests differently, D3 keeps the failure recoverable.

Two sub-decisions inside it, both stated so they are not re-litigated:

- **A client-side JSON-RPC error consumes the slot.** It is an answer: the client is telling us it will not enumerate roots. Retrying it every tool call would add a round trip per call for no possible gain.
- **No retry counter, no backoff.** The natural throttle is that discovery only runs on unscoped connections, only until it succeeds, and single-flight already collapses concurrent callers (`SessionRouter.discoveryInFlight`, `roots-discovery.ts:100-103`). Adding a counter would need its own eviction story for a Set that is already process-global (see Open questions).

### D4 — The spec states delivery, and that is what reconciles the two requirements

`mcp-api/spec.md:1825-1827` and `projects/spec.md:106-109` are both satisfied by a discarded request: one requires the discovered project, the other permits falling through to the default when `roots/list` "does not return within 2 seconds". Neither contemplates a request that was never delivered — that is the requirement-shaped hole, and closing it is this change's central spec act.

The obligation goes in `projects`, which owns auto-detection, phrased as a property of the send rather than of any SDK symbol: the request SHALL be issued on a stream that is registered at the moment of the send, and SHALL NOT depend on the client having opened the optional standalone server→client stream. Naming `relatedRequestId` in the spec would pin an SDK implementation detail; naming the property leaves the mechanism free and still fails a future implementation that regresses it.

`projects/spec.md:85`'s word **"once"** is amended in the same delta. As written, the once-only guarantee attaches to the _attempt_, which is precisely what makes a lost race permanent. It is rescoped to a call that was delivered and produced an answer.

That same sentence's **"after `initialized`"** goes with it, and the removal is worth naming rather than slipping through: discovery has not run from `initialized` since it moved to the lazy tool-call path, so the phrase was already false — and it is the phrase that makes the standalone GET stream look like the natural channel, since a request issued at handshake time has nothing else to ride. Line 85 is therefore the single published body line this change rewrites; `pnpm run check:delta-freshness` flags exactly one difference in `projects` and zero in `mcp-api`, which is the expected signature of this delta.

`mcp-api` gets the routing-level scenario, because that is the layer whose requirement is currently failing and because a scenario asserting only the resolved scope is unfalsifiable — see D5.

### D5 — The regression test asserts routing, and must run warm

A test that only checks the resolved scope passes on **both sides** of this change whenever the race happens to be won. Two consequences for the test design, both learned from the measurement rather than reasoned about:

- **Assert the executed shape**: discovery succeeds while the standalone GET stream is **absent**. That assertion is false before D1 and true after it, regardless of who wins any race.
- **Run in the warm regime.** In a cold process the GET wins and the defect is invisible — arm C measured 0 failed attempts. So the test must run with ≥3 prior clients' worth of traffic in the same process, and the reproduction step must be performed **in the full file, never with `-t`**. An isolated run is a broken probe: it passes either way.
- **Keep a cold arm too**, as the control. With only a warm arm, a harness that never reaches the discovery path is indistinguishable from a fix.

`{ retry: 3 }` comes off both tests (`mcp-integration.test.ts:3005`, `:3049`). While it stands nothing above is a gate — a retried test asserts only "at least one of four attempts passed". The second one has 0 failed attempts today, so removing it costs nothing and stops it from being cited as precedent.

### D6 — Fix the drifted comments in the same change

Three pieces of prose that describe this mechanism are now false, and each one would mislead the next reader of exactly this code path:

- `projects/spec.md:108` says "2 seconds"; `roots-discovery.ts:43` is `2500`.
- `apps/server/vitest.config.ts:22-26` describes a "1s budget" and discovery falling "back to global" — the global scope was retired (`openspec/changes/archive/2026-08-05-retire-the-global-scope`), and it is not 1 s.
- `roots-discovery.ts:81-93` and `_shared.ts:68-71` document an eager `server.oninitialized` path that no longer exists; `roots-discovery.ts:35-43` justifies the 2.5 s budget with the `d62d254` reasoning this change refutes.

Fixed here rather than in a docs pass, because the false prose is the reason the wrong diagnosis persisted. Per house policy the corrected code comments stay minimal — one line each where absence would cost a reader time — and the rationale lives in the spec.

## Risks / Trade-offs

- **[Risk] `extra.requestId` is absent or not the id the transport registered.** → The reproduction already ran with a stamped id and observed delivery with `standaloneUp = false`, so the value is right for the tool-call path. The fallback is explicit: when no id is captured, send unstamped exactly as today, so the worst case is current behaviour rather than a throw. Task 3.4 asserts the fallback path separately.
- **[Risk] A stamped request is delivered but the client answers on a different channel.** → `Protocol` correlates the response by JSON-RPC id, not by channel, so a client answering over the standalone stream still resolves the promise. Confirmed by the executed arm, where discovery succeeded while the standalone stream was down.
- **[Risk] D3 turns one permanent misscope into repeated 2.5 s stalls for a client that advertises `roots` and never answers.** → Accepted, and bounded: after D1 the request is delivered, so a non-answering client is a client choosing not to answer, and it pays one bounded wait per tool call until it does. That is strictly better than being silently filed into the wrong project forever, and it is at last _visible_. If it proves painful, a per-transport attempt cap is a follow-up with its own evidence — not a guess bundled here.
- **[Trade-off] AsyncLocalStorage adds an indirection between `mcp/server.ts` and `_shared.ts`.** → Accepted because the alternative is 20 call sites and a silent-revert failure mode for future tools (D2). Mitigated by module placement next to `request-context.ts` and by the spec stating the invariant.
- **[Risk] The new behaviour moves writes for operators who have been unknowingly saving into the default project.** → Deliberate: it is what `mcp-api/spec.md:1825-1827` already promises. Called out in the proposal's Impact so it appears in release notes rather than surprising someone. No backfill is possible (no reassignment verb, immutable `project_id`), and this change does not pretend otherwise.
- **[Risk] The mutation check mutates the wrong site.** → `roots-discovery.ts` has two `listRoots` call sites (`:123`, `:148`) and `markDiscoveryRun` appears at both its definition (`:55`) and its call (`:117`). `scripts/mutate.mjs` does a literal replace and **skips** a non-unique match, counting the skip as uncovered, so the failure mode is a `SKIP` misread as a pass. Every mutation string in `tasks.md` is verified unique with `grep -c -F` before the run (task 5.1).
- **[Risk] Adding tests to `roots-discovery.ts` gives false comfort.** → Stated rather than assumed: today the only coverage of that file is `deriveSlugFromUri` (9 cases in `roots-discovery.test.ts`). Everything else in it is unguarded, so a new test there is the first thing holding it. Tasks name that explicitly so nobody reads a green file as a covered one.

## Migration Plan

No migration. No schema change, no new column, no new MCP tool, no dashboard token change, nothing under `apps/plugin/`, so no client version moves and no `extra-files` carrier is touched.

Derived data needs no invalidation: `memory_fts`, `memory_vec` and the three entity tables are all regenerable from `memory`, and no `memory` row is written differently by this change.

First boot after upgrade: identical, except that a `roots`-advertising client on `/mcp` whose basename names an existing project now resolves to that project instead of the default one. That is the published contract taking effect, and it is the only observable difference.

Rollback is a code revert. Rows written under the new code are indistinguishable from any other row (they simply carry the correct `project_id`), so the old code reads them fine. Nothing written under the new code becomes unreadable, and nothing needs undoing.

## Open Questions

1. **Do Claude Code, Codex CLI and opencode advertise `capabilities.roots`?** Recorded, deliberately unanswered. All three funnel through `apps/plugin/bin/rembric-bridge.mjs:56` (`let scopedPath = '/mcp'`) when `.rembric` is absent, and `mcp-remote` is a raw pipe that forwards the host's capabilities verbatim — so the bridge cannot tell us, and no harness can settle it. It needs one manual session per host logging `getClientCapabilities()` at the server. What each answer changes: **if they advertise `roots`**, the population reachable by the race is every unpinned session on those hosts, the second confirmed consequence in the proposal applies to real deployments, and this change is a user-facing fix rather than a contract repair. **If they do not**, the race is unreachable in practice for the shipped clients, the fix stands on the published-requirement failure and the generic-MCP client class alone, and the priority of the deferred `resetDiscoveryState`/`refreshRootsAfterChange` cleanup drops. Either way the fix is the same; only the severity claim moves, which is why the change does not wait on the answer. Measured negative already in hand: Pi cannot hit it, `apps/plugin/.pi-plugin/index.ts:146` sends `capabilities: {}`.
2. **Should `discoveryRunForTransport` be evicted when a transport closes?** Not decided here. It is a process-global `Set<string>` keyed `tokenId::mcpSessionId` (`roots-discovery.ts:49`) with no removal path — `transport.onclose` (`mcp/transport.ts:71-75`) deletes the session from the transport map but leaves the sentinel. Today that leaks one short string per transport, which is why it has never mattered. D3 makes the entry meaningful (it now records "we got an answer") rather than merely "we tried", so the right lifetime becomes a real question rather than a nit. Default if nobody objects: leave it, and fold eviction into the same follow-up that fixes the global `resetDiscoveryState` reset, since both are about that Set's scope.
3. **Should `ROOTS_LIST_TIMEOUT_MS` come back down now that delivery is guaranteed?** Deliberately not touched. The 2500 ms was chosen by `d62d254` on a diagnosis this change refutes, so the number has no evidence behind it in either direction; after D1 a compliant client answers in single-digit milliseconds and the budget only binds a non-answering one. Re-tuning it needs its own measurement across the real clients, which is blocked on question 1. Default: leave 2500 and revisit with that data.
