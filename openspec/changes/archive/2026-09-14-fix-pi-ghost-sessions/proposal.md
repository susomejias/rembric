# Proposal: fix-pi-ghost-sessions

Issue: #377 — one long-lived Pi conversation accumulates many `sessions` rows.
Exploration: `openspec/changes/fix-pi-ghost-sessions/explore.md` (validated map,
A–E matrix). Gate: `openspec/changes/fix-pi-ghost-sessions/preproposal.md` —
RESOLVED by the owner on 2026-09-13, second gate round included. Approach
**C = A + B-narrow + D3 + D4′** — the AMENDMENT brings D4′ in scope, so the Pi
extension declares its own session identity on its MCP transport.

## Why

The mechanism is validated by execution, not reading:
`apps/server/src/mcp/ghost-session-repro.test.ts` (2 green tests — a control plus
a weeks-long timeline) reproduces the issue's exact row shape. The chain, in the
handler today:

1. `memory.session_start` reuses an existing row only through
   `findActiveForTransport` (`apps/server/src/mcp/session-tools.ts:184`), which
   returns the sole `status='active'` row for `(tokenId, projectId)` **whose
   effective last activity is inside `TRANSPORT_STALENESS_MS` = 30 min**
   (`apps/server/src/services/agent-sessions.ts:43`, lookup at `:574-586`;
   repository `LIMIT 2`, sole-or-nothing —
   `apps/server/src/db/repositories/agent-sessions-repository.ts:150-170`).
2. Any idle gap over 30 min — a long agentic turn, a user stepping away, no
   plugin touch in between — makes the plugin's own row invisible to that
   lookup, so the next model-initiated `session_start` mints a fresh ULID row
   with `agent: args.agent ?? 'unknown'` (`session-tools.ts:201`) while the
   plugin's `agent='pi'` row is still `active`. That is ghost #1: overlapping
   lifetimes, and the row is permanently labelled `unknown` because
   `sessions.agent` is immutable.
3. With two live rows the lookup is ambiguous, returns `null`, and the mint
   happens on **every** later call (repro: 5 calls → 5 extra rows). Refusing to
   guess is correct and spec-mandated; minting is what it forces here.
4. The Pi plugin's shutdown `/end` covers only its own host-uuid row, so ghosts
   stay `active` until the 24 h `abandonStale` sweep flips them — which is why
   the issue reports every extra row as `abandoned`.
5. Once several rows are live, auto-attach
   (`resolveSessionId`, `apps/server/src/mcp/_shared.ts:316-334`;
   `resolveActiveSessionId`, `apps/server/src/mcp/memory-tools.ts:667-695`)
   resolves to nothing, so titles/summaries fragment across rows.

The user-visible cost: one workstream reported as three unrelated sessions with
different partial titles and summaries, no way to tell which is "the"
conversation, and `agent='unknown'` rows that no client owns and no lifecycle
call will ever end. The mechanism is client-agnostic (any transport whose model
calls `memory.session_start` after an idle gap hits it); #377 is where it shows
because Pi conversations run for weeks. That claim is now measured rather than
asserted: `apps/server/src/mcp/ghost-session-repro.test.ts` reproduces the same ghost
shape on the **opencode** cadence (third test — `ensure` once per process, `/turn`
touched only at turn end, model `session_start` at the next turn start after an
idle gap). Which is why the server-side pieces (A / B-narrow / D3) are written
client-blind and cover every client, while the **identity declaration is per-client**:
Pi declares in this change, opencode in a follow-up.

## What Changes

Four pieces: three inside the MCP `session_start` path and one in the Pi extension.
Nothing else in the session surface changes shape.

