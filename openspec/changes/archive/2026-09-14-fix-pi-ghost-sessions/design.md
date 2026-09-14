# Design: fix-pi-ghost-sessions (issue #377)

Implements the three delta specs under `specs/` (sessions, mcp-api, pi-plugin). Scope is
fixed by `proposal.md` as amended: **A + B-narrow + D3 + D4′**. Owner decisions in
`preproposal.md` (including the AMENDMENT) are authoritative and not re-litigated here:
no-guess mint under ≥2 live rows is kept; B-narrow only (auto-attach untouched); the
post-sweep mint is by design; no repair of existing ghosts; identity declaration is
Pi-only in this change.

Inputs read: `proposal.md`, `specs/{sessions,mcp-api,pi-plugin}/spec.md`,
`explore.md`, `preproposal.md`, `apps/server/src/mcp/ghost-session-repro.test.ts`,
plus the code every decision below touches. All line anchors were measured on this
tree; re-verify the two `mcp-integration.test.ts` pins at apply time (see Decision 3).

## 0. Sequencing pre-apply check (blocking)

`openspec/changes/expose-session-start-agent/` is implemented (35/35) but **unarchived**
and owns the same `memory.session_start` description (`server.ts:313`) and the same
`mcp-integration.test.ts` pins. Before any code edit: the directory must appear under
`openspec/changes/archive/` and `openspec/specs/mcp-api/spec.md` must already carry the
`agent` field. If still active, stop and rebase. After each archive of the four
mcp-api-delta changes, re-run `pnpm run check:delta-freshness` and
`pnpm run check:delta-sections`. `pi-plugin` is touched by no other active change.

## Decision 1 — `handleSessionStart` resolution order (exact code shape)

File: `apps/server/src/mcp/session-tools.ts`, function `handleSessionStart` (:126).
Today's resolution (:178–206): scope resolution → `assertAuthorized` →
`findActiveForTransport` (:184–187) → touch (:195) or mint (:196–206) →
`deps.sweep?.(projectId)` (:210) → binding set (:212–221) → response (:222–231).

**Do this** — replace the block at :178–206 with, in this order:

```ts
const key = routerKey();
const boundId = key
  ? (deps.router.get(key.tokenId, key.mcpSessionId)?.rembricSessionId ?? null)
  : null;
const bound = boundId ? deps.agentSessions.getById(boundId) : undefined;

let session: AgentSession | null = null;
if (
  bound &&
  bound.status === 'active' &&
  bound.deletedAt === null &&
  bound.tokenId === ctx.token.id &&
  bound.projectId === projectId
) {
  session = bound;
} else {
  session =
    deps.agentSessions.findActiveForTransport({ tokenId: ctx.token.id, projectId }) ??
    deps.agentSessions.findSoleActiveForReuse({ tokenId: ctx.token.id, projectId });
}
let reused = session !== null;
if (session) {
  deps.agentSessions.touchActivity(session.id);
} else {
  // mint exactly as today (:196–206, `agent: args.agent ?? 'unknown'` at :201)
}
```

Everything after the block is untouched: `deps.sweep?.(projectId)` (:210), the
`setActiveSession`/`setActiveProject` re-pin (:212–221, including the
`source !== 'default'` guard), and the response shape (:222–231) — which already reads
`agent`/`title` off the resolved row, satisfying the mcp-api requirement that both
adoption paths report `reused: true` with the adopted row's id and stored `agent`.

Branch semantics, one per line:

1. **Binding hit, guards pass** → adopt the bound row, `touchActivity` it (the mcp-api
   delta says "adopt that row and refresh its activity"; `touchActivity` is
   best-effort, `agent-sessions.ts:294–300`), skip both lookups.