- **A — router-binding-first reuse in `handleSessionStart`.** Consult
  `deps.router.get(tokenId, mcpSessionId)?.rembricSessionId` **before** the
  fresh lookup. When the bound row exists, is `status='active'`, is not
  soft-deleted, and matches the resolved `(ctx.token.id, projectId)`, reuse it
  and `touchActivity` — an explicit pin, not a guess. Otherwise fall through
  **without** clearing the binding (`clearSession` stays `session_end`-only;
  clearing would drop every later `memory.save` on that transport to
  `session_id = NULL`). This is what stops the snowball: `resolveSessionId`
  already reads the binding first for end/summary/save, so `start` becomes
  consistent with the rest of the surface. It cannot prevent ghost #1 — the
  binding only exists after a prior `session_start`/`session_resume` on that
  transport, and the HTTP plugin path binds nothing.
- **B-narrow — sole-active reuse regardless of staleness, for `session_start`
  only.** A NEW service lookup (`findSoleActiveForReuse`) backed by a new
  repository query: same `(tokenId, projectId)` + `status='active'` +
  `deleted_at IS NULL` + sole-or-nothing `LIMIT 2`, but with **no** staleness
  predicate. `handleSessionStart` calls it only when the fresh lookup returned
  `null`, and reuses + touches when exactly one row exists. This removes ghost
  #1 and matches the branch's documented intent ("if a session is already active
  for this scope … return that one", `session-tools.ts:178-183`), which today is
  subject to a freshness accident. `findActiveForTransport` and every
  auto-attach caller stay byte-for-byte untouched — B-wide was rejected.
- **D3 — one tool-description clause.** `memory.session_start`'s description
  already says "In normal operation you do NOT need to call this"
  (`apps/server/src/mcp/server.ts:313`); extend it: once a session is active on
  this connection, do not call `session_start` again — writes attach
  automatically. Cheapest possible reduction in call volume, and it must be
  re-measured against the description-length pin (see Risks).