2. **Binding hit, any guard fails** (terminal, soft-deleted, other token, other
   project) → fall through to (2)/(3)/(4) and **do NOT call `router.clearSession`**.
   `clearSession` stays `session_end`-only (`session-router.ts:107–111`;
   `session-tools.ts:226–229` is its only MCP caller). There is no clear to _remove_ —
   the failure mode to design against is an implementer "helpfully" clearing here,
   which would drop every later `memory.save` on the transport to `session_id = NULL`.
   After the call, the end-of-handler re-pin (:214) overwrites the binding with the
   row this call resolved — exactly the mcp-api fall-through scenario ("SHALL still
   carry a session binding after the call — the row this call resolved").
3. **No binding** → behaves as if step (1) were skipped: `routerKey()` returns `null`
   when `ctx.mcpSessionId` is absent (`_shared.ts:284–288`), which is the repro's
   `makeContext()` shape and every hook-driven client.
4. **Mint** → unchanged, including binding the mint via the end-of-handler re-pin.

**Do this, not that** (all three matter, they are the traps):

- **Do NOT resolve step (1) through `resolveSessionId`** (`_shared.ts:308–334`). It
  touches and returns the router hit with _no_ status/deleted/scope guard — reusing it
  would adopt a terminal or out-of-scope bound row and violates the mcp-api guard list.
  Load the row by id and validate explicitly, as sketched above.
- **Do NOT "fix" the same asymmetry in `resolveSessionId`/`resolveActiveSessionId`**
  (`_shared.ts:308–334`, `memory-tools.ts:667–698`). Their unguarded router read is
  published auto-attach behavior; no delta modifies it, and owner decision 3 pins
  auto-attach semantics. Leave them byte-for-byte untouched.
- **Do NOT clear or null the binding anywhere in this handler.**

Why the order is safe: a binding names an id — it is a pin, not a tiebreak, so the
`sessions` no-guess requirement is untouched by honoring it first. The delta says the
order is normative: binding → windowed lookup → sole-active → mint.

## Decision 2 — `findSoleActiveForReuse` (service + repository)

Two additions, one per layer (SQL stays under `db/` — data-access confinement).

**Repository** — `apps/server/src/db/repositories/agent-sessions-repository.ts`, placed
directly after `findActiveForTransport` (:150–170), mirroring its shape minus
staleness:

```ts
findSoleActiveForReuse(tokenId: string, projectId: string | null): AgentSession | undefined {
  const conditions = [
    eq(agentSessions.tokenId, tokenId),
    eq(agentSessions.status, 'active'),
    isNull(agentSessions.deletedAt),
    projectId === null ? isNull(agentSessions.projectId) : eq(agentSessions.projectId, projectId),
  ];
  // No ORDER BY: "sole match or nothing" makes it unobservable.
  const rows = this.db
    .select()
    .from(agentSessions)
    .where(and(...conditions))
    .limit(2)
    .all();
  return rows.length === 1 ? rows[0] : undefined;
}
```

- **No staleness predicate**: no `activeSinceMs` parameter, no comparison against
  `EFFECTIVE_LAST_ACTIVITY` (:73). A row idle for weeks that is still `active` and
  non-deleted is eligible.
- **`LIMIT 2` sole-or-nothing**, identical to `findActiveForTransport`: one row →
  return it; zero or ≥2 → `undefined`. Keep the `// No ORDER BY` comment (same
  rationale as :165).
- Comment: one sentence naming the caller (`memory.session_start` only) and pointing
  at the delta requirement — enough that a future reader does not "simplify" it into
  `findActiveForTransport`. That is the non-obvious invariant; nothing more.

**Service** — `apps/server/src/services/agent-sessions.ts`, directly after
`findActiveForTransport` (:574–588):

```ts
findSoleActiveForReuse(input: {
  tokenId: string;
  projectId: string | null;
}): AgentSession | null {
  return this.repos.agentSessions.findSoleActiveForReuse(
    input.tokenId,
    input.projectId,
  ) ?? null;
}
```

Same input shape and `| null` return convention as the service's
`findActiveForTransport` (:577–587) so the handler's `??` chain typechecks without
normalization. The service computes no clock — deliberately different from its
sibling, which derives `activeSinceMs` from `TRANSPORT_STALENESS_MS` (:43, :580).

**Why not folded into `findActiveForTransport`** (this is spec, not taste): the
sessions delta forbids it in so many words ("SHALL NOT be reached from, folded into,
or substituted for"), and folding would need an optional-staleness parameter whose
default silently widens rule 2 for every auto-attach caller — B-wide, rejected by
owner decision 3. Same for the softer variant (`findActiveForTransport(input,
{ includeStale?: boolean })`): a fold in different clothes. The delta names the exact
symbol `findSoleActiveForReuse` — do not rename.

## Decision 3 — D3 description clause and the pin re-measurement

**Exact edit**: append one sentence to `memory.session_start`'s description literal at
`apps/server/src/mcp/server.ts:313`, after "…so it reports whose session you are now
writing into.":

```text
 Once a session is active on this connection, do NOT call this again — memory.save, memory.confirm and memory.session_summary attach to it automatically.
```

Appending at the end is the minimal diff and keeps the `Returns:`/`agent` prose
contiguous; the existing first sentence ("In normal operation you do NOT need to call
this — the host registers the session automatically") stays where it is, so the two
don't-call clauses read as one instruction with two reasons, per the mcp-api scenario.
Do not reflow the rest of the description: the `names every field` test
(`mcp-integration.test.ts:853–865`) matches substrings and regexes against it.

**Pin re-measurement procedure** (the pin: `apps/server/src/test/mcp-integration.test.ts:793–802`,
the `it.each` whose `['memory.session_start', 818]` row is ≈:796; headroom assertion
in the same block):

1. Make the edit; do **not** touch the pin first.
2. Run `pnpm vitest run apps/server/src/test/mcp-integration.test.ts`. The length pin
   fails with `expected 818 to be <actual>` — `actual` is measured from a live
   `tools/list` (`beforeAll` connects a real MCP client, :782–790), never derived from
   the source constant. **Do not hand-count the new description** (em-dashes and the
   UTF-16 length make hand-counting wrong in both directions).
3. Update the `['memory.session_start', 818]` row to the measured value. Record the
   after-measurement and headroom in the PR description
   (before: 818/1900, 1082 headroom — that before-value is pinned verbatim in the
   mcp-api delta scenario and stays).
4. The headroom assertion (`DESCRIPTION_MAX_LENGTH - desc.length > 0`,
   `DESCRIPTION_MAX_LENGTH = 1900` at `server.ts:133`) must stay green. Expected new
   length ≈ 818 + ~150 ≈ 970 — ample. **The cap is not raised to fit**; if it ever
   ceases to fit, reword the clause shorter (delta-mandated).
5. Re-check the two adjacent pins: `:853–865` (required-field list + `reused:true
ADOPTED` + `agent MAY differ` regexes — unaffected, output schema unchanged) and
   `mcp-integration.test.ts:908` ("a second `memory.session_start` adopts the first
   session and says so" — must stay green).

## Decision 4 — D4′: the Pi extension declares its identity

File: `apps/plugin/.pi-plugin/index.ts` (Pi-only; no other client, no shared-core
change, no HTTP-lifecycle change). Today: the MCP handshake runs in the
`session_start` Pi-event handler (`initialize` + `listTools` + tool registration,
≈:388–447); the host row is created by `await core.ensureSession(sessionId)` inside
`before_agent_start` (≈:460), which POSTs `/api/<slug>/sessions` with
`tokenId: ctx.token.id` (`api-router.ts:141`) — the same bearer token the MCP client
authenticates with, so an id-targeted resume can never fail on ownership.

**Call ordering (do this)**:

1. Add one accessor to the `createMcpClient` return object:
   `sessionId(): string | null { return mcpSessionId; }` — the closure already updates
   `mcpSessionId` from every response header (`send()`, ≈:151–153), so this exposes
   the _current_ transport identity with no new state.
2. Per extension instance (inside `rembric()`), add:

   ```ts
   let boundKey: string | null = null; // `${mcpSessionId}::${hostId}` last successfully declared
   let bindFailures = 0;
   const BIND_FAILURE_LIMIT = 3;
   ```

3. In `before_agent_start`, immediately after `await core.ensureSession(sessionId)`
   and before the nudge/system-prompt assembly:

   ```ts
   const mcpSessionId = mcp?.sessionId() ?? null;
   const bindKey = mcpSessionId ? `${mcpSessionId}::${sessionId}` : null;
   if (mcp && bindKey && bindKey !== boundKey && bindFailures < BIND_FAILURE_LIMIT) {
     try {
       const r = await mcp.callTool('memory.session_resume', { sessionId });
       if (!r.isError) {
         boundKey = bindKey;
         bindFailures = 0;
       } else {
         bindFailures++;
         diag(`session_resume bind failed: ${r.text.slice(0, 120)}`);
       }
     } catch (err) {
       bindFailures++;
       diag(`session_resume bind failed: ${err instanceof Error ? err.message : 'error'}`);
     }
   }
   ```

Why this placement and shape:

- **After MCP discovery AND after the first successful `ensureSession`**: discovery
  completed before the first turn (the `session_start` handler awaited it);
  `ensureSession` is the first thing that guarantees the row exists. Calling from the
  `session_start` Pi-event handler instead would burn a guaranteed `not_found` (no
  ensure has run); calling from `agent_settled` would be too late (the model may call
  session tools mid-turn).
- **Once per `(transport, host)` pair**: `bindKey !== boundKey` gates it. The first
  turn declares; later turns are a string compare. **Re-issue after every MCP
  transport re-initialization** falls out of including `mcpSessionId` in the key: a
  server restart or re-handshake mints a new MCP session id, the key changes, the
  next `before_agent_start` re-declares on the new transport. This is why the
  accessor is needed — comparing only the host id would declare "once" per process
  and leave a re-initialised transport resolving by lookups.
- **`not_found` retry, bounded**: with ensure-first ordering, `not_found` should never
  fire; if the ensure POST races the declaration, the next turn retries. No
  error-kind sniffing (`code === 'session_not_found'`): any `isError` result and any
  thrown transport error count identically against `BIND_FAILURE_LIMIT = 3`
  consecutive failures, after which the extension stops trying until the transport
  re-keys. Without the cap, a permanent mismatch (wrong project, revoked token,
  server down) costs one failed MCP call per turn forever; the delta's
  "declaration that never succeeds" scenario must degrade, not drain. Sniffing adds
  JSON parsing for no behavioral difference.
- **Never `memory.session_start`**: the declaration is `memory.session_resume` only —
  the one verb that cannot mint (already-active resume is a published row no-op that
  still sets the binding, `session-tools.ts:330–337`). This is the AMENDMENT's core
  prohibition.
- **Failure semantics — all silent**: `diag()` to stderr only; no `ctx.ui.notify`, no
  model-visible error, no thrown rejection out of `before_agent_start` (the try/catch
  is load-bearing: `callTool`→`send` throws on non-2xx, and an escaping rejection
  would abort nudge injection for the turn). An un-declared transport behaves exactly
  as today.
- **Host uuid legality — no extra branch**: the row's id _is_ the host uuid (service
  `ensure` inserts `id: input.id`, `agent-sessions.ts:268–270`), so `session_resume`
  targets a real row whenever ensure succeeded. The degenerate cases reduce to
  failures the loop already handles: row missing → `session_not_found` (retry), slug
  changed mid-session → `session_not_found` (retry to cap, silent), empty uuid →
  zod `min(1)` `invalid_input` (capped, silent).
- **Shutdown unchanged**: `session_shutdown` (≈:505–521) keeps ending only the host
  row on closing reasons; `mcp.close()` untouched.

## Decision 5 — Test matrix

Every delta scenario maps to a named test. Existing green tests that pin unchanged
behavior are listed as controls.

**`apps/server/src/mcp/ghost-session-repro.test.ts`** — rewrite in place (keep the
filename: it anchors #377), flip the header comment from REPRODUCTION to REGRESSION,
and convert the three tests. `makeContext()` gains a variant with
`mcpSessionId: 'repro-transport'` so both context shapes are covered:

- _control_ (fresh unique row reused): keep as-is, must stay green.
- _weeks-long timeline, bound transport_: 89-min idle call → `reused: true`, R1
  adopted (inverts today's `expect(g1.reused).toBe(false)`); row count 1. Post-sweep
  Monday call → `reused: false` (owner decision: by-design mint, kept as the
  control). Post-resume with two live rows: first call mints **once** (spec-mandated),
  every later call on the bound transport `reused: true` with the bound id — row
  count stops growing (the snowball case). Final assertions: `agent='unknown'` ghost
  count 0 in the common path, ≤2 live rows for the logical conversation.
- _weeks-long timeline, binding-less_ (`mcpSessionId: null`): ghost #1 gone (sole
  active adopted); under two live rows still mints each call (no-guess control —
  proves B did not widen into E).
- _opencode cadence_: no declaration ever (client-blind), sole-active adoption at the
  89-min idle call (`reused: true`, row count 1); two live rows → mint (same control).

**`apps/server/src/mcp/session-tools.test.ts`** — extend the reuse describe (:79–121;
`makeContext()` there already carries `mcpSessionId` variants, e.g. :356):

- _sole-active adoption past the window_: one row, `last_activity_at`/`started_at`
  backdated >30 min (raw SQL pattern from `agent-sessions.test.ts:274–276`) →
  `reused: true`, same id, row count 1.
- _ambiguity still mints with two stale rows_: two backdated rows → `reused: false`
  (sole-or-nothing is not recency).
- _binding-first precedence_: two live rows (one stale, one fresh), transport bound
  to the stale row → `reused: true` + the bound id, row count unchanged.
- _binding established by `session_resume` answers step (1)_: pattern of :356–368
  (resume on a transport with a concurrent active row), then `session_start` →
  adopts the resumed row.
- _fall-through with the binding preserved_ (parameterize: bound row `ended` /
  `abandoned` / soft-deleted via `softDelete` / other-project via a second project /
  other-token row pinned under the caller's router key): response id ≠ bound id,
  AND after the call `router.get(...)?.rembricSessionId` is defined and equals the
  row the call resolved (the delta's "SHALL NOT have been cleared" — note the entry
  is _re-pointed_, not preserved-at-the-old-id; assert accordingly), plus the
  follow-up control that a `memory.save` on that transport still auto-attaches.

**Service/repository coverage** (mirror the existing `findActiveForTransport`
describes — `services/agent-sessions.test.ts:248–287`,
`db/repositories/agent-sessions-repository.test.ts`):

- sole returns the row when fresh; **returns the row when idle >30 min** (backdated);
  returns `null` with two rows — one older `started_at`, one more recent
  `last_activity_at` (never-recency); `null` with zero; `null` with three
  (LIMIT 2 boundary, repo-level); excludes soft-deleted; excludes ended/abandoned;
  scoped to `(tokenId, projectId)` (other token / other project not returned).
- _no-leak control_ (delta-mandated): on the stale-sole fixture,
  `findActiveForTransport` still returns `null`.

**`apps/server/src/mcp/memory-tools.test.ts`** — _a stale sole row is still not
adopted by an auto-attaching write_: one backdated active row, no router entry →
`memory.save` persists `session_id = NULL`.

**`apps/plugin/.pi-plugin/plugin.test.ts`** — real-server harness (`startedHarness`
:183–187, `harness.fire` :175–179, `callThroughExtension` :1229):

- _bind after ensure, and the binding answers session_start_: seed a second active
  row for the same project over HTTP first (so the sole-active lookup would refuse),
  `fire('before_agent_start')`, then drive the registered `memory.session_start`
  tool → `reused: true` with `sessionId === harness` host uuid, row count unchanged.
  Spy `fetch` to assert a `tools/call` body naming `memory.session_resume` with
  `{sessionId: <host uuid>}` was sent, and none naming `memory.session_start`.
- _silent retry_: stub the first `memory.session_resume` call with an MCP error body
  `{"ok":false,"code":"session_not_found",...}` (wire shape: `errors.ts:11–19`) →
  no throw, no error in `harness.notifications`; the next `before_agent_start`
  retries, binds, and `session_start` then adopts.
- _re-init re-declares_: stub one `/mcp/` response with a fresh `mcp-session-id`
  header (body passthrough) — `send()` re-keys the transport from headers (≈:151) —
  then `fire('before_agent_start')` again → a second `memory.session_resume` call
  goes out on the new transport.
- _silent degradation_: every `memory.session_resume` fails (stubbed error) →
  exactly `BIND_FAILURE_LIMIT` attempts across ≥4 turns, then none; no
  notifications, no throw; nudges still injected; shutdown flush still lands (the
  "degrades to today's behaviour" scenario).

**`apps/server/src/test/mcp-integration.test.ts`** — the re-measured length pin
(Decision 3) plus a new assertion in the `:853–865` describe:
`expect(desc).toMatch(/do NOT call this again/i)` and
`/attach automatically/`. `:908` (second call adopts) stays green untouched.

**Mutation check** (`node scripts/mutate.mjs --file … --spec … --mutation … --with …`
— a new guard is not covered until its test fails without it). Three conditions,
each with the tests that must red:

1. **Binding guards** — weaken the adoption condition in `session-tools.ts` (drop
   `status === 'active'`/`deletedAt === null`/token/project match; spec:
   `specs/mcp-api/spec.md`, fall-through scenario) → must red the fall-through
   parameterized tests in `session-tools.test.ts`.
2. **Sole-or-nothing** — make `findSoleActiveForReuse` return `rows[0]`
   unconditionally (or `limit(1)`; spec: `specs/sessions/spec.md`,
   "findSoleActiveForReuse is sole-or-nothing…") → must red the two-rows-never-recency
   service tests and the ambiguity-still-mints handler/repro tests.
3. **No-staleness** — reintroduce the `EFFECTIVE_LAST_ACTIVITY` window into
   `findSoleActiveForReuse` (spec: `specs/sessions/spec.md`, "applies no staleness
   predicate…") → must red the backdated-sole-adoption tests (service, handler,
   repro). The inverse mutation — _removing_ the window from
   `findActiveForTransport` — must red the existing no-leak control and the
   fix-audited-defects tests.

## Decision 6 — e2e plan (rembric-plugin-development skill; mandatory)

Isolated-rails variant, per the skill's §5b and the owner preference that a local
stack is not raised into an environment where a prod connection is configured:

1. **Isolation first.** Scratch `HOME` (`mktemp -d`) and a scratch workspace dir
   holding `.rembric` with `PROJECT_SLUG=demo`. Nothing in the operator's real
   `~` is read or written; no `pi install` — load the extension per-run from the repo
   tree. If the ambient shell carries a prod `REMBRIC_API_TOKEN`/URL, the scratch run
   overrides both with the local stack's values — the extension must never see a prod
   token during the walkthrough.
2. `pnpm run dev:docker:up`; wait for `[bootstrap] listening on`; capture the seeded
   `demo-writer` token from the seed banner.
3. Launch Pi in the scratch dir with the local URL/token. One conversation, ≥2 turns:
   turn 1 ends with a `memory.save` (model-driven or via a registered tool call).
4. **Bind → reuse → ghost-free assertions:**
   - After turn 1: exactly ONE `sessions` row (`agent='pi'`) for the token+project,
     and the saved memory carries that row's `session_id` (check via the dashboard
     `/sessions` + `/memories` pages or sqlite in the container). This is the D4′
     declaration proving itself: HTTP ensure created the row, the resume bound the
     transport, and the model's write attached by pin — not by lookup.
   - Turn 2 (any idle gap): row count still 1; no `agent='unknown'` row appears —
     `session_start` (if the model calls it) is answered by the binding, and writes
     attach automatically.
   - Optional discriminating leg: create a second active row for the same project via
     the HTTP API before turn 2 — writes still land on the bound row, which neither
     lookup could have resolved.
5. **What is NOT covered locally** (say so in the PR): the published `@rembric/pi`
   npm artifact (walkthrough runs the repo tree; release-please publishes after
   merge); the real 30-min staleness boundary and the 24 h abandonment sweep (both
   fake-clocked in unit tests); multi-week timelines; the other four clients
   (untouched — but the unified `plugin` version bumps for all five, so the release
   note must say Pi-only behaviour changed).
6. **Teardown**: `docker compose down`, scratch HOME/workspace deleted, no
   uninstall needed (per-run load), nothing to restore.

## Decision 7 — Rollback (per piece; nothing persisted depends on the new behavior)

- **Handler order** (`session-tools.ts`): revert the block to :178–206 shape. No
  migration, no column, no derived-data invalidation. `reused`/`sessionId`/`agent`
  keep their published meaning on both sides, so no caller can observe a half-applied
  rollback. Rows already adopted stay as they are (append-only; no repair verb —
  owner decision 4); rollback simply returns to minting on stale-lookup misses.
- **New lookup** (service + repo methods): pure additions with exactly one caller;
  delete both in the same revert (the handler revert without them reds typecheck —
  which is the intended atomicity). No other caller exists and the delta forbids
  future folding, so deletion cannot break anything.
- **Description string**: restore the 818-char literal and re-run the pin — the
  `it.each` enforces the exact measured length, so a partial rollback (clause
  half-removed) fails the build instead of shipping a mangled description.
- **Pi binding call** (`index.ts`): revert the extension. The server-side pieces do
  not depend on any client declaring: steps (2)/(3) remain the whole story for
  undeclared transports. D4′ persists nothing — the already-active resume writes no
  row column (published idempotency), and the binding is in-memory. An un-upgraded
  published client is behaviorally identical to a reverted one.
- **Spec deltas**: pre-archive, revert the delta files (canonical specs are untouched
  until archive). Post-archive rollback is a new OpenSpec change, not a revert.

## File-change inventory

| File                                                                             | Change                                                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `apps/server/src/mcp/session-tools.ts`                                           | binding-first block (:178–206 rewrite); unchanged: sweep, re-pin, response |
| `apps/server/src/services/agent-sessions.ts`                                     | add `findSoleActiveForReuse` (after :588)                                  |
| `apps/server/src/db/repositories/agent-sessions-repository.ts`                   | add `findSoleActiveForReuse` (after :170)                                  |
| `apps/server/src/mcp/server.ts`                                                  | one sentence in the `session_start` description (:313)                     |
| `apps/plugin/.pi-plugin/index.ts`                                                | `sessionId()` accessor; bind state + declaration in `before_agent_start`   |
| `apps/server/src/mcp/ghost-session-repro.test.ts`                                | convert to regression coverage, both context shapes                        |
| `apps/server/src/mcp/session-tools.test.ts`                                      | adoption/fall-through/binding tests                                        |
| `apps/server/src/services/agent-sessions.test.ts`                                | sole-active describe                                                       |
| `apps/server/src/db/repositories/agent-sessions-repository.test.ts`              | sole-active repo tests                                                     |
| `apps/server/src/mcp/memory-tools.test.ts`                                       | auto-attach non-adoption control                                           |
| `apps/plugin/.pi-plugin/plugin.test.ts`                                          | bind/retry/re-init/degradation tests                                       |
| `apps/server/src/test/mcp-integration.test.ts`                                   | re-measured length pin; clause assertions                                  |
| `apps/plugin/.pi-plugin/README.md`, `apps/plugin/CHANGELOG.md`, `docs/agents.md` | docs sweep: identity declaration + unified plugin version                  |

Constraints honored: TS strict (no `any`; the handler's `AgentSession | null` is the
schema-derived type), no floating promises (the Pi declaration is awaited inside the
async handler with a try/catch), SQL only under `db/`, services own no transaction
here (single SELECT, none needed), comments only where they document a non-obvious
invariant.