- **D4′ — the Pi extension declares its own session identity.** Once the MCP
  handshake is up and the plugin's HTTP `ensure` has created the row, the extension
  calls `memory.session_resume(<host session id>)` on its own transport, and
  re-declares it whenever that transport re-initialises. The call is id-targeted — an
  explicit id, never a lookup — so for Pi the order below is short-circuited at step
  (1) from the first turn: neither the staleness window nor the sole-active fallback
  is ever consulted on a Pi transport. That closes the mixed-fresh stomp (session X
  resumes while session Y's row is still fresh) at the root rather than mitigating it,
  and it is what the owner requires to run several parallel sessions in one project
  with a hard guarantee that a memory lands on the right row. The call tolerates
  `not_found` while the row does not exist yet (retry after the `ensure`) and never
  uses `memory.session_start`, the one MCP path that can mint under ambiguity.

Effective resolution order in `handleSessionStart` after this change: binding (for Pi,
established by D4′ before the model's first call) → fresh-unique (today's path,
unchanged) → sole-active-any-staleness → mint.

## Explicitly unchanged (owner decisions, do not re-litigate at apply)

1. **No-guess refusal under ≥ 2 live rows is kept.** `sessions/spec.md:832`
   rule 3 and the scenario `:868` "memory.session_start mints a fresh session
   instead of reusing an ambiguous one" remain in force. Provenance-based
   adoption of the out-of-band row (approach E) was rejected. The residual is
   accepted: the first call at a genuine ambiguity onset still mints, now at
   most once per transport, after which A binds it.
2. **B-narrow, not B-wide.** `memory.save`/`memory.confirm`/`capture_passive`
   auto-attach semantics are untouched; the `session_id = NULL` fragmentation is
   fixed only indirectly (no second row → no ambiguity).
3. **Post-sweep mint is by-design.** Zero `active` rows after the 24 h
   abandonment sweep → `session_start` mints. No "idle < abandon window should
   reuse" work; no change to the sweep, `SESSION_ABANDON_AFTER_MS`, or
   `purgeEmpty`.
4. **No repair of existing ghosts.** `agent` is immutable and append-only
   forbids an UPDATE; operators retire stray rows from the dashboard. No
   migration, no backfill.
5. **Identity declaration is Pi-only in this change.** The opencode plugin does not
   declare its identity over MCP: its model-facing transport is the external
   `@rembric/mcp-bridge` process, which carries no host session id, so there is
   nothing to bind without a protocol change. Named follow-up, not an oversight —
   opencode is covered by the server-side pieces, which is exactly what its
   reproduction test asserts.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

The delta specs are the load-bearing deliverable of this change — the behaviour
is three guarded lines plus one plugin-side call, and the contract is where the work
is.

- `sessions` — MODIFIED "`findActiveForTransport` MUST NOT guess under
  concurrent ambiguity" (`openspec/specs/sessions/spec.md:832`). Rules 1–3 stay
  as published for the method itself and for every auto-attach caller. The
  carve-out is on the _caller_: `memory.session_start`'s reuse precondition
  becomes "an unambiguous **active** candidate", i.e. it may adopt the sole
  active row without the staleness window, via the separate reuse lookup;
  two-or-more still falls through to a mint. The recency-tiebreak prohibition is
  restated as applying to both paths (sole-or-nothing, never an arbitrary pick).
- `sessions` — MODIFIED "Session rows MUST record last activity, and
  stale-active retirement MUST be periodic" (`:874`, staleness sentence `:878`).
  That sentence is scoped to transport-based resolution / auto-attach, with the
  `session_start` sole-active carve-out named as the one place where a
  stale-but-active row may legitimately be adopted. Scenarios "A killed client
  no longer blocks auto-attach" (`:880`) and "Two genuinely-concurrent sessions
  still refuse to guess" (`:886`) are preserved unchanged.
- `mcp-api` — MODIFIED "The MCP server MUST expose four session-lifecycle
  tools" (`openspec/specs/mcp-api/spec.md:2803`). Adds binding-first precedence
  for `memory.session_start` (reuse the transport's `SessionRouter` session when
  it is still `active`, not soft-deleted, and in the resolved scope; fall
  through without clearing the binding otherwise), states that both reuse paths
  report `reused: true` with the same `sessionId`, records the zero-fresh-rows
  sole-active fallback, and extends the description requirement with the
  "once a session is active on this connection, do not call `session_start`
  again" clause. It also names that the transport binding may have been set by a
  `memory.session_resume` rather than by a previous `memory.session_start` — which
  is the only way a Pi transport ever gets one — and cites the published
  `memory.session_resume` idempotency on an already-`active` row (canonical
  `mcp-api/spec.md:2813`, `:2819`, scenario `:2961`) rather than re-litigating it,
  adding only the scenario that pins the extension's start-up bind call. Existing
  scenarios (second call adopts the first; resume pins; `session_summary`
  resolution order) are otherwise unchanged.
- `pi-plugin` — ADDED "The Pi extension SHALL declare its session identity on the MCP
  transport": the binding call, its ordering behind the first `ensure`, its
  re-declaration on transport re-init, its `not_found` tolerance, and the prohibition
  on using `memory.session_start` to do it.

No delta to `plugin-session-protocol`: the HTTP lifecycle is untouched. D4′ is
additive on the MCP channel and leaves the existing ensure / `/resume` / `/end`
behaviour — including the single `/resume` after the first `/sessions` ensure that
`pi-plugin` already mandates — exactly as published. D4 (`session_start` once per
process) stays rejected: a call that can mint under ambiguity is the wrong tool for
declaring an identity.

## Affected areas

- `apps/server/src/mcp/session-tools.ts` — `handleSessionStart` resolution
  order (binding check, then the sole-active fallback). Handler-level only.
- `apps/server/src/services/agent-sessions.ts` — new `findSoleActiveForReuse`
  service lookup; `findActiveForTransport` untouched.
- `apps/server/src/db/repositories/agent-sessions-repository.ts` — new
  sole-active query (no staleness predicate, `LIMIT 2` sole-or-nothing). SQL
  stays under `db/` per the data-access confinement invariant.
- `apps/server/src/mcp/server.ts` — `memory.session_start` description clause.
- Tests: `apps/server/src/mcp/ghost-session-repro.test.ts` is converted into
  regression coverage (then deleted or rewritten as the regression file) for
  **both** context shapes — a bound `mcpSessionId` and the binding-less
  `mcpSessionId: null` the current repro uses; `session-tools.test.ts`;
  `agent-sessions` service/repository coverage for the new lookup;
  `apps/server/src/test/mcp-integration.test.ts` pins.
- `apps/plugin/.pi-plugin/index.ts` — declare the binding over MCP: call
  `memory.session_resume(<host session id>)` after `initialize` + tool discovery and
  after the first `ensure`, retry while the row reports `not_found`, re-declare on
  every transport re-init. The HTTP lifecycle is NOT changed (`ensure` / `/resume` /
  `/end` stay as they are) and the shared core is not touched — this is Pi-only, so no
  other client's code moves.
- `apps/plugin/.pi-plugin/README.md`, `apps/plugin/CHANGELOG.md`, `docs/agents.md`
  (its Pi section documents session lifecycle today, so the new MCP call belongs
  there) — docs sweep for the identity declaration and the unified plugin version it
  ships in.
- Untouched: `apps/plugin/` beyond `.pi-plugin/` (Claude Code, Codex, Hermes,
  opencode, the shared core, the MCP bridge), `api-router.ts`, the
  consolidation sweep and abandonment windows, dashboard, schema/migrations.
  No new MCP tool, no scope-resolution change, no load-bearing invariant
  violated (append-only, scope-at-service-layer, `topic_key` convergence,
  derived review state, SQL confinement).

## Testing shape

Regression tests convert the reproduction into asserted behaviour rather than
keeping a diagnostic file:

- > 30 min idle with one live plugin row → `session_start` reuses it,
  > `reused: true`, row count unchanged (this is the assertion that inverts today's
  > `expect(g1.reused).toBe(false)`).
- Two live rows, bound transport → the first call may mint, every later call on
  that transport reuses the bound row (row count stops growing) — the snowball
  case.
- Two live rows, no binding → still mints: the spec-mandated control that B did
  not widen into E.
- Bound row is `ended`/`abandoned`/soft-deleted/out-of-scope → falls through and
  the binding survives (assert on the router entry after the call).
- Existing green tests that MUST stay green: `session-tools.test.ts:80` "reuses
  the sole existing active session for the pair", `:89` "mints a fresh session
  instead of adopting one of two ambiguous active sessions", the repro's control
  ("fresh unique active row is reused"), and `mcp-api`'s "A second
  `memory.session_start` adopts the first session and says so".
- New guards are mutation-checked with `node scripts/mutate.mjs` — each of the
  three conditions (binding alive-and-in-scope check, sole-or-nothing, no
  staleness predicate) must red the tests that name it.
- Plugin-side (`.pi-plugin/plugin.test.ts`): a start with the row present issues
  `memory.session_resume` carrying the host uuid and never `memory.session_start`; a
  `not_found` before the row exists is retried after the `ensure` and surfaces nothing
  to the model; a transport re-init re-declares the binding; a bind that fails leaves
  the extension behaving as it does today.
- The opencode-cadence reproduction becomes a regression case: a client that declares
  nothing, with two live rows, still exercises the sole-active and ambiguity paths —
  which is the proof the server fix is client-blind rather than Pi-shaped.
- Non-test gate: the `rembric-plugin-development` e2e walkthrough against
  `pnpm run dev:docker:up` is mandatory; no plugin change ships on unit tests alone.

## Success criteria

- The converted regression suite passes with the timeline's ghost count at zero
  in the common path, and ≤ 2 live rows (plugin row + at most one bound MCP row)
  for one logical conversation, versus unbounded today.
- `pnpm test`, `pnpm run typecheck`, `pnpm run lint`, `openspec validate
--strict`, `pnpm run check:spec-provenance`, `pnpm run check:delta-freshness`
  all green.
- The published `sessions` no-guess requirement still refuses under ≥ 2 live
  rows in both code and spec text — provable by a test that fails if rule 3 is
  widened.
- The plugin change ships through the unified `plugin` release track (one version
  shared by all five clients, `@rembric/pi` published from that release), and the
  change is validated e2e per the `rembric-plugin-development` skill — the
  `pnpm run dev:docker:up` walkthrough showing one Pi conversation keeping one row,
  bound from the first turn. The server-only criteria above are unchanged by the
  plugin piece.

## Risks

- **Plugin release coordinate (new with D4′).** A Pi-only fix bumps the single
  `plugin` version for all five clients — repo policy, not a flaw here — so the
  release note must say plainly that only Pi behaviour changed, and the mandatory e2e
  is what stands between a Pi-only bugfix and a five-client regression. Because the
  published `@rembric/pi` carries the fix, an un-upgraded client keeps today's
  behaviour: A / B-narrow / D3 must (and do) hold without any client declaring its
  identity, which is what the opencode test pins.
- **Spec-drift risk (highest).** This is a behaviour change against a
  load-bearing no-guess requirement. A delta that phrases the carve-out loosely
  would silently license "adopt something" under ambiguity, which is precisely
  the outcome the requirement exists to prevent. Mitigation: the deltas keep
  rules 1–3 verbatim for `findActiveForTransport` itself and scope the carve-out
  to the named caller + named new lookup; scenario `:868` is carried unchanged.
- **Zombie adoption (accepted).** A killed client's sole active row can now be
  adopted by a new conversation whose plugin `ensure`/`resume` failed. Cost is a
  mislabelled lineage on a row (no data corruption, no cross-scope leak, and
  `reused: true` plus the existing `agent` field reports it). Owner decision 1
  accepts this against the alternative — the defect being fixed.
- **Pin regression.** `mcp-integration.test.ts:795` pins
  `memory.session_start`'s description at 818 chars (measured from the live
  `tools/list` response) and `:859+` pins its required-field list; both belong
  to `expose-session-start-agent`. Any description edit must re-measure the
  length rather than hand-tune it. 1082 chars of headroom under
  `DESCRIPTION_MAX_LENGTH = 1900`, so the clause fits without reclaiming prose.
- **A alone would overpromise.** The binding is in-memory and per-transport: it
  is lost on server restart and a `pi -r` process gets a new MCP session id, so
  A does not prevent ghost #1. Ship A and B together; do not sell A as the fix.
- **Stickiness.** Binding-first makes a wrong binding stickier (every later call
  reuses it). Bounded by the status/scope/soft-delete guard and by
  `session_end` remaining the only writer of `clearSession`.

## Rollback

Revert the handler ordering in `handleSessionStart`, delete the new service and
repository lookup, restore the description string. Nothing is persisted by this
change — no column, no migration, no derived-data invalidation, no state a later
version depends on — and `reused`/`sessionId` keep their published meaning, so no
caller can observe a half-applied rollback. Rows minted by an earlier version
stay as they are (append-only); the rollback simply returns to minting on
stale-lookup misses. D4′ is likewise unpersisted: reverting
`apps/plugin/.pi-plugin/index.ts` simply stops the declaration, and the server-side
pieces keep working unchanged for a client that declares nothing. Reverting the spec
deltas returns to the published text.

## Sequencing dependency (mandatory pre-apply check)

`openspec/changes/expose-session-start-agent/` is implemented (35/35 tasks) but
**unarchived**, and it owns the same `memory.session_start` description and the
same `mcp-integration.test.ts` pins this change must re-measure. This change
applies **after** that one is archived:

1. Before any code edit, confirm the archive state — the directory must appear
   under `openspec/changes/archive/`, not `openspec/changes/`, and
   `openspec/specs/mcp-api/spec.md` must already carry its `agent` field.
2. If it is still active, stop; rebase after its archive, or ask the owner to
   archive it first.
3. All description text, line citations and pin values in this proposal were
   taken from a tree where that change is applied; re-read
   `apps/server/src/mcp/server.ts` and the test before writing code.
4. Four active changes now carry an `mcp-api` delta
   (`expose-session-start-agent`, `expose-session-write-verdict`,
   `proactive-entity-recall`, this one). Coordinate the archive order and re-run
   `pnpm run check:delta-freshness` and `pnpm run check:delta-sections` after each
   archive, because a requirement copied into a delta must still match the canonical
   text it replaces. `pi-plugin` is touched by no other active change.
